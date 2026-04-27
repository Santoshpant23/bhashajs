/**
 * Translation Editor Page
 *
 * The core of BhashaJS — a spreadsheet-like editor for managing
 * translation key-value pairs across multiple languages.
 *
 * Features:
 * - Inline editing with auto-save on blur
 * - Search/filter across keys and values
 * - Missing translation indicators
 * - AI-powered translation via Gemini
 * - Per-language and combined JSON export
 * - Bulk import via API
 * - Preview panel with correct fonts per script
 * - Completion stats per language
 * - Unsaved changes warning on navigation
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api, { getErrorMessage } from "../utils/api";
import {
  ArrowLeft,
  Plus,
  Save,
  Trash2,
  Search,
  AlertCircle,
  Download,
  Upload,
  X,
  Eye,
  BarChart3,
  Sparkles,
  Check,
  XCircle,
  Clock,
  Activity,
  Bell,
  MessageSquare,
  Send,
  BookOpen,
} from "lucide-react";
import { useNotifications } from "../context/NotificationContext";

// Three registers, mirroring the server. Add new ones in lockstep here.
type Register = "default" | "formal" | "casual";
const REGISTERS: Register[] = ["default", "formal", "casual"];
const REGISTER_LABELS: Record<Register, string> = {
  default: "Default",
  formal: "Formal",
  casual: "Casual",
};
const REGISTER_HINTS: Record<Register, string> = {
  default: "Neutral conversational tone",
  formal: "Honorific, native-vocabulary — for legal / banking / gov UI",
  casual: "Gen-Z friendly, code-mixing with English encouraged",
};

interface Translation {
  _id: string;
  key: string;
  // Nested by (lang → register → string). Server returns the full nested map;
  // the editor reads the slice for the currently active register.
  translations: Record<string, Record<string, string>>;
  context?: string;
  source: string;
  sources?: Record<string, Record<string, string>>; // per (lang, register): "human" | "ai" | "approved"
}

/** Read a (lang, register) cell, with default-register fallback so a partially
 *  localized casual register still shows something useful in the UI. */
function valueAt(t: Translation, lang: string, register: Register): string {
  const langMap = t.translations?.[lang];
  if (!langMap) return "";
  return langMap[register] || langMap.default || "";
}

/** Read the source provenance for a (lang, register) cell. */
function sourceAt(t: Translation, lang: string, register: Register): string | undefined {
  const langMap = t.sources?.[lang];
  if (!langMap) return undefined;
  return langMap[register] || langMap.default;
}

/** Write a (lang, register) cell on a Translation in local state. */
function withValue(
  t: Translation,
  lang: string,
  register: Register,
  value: string
): Translation {
  const next = { ...t, translations: { ...t.translations } };
  next.translations[lang] = { ...(next.translations[lang] || {}), [register]: value };
  return next;
}

interface Project {
  _id: string;
  name: string;
  supportedLanguages: string[];
  defaultLanguage: string;
  myRole?: string; // "owner" | "translator" | "viewer"
}

interface GlossaryEntry {
  _id: string;
  term: string;
  translations: Record<string, string>;
  notes: string;
}

interface CommentData {
  _id: string;
  translationId: string;
  lang: string | null;
  content: string;
  userId: { _id: string; name: string; email: string };
  createdAt: string;
}

interface LangStats {
  translated: number;
  total: number;
  percentage: number;
  sources?: { human: number; ai: number; approved: number };
}

interface HistoryEntry {
  _id: string;
  lang: string;
  register?: Register;
  key: string;
  oldValue: string;
  newValue: string;
  source: string;
  changedBy: { _id: string; name: string };
  createdAt: string;
}

// Language display names — all 13 South Asian languages + English
const LANG_NAMES: Record<string, string> = {
  en: "English",
  hi: "हिन्दी",
  bn: "বাংলা",
  ur: "اردو",
  ta: "தமிழ்",
  te: "తెలుగు",
  mr: "मराठी",
  ne: "नेपाली",
  pa: "ਪੰਜਾਬੀ",
  "pa-PK": "پنجابی",
  gu: "ગુજરાતી",
  kn: "ಕನ್ನಡ",
  ml: "മലയാളം",
  si: "සිංහල",
};

// Google Fonts for each script — used in preview panel
const LANG_FONTS: Record<string, string> = {
  hi: "'Noto Sans Devanagari', sans-serif",
  bn: "'Noto Sans Bengali', sans-serif",
  ur: "'Noto Nastaliq Urdu', serif",
  ta: "'Noto Sans Tamil', sans-serif",
  te: "'Noto Sans Telugu', sans-serif",
  mr: "'Noto Sans Devanagari', sans-serif",
  ne: "'Noto Sans Devanagari', sans-serif",
  pa: "'Noto Sans Gurmukhi', sans-serif",
  "pa-PK": "'Noto Nastaliq Urdu', serif",
  gu: "'Noto Sans Gujarati', sans-serif",
  kn: "'Noto Sans Kannada', sans-serif",
  ml: "'Noto Sans Malayalam', sans-serif",
  si: "'Noto Sans Sinhala', sans-serif",
  en: "'DM Sans', sans-serif",
};

// RTL languages
const RTL_LANGS = new Set(["ur", "pa-PK"]);

export default function TranslationEditor() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  // Core state
  const [project, setProject] = useState<Project | null>(null);
  const [translations, setTranslations] = useState<Translation[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  // Active register — drives which (lang, register) slice the editor reads
  // and which cell edits/AI runs target. Persisted to localStorage so a
  // translator who lives in "casual" mode doesn't have to reset it every visit.
  const [currentRegister, setCurrentRegister] = useState<Register>(() => {
    const saved = typeof window !== "undefined"
      ? (window.localStorage.getItem("bhashajs_register") as Register | null)
      : null;
    return saved && REGISTERS.includes(saved) ? saved : "default";
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("bhashajs_register", currentRegister);
    } catch { /* localStorage may be blocked — non-critical */ }
  }, [currentRegister]);

  // Filters
  type StatusFilter = "all" | "untranslated" | "ai-pending" | "approved";
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [langFilter, setLangFilter] = useState<string>("all");

  // Pagination
  interface PaginationInfo { page: number; limit: number; total: number; totalPages: number; }
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Track unsaved changes
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const unsavedRef = useRef(false);
  const lastEditedLangRef = useRef<string | undefined>(undefined);

  // Add key modal
  const [showAddKey, setShowAddKey] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newContext, setNewContext] = useState("");

  // Import modal
  const [showImport, setShowImport] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importLang, setImportLang] = useState("en");
  const [importing, setImporting] = useState(false);

  // Export dropdown
  const [showExport, setShowExport] = useState(false);

  // Preview panel
  const [showPreview, setShowPreview] = useState(false);
  const [previewKey, setPreviewKey] = useState("");

  // Stats
  const [stats, setStats] = useState<Record<string, LangStats> | null>(null);

  // AI Translation modal
  const [showAIModal, setShowAIModal] = useState(false);
  const [aiTargetLang, setAITargetLang] = useState("");
  const [aiTranslating, setAITranslating] = useState(false);
  const [aiResult, setAIResult] = useState<string | null>(null);

  // Notifications
  const { unreadCount, notifications, markRead, markAllRead } = useNotifications();
  const [showNotifications, setShowNotifications] = useState(false);

  // Analytics panel
  const [showAnalytics, setShowAnalytics] = useState(false);

  // Toast notifications
  interface Toast { id: number; message: string; type: "success" | "error" | "info"; }
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastCounter = useRef(0);
  function showToast(message: string, type: Toast["type"] = "success") {
    const id = ++toastCounter.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }

  // Keyboard shortcuts
  const originalValueRef = useRef<Record<string, string>>({});
  const [cellFocused, setCellFocused] = useState(false);

  // History
  const [showActivity, setShowActivity] = useState(false);
  const [recentHistory, setRecentHistory] = useState<HistoryEntry[]>([]);
  const [cellHistory, setCellHistory] = useState<HistoryEntry[]>([]);
  const [historyPopover, setHistoryPopover] = useState<{
    translationId: string;
    lang: string;
  } | null>(null);

  // Comments
  const [expandedComments, setExpandedComments] = useState<string | null>(null);
  const [comments, setComments] = useState<CommentData[]>([]);
  const [commentText, setCommentText] = useState("");
  const [commentLang, setCommentLang] = useState<string>("");
  const [postingComment, setPostingComment] = useState(false);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});

  // Glossary
  const [showGlossary, setShowGlossary] = useState(false);
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  const [newTerm, setNewTerm] = useState("");
  const [newTermNotes, setNewTermNotes] = useState("");
  const [editingGlossaryId, setEditingGlossaryId] = useState<string | null>(null);

  // Bulk AI translate & review queue
  const [batchTranslating, setBatchTranslating] = useState(false);
  const [batchLang, setBatchLang] = useState("");
  const [batchProgress, setBatchProgress] = useState("");
  const [reviewQueueMode, setReviewQueueMode] = useState(false);

  // ─── Data Fetching ───────────────────────────────────────────
  useEffect(() => {
    fetchProject();
    fetchTranslations();
    fetchStats();
    fetchGlossary();
  }, [projectId]);

  // Warn user before leaving with unsaved changes
  useEffect(() => {
    unsavedRef.current = hasUnsaved;
  }, [hasUnsaved]);

  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (unsavedRef.current) {
        e.preventDefault();
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  async function fetchProject() {
    try {
      const res = await api.get(`/projects/${projectId}`);
      setProject(res.data.data);
    } catch (e) {
      console.error("Failed to fetch project:", getErrorMessage(e));
    }
  }

  async function fetchTranslations(pageNum = 1, append = false) {
    try {
      const params = new URLSearchParams({
        page: String(pageNum),
        limit: "50",
      });
      if (searchQuery) params.set("search", searchQuery);
      const res = await api.get(`/translations/${projectId}?${params}`);
      const { data: items, pagination: pag } = res.data.data;
      if (append) {
        setTranslations((prev) => [...prev, ...items]);
      } else {
        setTranslations(items);
      }
      setPagination(pag);
    } catch (e) {
      console.error("Failed to fetch translations:", getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  async function fetchStats() {
    try {
      const res = await api.get(`/translations/${projectId}/stats`);
      setStats(res.data.data.languages);
    } catch (e) {
      // Stats are non-critical, silently fail
    }
  }

  // ─── Translation CRUD ────────────────────────────────────────

  async function addKey() {
    if (!newKey.trim()) return;
    try {
      await api.post(`/translations/${projectId}`, {
        key: newKey.trim(),
        translations: {},
        context: newContext.trim() || undefined,
      });
      setNewKey("");
      setNewContext("");
      setShowAddKey(false);
      fetchTranslations();
      fetchStats();
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    }
  }

  // Update local state when user types in a cell — only the active register's
  // cell is modified, never disturbing other registers.
  function handleValueChange(translationId: string, lang: string, value: string) {
    setHasUnsaved(true);
    lastEditedLangRef.current = lang;
    setTranslations((prev) =>
      prev.map((t) => (t._id === translationId ? withValue(t, lang, currentRegister, value) : t))
    );
  }

  // Save to server when user clicks out of a cell (onBlur). The server only
  // touches the (editedLang, editedRegister) cell, so we send just that pair.
  async function saveTranslation(translation: Translation, editedLang?: string) {
    setSaving(translation._id);
    try {
      await api.put(`/translations/${translation._id}`, {
        translations: translation.translations,
        context: translation.context,
        source: "human",
        editedLang,
        editedRegister: currentRegister,
      });
      // Update local state to reflect the per-(lang, register) source change
      setTranslations((prev) =>
        prev.map((t) => {
          if (t._id !== translation._id) return t;
          const updatedSources = { ...(t.sources || {}) };
          if (editedLang) {
            updatedSources[editedLang] = {
              ...(updatedSources[editedLang] || {}),
              [currentRegister]: "human",
            };
          }
          return { ...t, source: "human", sources: updatedSources };
        })
      );
      setHasUnsaved(false);
      fetchStats();
    } catch (e) {
      console.error("Failed to save:", getErrorMessage(e));
    } finally {
      setTimeout(() => setSaving(null), 600);
    }
  }

  // Approve or reject an AI translation for the currently selected register
  // of a given language. Reviewing in "casual" never touches "default".
  async function reviewTranslation(translationId: string, lang: string, action: "approve" | "reject") {
    try {
      await api.post(`/translations/${translationId}/review`, {
        lang,
        action,
        register: currentRegister,
      });
      fetchTranslations();
      fetchStats();
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    }
  }

  async function deleteTranslation(id: string) {
    if (!window.confirm("Delete this translation key?")) return;
    try {
      await api.delete(`/translations/${id}`);
      fetchTranslations();
      fetchStats();
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    }
  }

  // ─── AI Translation ──────────────────────────────────────────

  // Count how many keys are missing translations for a given language
  // at the currently active register.
  function missingForLang(lang: string): number {
    return translations.filter(
      (t) => valueAt(t, "en", "default").trim() && !valueAt(t, lang, currentRegister).trim()
    ).length;
  }

  async function handleAITranslate() {
    if (!aiTargetLang) return;
    setAITranslating(true);
    setAIResult(null);

    try {
      const res = await api.post(`/translations/${projectId}/ai-translate`, {
        targetLang: aiTargetLang,
        register: currentRegister,
      });
      const data = res.data.data;
      setAIResult(`${data.translated} ${currentRegister} translations generated for ${LANG_NAMES[aiTargetLang] || aiTargetLang}`);
      fetchTranslations();
      fetchStats();
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    } finally {
      setAITranslating(false);
    }
  }

  function openAIModal() {
    // Default to first non-English language
    const nonEnLangs = project?.supportedLanguages.filter((l) => l !== "en") || [];
    setAITargetLang(nonEnLangs[0] || "");
    setAIResult(null);
    setShowAIModal(true);
  }

  // ─── History ────────────────────────────────────────────────

  async function fetchRecentHistory() {
    try {
      const res = await api.get(`/translations/${projectId}/history/recent?limit=30`);
      setRecentHistory(res.data.data);
    } catch (e) {
      // non-critical
    }
  }

  async function fetchCellHistory(translationId: string, lang: string) {
    try {
      const res = await api.get(`/translations/${translationId}/history?lang=${lang}&limit=10`);
      setCellHistory(res.data.data);
    } catch (e) {
      setCellHistory([]);
    }
  }

  function openCellHistory(translationId: string, lang: string) {
    if (historyPopover?.translationId === translationId && historyPopover?.lang === lang) {
      setHistoryPopover(null);
      return;
    }
    setHistoryPopover({ translationId, lang });
    fetchCellHistory(translationId, lang);
  }

  function toggleActivity() {
    if (!showActivity) fetchRecentHistory();
    setShowActivity(!showActivity);
  }

  // ─── Comments ─────────────────────────────────────────────────

  async function fetchComments(translationId: string) {
    try {
      const res = await api.get(`/translations/${translationId}/comments`);
      setComments(res.data.data);
    } catch (e) {
      setComments([]);
    }
  }

  function toggleComments(translationId: string) {
    if (expandedComments === translationId) {
      setExpandedComments(null);
      setComments([]);
      setCommentText("");
      setCommentLang("");
    } else {
      setExpandedComments(translationId);
      fetchComments(translationId);
      setCommentText("");
      setCommentLang("");
    }
  }

  async function postComment(translationId: string) {
    if (!commentText.trim()) return;
    setPostingComment(true);
    try {
      await api.post(`/translations/${translationId}/comments`, {
        content: commentText.trim(),
        lang: commentLang || undefined,
      });
      setCommentText("");
      setCommentLang("");
      fetchComments(translationId);
      // Update count
      setCommentCounts((prev) => ({
        ...prev,
        [translationId]: (prev[translationId] || 0) + 1,
      }));
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    } finally {
      setPostingComment(false);
    }
  }

  async function deleteComment(commentId: string, translationId: string) {
    try {
      await api.delete(`/translations/comments/${commentId}`);
      fetchComments(translationId);
      setCommentCounts((prev) => ({
        ...prev,
        [translationId]: Math.max(0, (prev[translationId] || 0) - 1),
      }));
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    }
  }

  // ─── Glossary ─────────────────────────────────────────────────

  async function fetchGlossary() {
    try {
      const res = await api.get(`/projects/${projectId}/glossary`);
      setGlossary(res.data.data);
    } catch (e) {
      setGlossary([]);
    }
  }

  function openGlossary() {
    fetchGlossary();
    setShowGlossary(true);
    setNewTerm("");
    setNewTermNotes("");
    setEditingGlossaryId(null);
  }

  async function addGlossaryEntry() {
    if (!newTerm.trim()) return;
    try {
      await api.post(`/projects/${projectId}/glossary`, {
        term: newTerm.trim(),
        notes: newTermNotes.trim() || undefined,
      });
      setNewTerm("");
      setNewTermNotes("");
      fetchGlossary();
      showToast("Glossary term added");
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    }
  }

  async function updateGlossaryTranslation(entryId: string, lang: string, value: string) {
    try {
      await api.put(`/projects/${projectId}/glossary/${entryId}`, {
        translations: { [lang]: value },
      });
      fetchGlossary();
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    }
  }

  async function deleteGlossaryEntry(entryId: string) {
    try {
      await api.delete(`/projects/${projectId}/glossary/${entryId}`);
      fetchGlossary();
      showToast("Glossary term removed");
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    }
  }

  // ─── Bulk AI Translate & Review Queue ───────────────────────

  async function batchAITranslate(lang: string) {
    const missing = missingForLang(lang);
    if (missing === 0) {
      showToast(`No missing translations for ${LANG_NAMES[lang] || lang}`, "info");
      return;
    }

    setBatchTranslating(true);
    setBatchLang(lang);
    setBatchProgress(`Translating ${missing} keys to ${LANG_NAMES[lang] || lang}...`);

    try {
      const res = await api.post(`/translations/${projectId}/ai-translate`, {
        targetLang: lang,
      });
      const data = res.data.data;
      setBatchProgress(`Done! ${data.translated} translations generated.`);
      showToast(`${data.translated} AI translations generated for ${LANG_NAMES[lang] || lang}`);

      // Refresh data
      await fetchTranslations();
      await fetchStats();

      // Enter review queue mode
      setStatusFilter("ai-pending");
      setLangFilter(lang);
      setReviewQueueMode(true);
    } catch (e) {
      showToast(getErrorMessage(e), "error");
      setBatchProgress("");
    } finally {
      setBatchTranslating(false);
    }
  }

  function exitReviewQueue() {
    setReviewQueueMode(false);
    setStatusFilter("all");
    setLangFilter("all");
  }

  // Check if a cell value contains any glossary terms
  const glossaryTermSet = new Set(glossary.map((g) => g.term.toLowerCase()));

  // ─── Keyboard Navigation ──────────────────────────────────────

  function handleCellFocus(translationId: string, lang: string, value: string) {
    originalValueRef.current[`${translationId}:${lang}`] = value;
    setCellFocused(true);
  }

  function handleCellKeyDown(
    e: React.KeyboardEvent<HTMLInputElement>,
    translation: Translation,
    lang: string
  ) {
    const input = e.currentTarget;
    const rowIdx = Number(input.dataset.row);
    const colIdx = Number(input.dataset.col);

    if (e.key === "Escape") {
      e.preventDefault();
      const original = originalValueRef.current[`${translation._id}:${lang}`] ?? "";
      handleValueChange(translation._id, lang, original);
      setHasUnsaved(false);
      input.blur();
      return;
    }

    if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveTranslation(translation, lang);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const nextRow = rowIdx + 1;
      if (nextRow < filtered.length) {
        const next = document.querySelector<HTMLInputElement>(
          `input[data-row="${nextRow}"][data-col="${colIdx}"]`
        );
        next?.focus();
      }
      return;
    }

    if (e.key === "Tab") {
      const direction = e.shiftKey ? -1 : 1;
      const langs = project?.supportedLanguages || [];
      let nextCol = colIdx + direction;
      while (nextCol >= 0 && nextCol < langs.length) {
        if (canEditLang(langs[nextCol])) {
          const next = document.querySelector<HTMLInputElement>(
            `input[data-row="${rowIdx}"][data-col="${nextCol}"]`
          );
          if (next && !next.disabled) {
            e.preventDefault();
            next.focus();
            return;
          }
        }
        nextCol += direction;
      }
    }
  }

  // ─── Role helpers ─────────────────────────────────────────────

  const myRole = project?.myRole || "owner";
  const isOwner = myRole === "owner";
  const isViewer = myRole === "viewer";
  const assignedLangs = new Set<string>(); // populated from membership if translator
  // For now, translators can edit any language (backend enforces per-language restriction)
  const canEditLang = (lang: string) => !isViewer;

  // ─── Import ──────────────────────────────────────────────────

  async function handleImport() {
    try {
      const data = JSON.parse(importJson);
      if (typeof data !== "object" || Array.isArray(data)) {
        showToast("JSON must be an object like { \"key\": \"value\" }", "error");
        return;
      }

      setImporting(true);

      // Use the new bulk import endpoint
      const res = await api.post(`/translations/${projectId}/bulk`, {
        lang: importLang,
        translations: data,
      });

      showToast(res.data.data.message);
      setShowImport(false);
      setImportJson("");
      fetchTranslations();
      fetchStats();
    } catch (e: any) {
      if (e instanceof SyntaxError) {
        showToast("Invalid JSON format", "error");
      } else {
        showToast(getErrorMessage(e), "error");
      }
    } finally {
      setImporting(false);
    }
  }

  // ─── Export ──────────────────────────────────────────────────

  // Export all languages combined — uses the currently active register.
  // Filename includes the register so a multi-register export doesn't clobber
  // a default-register one with the same name.
  function exportAll() {
    if (!project) return;
    const exportData: Record<string, Record<string, string>> = {};
    for (const lang of project.supportedLanguages) {
      exportData[lang] = {};
      for (const t of translations) {
        const v = valueAt(t, lang, currentRegister);
        if (v) exportData[lang][t.key] = v;
      }
    }
    downloadJson(exportData, `${project.name}-${currentRegister}-all-translations.json`);
    setShowExport(false);
  }

  // Export a single language as flat JSON (this is what i18n libraries expect),
  // at the currently active register.
  function exportLang(lang: string) {
    if (!project) return;
    const exportData: Record<string, string> = {};
    for (const t of translations) {
      const v = valueAt(t, lang, currentRegister);
      if (v) exportData[t.key] = v;
    }
    downloadJson(exportData, `${project.name}-${lang}-${currentRegister}.json`);
    setShowExport(false);
  }

  function downloadJson(data: any, filename: string) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadBlob(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Export as CSV (all languages) at the active register.
  function exportCSV() {
    if (!project) return;
    const langs = project.supportedLanguages;
    const header = ["key", ...langs].map((h) => `"${h}"`).join(",");
    const rows = translations.map((t) => {
      const cols = [
        `"${t.key.replace(/"/g, '""')}"`,
        ...langs.map((lang) => {
          const val = valueAt(t, lang, currentRegister).replace(/"/g, '""');
          return `"${val}"`;
        }),
      ];
      return cols.join(",");
    });
    downloadBlob([header, ...rows].join("\n"), `${project.name}-${currentRegister}-translations.csv`, "text/csv;charset=utf-8;");
    setShowExport(false);
  }

  // Export as Android XML (per language) at the active register.
  function exportAndroidXML(lang: string) {
    if (!project) return;
    const lines = ['<?xml version="1.0" encoding="utf-8"?>', "<resources>"];
    for (const t of translations) {
      const val = valueAt(t, lang, currentRegister);
      if (!val) continue;
      const escaped = val.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "\\'");
      const resName = t.key.replace(/\./g, "_");
      lines.push(`  <string name="${resName}">${escaped}</string>`);
    }
    lines.push("</resources>");
    downloadBlob(lines.join("\n"), `strings-${lang}-${currentRegister}.xml`, "application/xml");
    setShowExport(false);
  }

  // Export as iOS .strings (per language) at the active register.
  function exportIOSStrings(lang: string) {
    if (!project) return;
    const lines = [`/* ${project.name} — ${lang} (${currentRegister}) */`, ""];
    for (const t of translations) {
      const val = valueAt(t, lang, currentRegister);
      if (!val) continue;
      if (t.context) lines.push(`/* ${t.context} */`);
      lines.push(`"${t.key}" = "${val.replace(/"/g, '\\"')}";`);
      lines.push("");
    }
    downloadBlob(lines.join("\n"), `${lang}-${currentRegister}.strings`, "text/plain");
    setShowExport(false);
  }

  // ─── Helpers ─────────────────────────────────────────────────

  // Count missing translations for a key at the active register.
  function missingCount(translation: Translation): number {
    if (!project) return 0;
    return project.supportedLanguages.filter(
      (lang) => !valueAt(translation, lang, currentRegister).trim()
    ).length;
  }

  // Filter translations by search query + status + language. All checks operate
  // on the active register (so "untranslated" in casual mode means
  // "casual variant missing", not "default missing").
  const filtered = translations.filter((t) => {
    // Text search — also walks across registers so a known phrase finds its key
    // even if the user is currently viewing a different register.
    const q = searchQuery.toLowerCase();
    if (q) {
      const inKey = t.key.toLowerCase().includes(q);
      let inValues = false;
      outer: for (const langMap of Object.values(t.translations || {})) {
        if (!langMap || typeof langMap !== "object") continue;
        for (const v of Object.values(langMap)) {
          if (typeof v === "string" && v.toLowerCase().includes(q)) {
            inValues = true;
            break outer;
          }
        }
      }
      if (!inKey && !inValues) return false;
    }
    // Status filter
    if (statusFilter !== "all") {
      if (langFilter !== "all") {
        // Apply to specific language at the active register
        const src = sourceAt(t, langFilter, currentRegister);
        if (statusFilter === "untranslated" && valueAt(t, langFilter, currentRegister).trim()) return false;
        if (statusFilter === "ai-pending" && src !== "ai") return false;
        if (statusFilter === "approved" && src !== "approved") return false;
      } else {
        // Apply across all languages at the active register
        if (statusFilter === "untranslated") {
          const hasMissing = project?.supportedLanguages.some(
            (lang) => lang !== "en" && !valueAt(t, lang, currentRegister).trim()
          );
          if (!hasMissing) return false;
        } else if (statusFilter === "ai-pending") {
          const hasAI = project?.supportedLanguages.some((lang) => sourceAt(t, lang, currentRegister) === "ai");
          if (!hasAI) return false;
        } else if (statusFilter === "approved") {
          const hasApproved = project?.supportedLanguages.some((lang) => sourceAt(t, lang, currentRegister) === "approved");
          if (!hasApproved) return false;
        }
      }
    } else if (langFilter !== "all") {
      // Language-only filter: show keys missing this language at the active register
      if (valueAt(t, langFilter, currentRegister).trim()) return false;
    }
    return true;
  });

  // Get the preview translation for a given key
  const previewTranslation = translations.find((t) => t.key === previewKey);

  // Navigate back with unsaved warning
  function goBack() {
    if (hasUnsaved && !window.confirm("You have unsaved changes. Leave anyway?")) return;
    navigate("/projects");
  }

  if (loading) {
    return (
      <div className="page-container">
        <header className="page-header">
          <div className="header-left">
            <div className="skeleton skeleton-btn" />
            <div className="skeleton skeleton-title" />
          </div>
          <div className="header-actions">
            <div className="skeleton skeleton-btn" />
            <div className="skeleton skeleton-btn" />
          </div>
        </header>
        <main className="page-main">
          <div className="skeleton skeleton-stats-bar" />
          <div className="skeleton skeleton-toolbar" />
          <div className="skeleton-table">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton skeleton-row" style={{ opacity: 1 - i * 0.1 }} />
            ))}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page-container">
      {/* ─── Header ─────────────────────────────────────────── */}
      <header className="page-header">
        <div className="header-left">
          <button className="btn-ghost" onClick={goBack}>
            <ArrowLeft size={18} />
            Back
          </button>
          <h1 className="project-name">{project?.name}</h1>
        </div>
        <div className="header-actions">
          {myRole && (
            <span className={`role-badge role-${myRole}`}>{myRole}</span>
          )}
          {!isViewer && (
            <button className="btn-ai" onClick={openAIModal}>
              <Sparkles size={16} />
              AI Translate
            </button>
          )}
          <div className="notif-wrapper">
            <button
              className="btn-ghost notif-bell"
              onClick={() => setShowNotifications(!showNotifications)}
            >
              <Bell size={16} />
              {unreadCount > 0 && (
                <span className="notif-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>
              )}
            </button>
            {showNotifications && (
              <div className="notif-dropdown">
                <div className="notif-header">
                  <span>Notifications</span>
                  {unreadCount > 0 && (
                    <button className="notif-mark-all" onClick={markAllRead}>
                      Mark all read
                    </button>
                  )}
                </div>
                {notifications.length === 0 ? (
                  <p className="notif-empty">No notifications</p>
                ) : (
                  notifications.map((n) => (
                    <div
                      key={n._id}
                      className={`notif-item ${n.read ? "" : "notif-unread"}`}
                      onClick={() => !n.read && markRead(n._id)}
                    >
                      <p className="notif-message">{n.message}</p>
                      <span className="notif-time">
                        {new Date(n.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <button className="btn-ghost" onClick={openGlossary}>
            <BookOpen size={16} />
            Glossary
          </button>
          <button className="btn-ghost" onClick={toggleActivity}>
            <Activity size={16} />
            Activity
          </button>
          <button className="btn-ghost" onClick={() => setShowPreview(!showPreview)}>
            <Eye size={16} />
            Preview
          </button>
          {!isViewer && (
            <button className="btn-ghost" onClick={() => setShowImport(true)}>
              <Upload size={16} />
              Import
            </button>
          )}
          <div className="export-wrapper">
            <button className="btn-ghost" onClick={() => setShowExport(!showExport)}>
              <Download size={16} />
              Export
            </button>
            {/* Export dropdown menu */}
            {showExport && (
              <div className="dropdown-menu">
                <div className="dropdown-section-label">JSON</div>
                <button className="dropdown-item" onClick={exportAll}>
                  All languages (combined)
                </button>
                {project?.supportedLanguages.map((lang) => (
                  <button key={lang} className="dropdown-item" onClick={() => exportLang(lang)}>
                    {LANG_NAMES[lang] || lang} only
                  </button>
                ))}
                <div className="dropdown-divider" />
                <div className="dropdown-section-label">CSV</div>
                <button className="dropdown-item" onClick={exportCSV}>
                  All languages (spreadsheet)
                </button>
                <div className="dropdown-divider" />
                <div className="dropdown-section-label">Android XML</div>
                {project?.supportedLanguages.map((lang) => (
                  <button key={lang} className="dropdown-item" onClick={() => exportAndroidXML(lang)}>
                    {LANG_NAMES[lang] || lang}
                  </button>
                ))}
                <div className="dropdown-divider" />
                <div className="dropdown-section-label">iOS .strings</div>
                {project?.supportedLanguages.map((lang) => (
                  <button key={lang} className="dropdown-item" onClick={() => exportIOSStrings(lang)}>
                    {LANG_NAMES[lang] || lang}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="page-main">
        {/* ─── Stats Bar ──────────────────────────────────────── */}
        {stats && (
          <div className="stats-bar">
            <button className="btn-icon" onClick={() => setShowAnalytics(!showAnalytics)} title="Toggle analytics">
              <BarChart3 size={16} />
            </button>
            {project?.supportedLanguages.map((lang) => (
              <div key={lang} className="stat-item">
                <span className="stat-lang">{LANG_NAMES[lang] || lang}</span>
                <div className="stat-progress">
                  <div
                    className="stat-progress-fill"
                    style={{ width: `${stats[lang]?.percentage || 0}%` }}
                  />
                </div>
                <span className="stat-pct">{stats[lang]?.percentage || 0}%</span>
                {!isViewer && lang !== "en" && (stats[lang]?.percentage || 0) < 100 && (
                  <button
                    className="btn-batch-translate"
                    title={`AI translate all missing ${LANG_NAMES[lang] || lang}`}
                    onClick={() => batchAITranslate(lang)}
                    disabled={batchTranslating}
                  >
                    <Sparkles size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ─── Analytics Panel ───────────────────────────────── */}
        {showAnalytics && stats && (
          <div className="analytics-panel">
            <h4>Source Breakdown</h4>
            <div className="analytics-grid">
              {project?.supportedLanguages.map((lang) => {
                const s = stats[lang]?.sources;
                if (!s) return null;
                const total = s.human + s.ai + s.approved;
                return (
                  <div key={lang} className="analytics-card">
                    <span className="analytics-lang">{LANG_NAMES[lang] || lang}</span>
                    <div className="source-bar">
                      {total > 0 ? (
                        <>
                          {s.human > 0 && (
                            <div
                              className="source-seg source-human"
                              style={{ width: `${(s.human / total) * 100}%` }}
                              title={`Human: ${s.human}`}
                            />
                          )}
                          {s.approved > 0 && (
                            <div
                              className="source-seg source-approved"
                              style={{ width: `${(s.approved / total) * 100}%` }}
                              title={`Approved: ${s.approved}`}
                            />
                          )}
                          {s.ai > 0 && (
                            <div
                              className="source-seg source-ai"
                              style={{ width: `${(s.ai / total) * 100}%` }}
                              title={`AI: ${s.ai}`}
                            />
                          )}
                        </>
                      ) : (
                        <div className="source-seg source-empty" style={{ width: "100%" }} />
                      )}
                    </div>
                    <div className="source-legend">
                      <span className="legend-item"><span className="dot dot-human" /> {s.human} human</span>
                      <span className="legend-item"><span className="dot dot-approved" /> {s.approved} approved</span>
                      <span className="legend-item"><span className="dot dot-ai" /> {s.ai} AI</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── Activity Feed ─────────────────────────────────── */}
        {showActivity && (
          <div className="activity-panel">
            <h4>Recent Activity</h4>
            {recentHistory.length === 0 ? (
              <p className="text-muted">No recent changes.</p>
            ) : (
              <div className="activity-list">
                {recentHistory.map((h) => (
                  <div key={h._id} className="activity-item">
                    <div className="activity-meta">
                      <span className="activity-user">{h.changedBy?.name || "Unknown"}</span>
                      <span className="activity-action">{h.source}</span>
                      <span className="activity-key">{h.key}</span>
                      <span className="activity-lang">{h.lang}</span>
                      <span className="activity-time">
                        {new Date(h.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {h.oldValue && (
                      <div className="activity-diff">
                        <span className="diff-old">{h.oldValue}</span>
                        <span className="diff-arrow">&rarr;</span>
                        <span className="diff-new">{h.newValue}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── Toolbar ────────────────────────────────────────── */}
        <div className="editor-toolbar">
          <div className="search-box">
            <Search size={16} />
            <input
              type="text"
              placeholder="Search keys or translations..."
              value={searchQuery}
              onChange={(e) => {
                const val = e.target.value;
                setSearchQuery(val);
                clearTimeout(searchDebounceRef.current);
                searchDebounceRef.current = setTimeout(() => {
                  setCurrentPage(1);
                  fetchTranslations(1, false);
                }, 300);
              }}
            />
          </div>
          <div className="toolbar-stats">
            <span>{translations.length} keys</span>
            <span className="stat-divider">·</span>
            <span>{project?.supportedLanguages.length} languages</span>
          </div>
          {!isViewer && (
            <button className="btn-primary" onClick={() => setShowAddKey(true)}>
              <Plus size={16} />
              Add Key
            </button>
          )}
        </div>

        {/* ─── Filter Bar ────────────────────────────────────────── */}
        <div className="filter-bar">
          <span className="filter-label">Filter:</span>
          {(["all", "untranslated", "ai-pending", "approved"] as StatusFilter[]).map((s) => (
            <button
              key={s}
              className={`filter-chip ${statusFilter === s ? "active" : ""}`}
              onClick={() => setStatusFilter(s)}
            >
              {s === "all" ? "All" : s === "untranslated" ? "Untranslated" : s === "ai-pending" ? "AI Pending" : "Approved"}
            </button>
          ))}
          <span className="filter-divider" />
          <span className="filter-label">Language:</span>
          <select
            className="filter-lang-select"
            value={langFilter}
            onChange={(e) => setLangFilter(e.target.value)}
          >
            <option value="all">All languages</option>
            {project?.supportedLanguages
              .filter((l) => l !== "en")
              .map((lang) => (
                <option key={lang} value={lang}>{LANG_NAMES[lang] || lang}</option>
              ))}
          </select>
          {(statusFilter !== "all" || langFilter !== "all") && (
            <button
              className="filter-clear"
              onClick={() => { setStatusFilter("all"); setLangFilter("all"); }}
            >
              Clear filters
            </button>
          )}
          <span className="filter-count">{filtered.length} of {translations.length}</span>
        </div>

        {/* ─── Add Key Modal ──────────────────────────────────── */}
        {showAddKey && (
          <div className="modal-overlay" onClick={() => setShowAddKey(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>Add Translation Key</h3>
              <div className="form-group">
                <label>Key</label>
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="e.g. hero.title, nav.home, footer.copyright"
                  autoFocus
                />
                <span className="form-hint">Only lowercase letters, numbers, dots, and underscores</span>
              </div>
              <div className="form-group">
                <label>Context (optional)</label>
                <input
                  type="text"
                  value={newContext}
                  onChange={(e) => setNewContext(e.target.value)}
                  placeholder="Describe what this text is for — helps translators and AI"
                />
              </div>
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => setShowAddKey(false)}>Cancel</button>
                <button className="btn-primary" onClick={addKey}>Add Key</button>
              </div>
            </div>
          </div>
        )}

        {/* ─── AI Translate Modal ─────────────────────────────── */}
        {showAIModal && (
          <div className="modal-overlay" onClick={() => !aiTranslating && setShowAIModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header-row">
                <h3><Sparkles size={18} style={{ verticalAlign: "middle", marginRight: 8, color: "#a855f7" }} />AI Translate</h3>
                <button className="btn-icon" onClick={() => !aiTranslating && setShowAIModal(false)}>
                  <X size={18} />
                </button>
              </div>
              <div className="form-group">
                <label>Target Language</label>
                <select
                  value={aiTargetLang}
                  onChange={(e) => { setAITargetLang(e.target.value); setAIResult(null); }}
                  disabled={aiTranslating}
                >
                  {project?.supportedLanguages
                    .filter((l) => l !== "en")
                    .map((lang) => (
                      <option key={lang} value={lang}>
                        {LANG_NAMES[lang] || lang}
                      </option>
                    ))}
                </select>
              </div>
              {aiTargetLang && (
                <div className="ai-modal-info">
                  <span className="info-count">{missingForLang(aiTargetLang)}</span>
                  <span className="info-text">
                    keys with English text but missing {LANG_NAMES[aiTargetLang] || aiTargetLang} translation.
                    AI will translate all of them.
                  </span>
                </div>
              )}
              {aiResult && <div className="ai-result">{aiResult}</div>}
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => !aiTranslating && setShowAIModal(false)} disabled={aiTranslating}>
                  {aiResult ? "Close" : "Cancel"}
                </button>
                {!aiResult && (
                  <button
                    className="btn-ai"
                    onClick={handleAITranslate}
                    disabled={aiTranslating || missingForLang(aiTargetLang) === 0}
                  >
                    <Sparkles size={14} />
                    {aiTranslating ? "Translating..." : "Generate Translations"}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ─── Import Modal ───────────────────────────────────── */}
        {showImport && (
          <div className="modal-overlay" onClick={() => setShowImport(false)}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header-row">
                <h3>Import Translations</h3>
                <button className="btn-icon" onClick={() => setShowImport(false)}>
                  <X size={18} />
                </button>
              </div>
              <div className="form-group">
                <label>Language</label>
                <select value={importLang} onChange={(e) => setImportLang(e.target.value)}>
                  {project?.supportedLanguages.map((lang) => (
                    <option key={lang} value={lang}>{LANG_NAMES[lang] || lang}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>JSON</label>
                <textarea
                  value={importJson}
                  onChange={(e) => setImportJson(e.target.value)}
                  placeholder={'{\n  "hero.title": "Welcome",\n  "nav.home": "Home"\n}'}
                  rows={10}
                />
                <span className="form-hint">
                  Flat JSON format. New keys will be created, existing keys will be updated.
                </span>
              </div>
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => setShowImport(false)}>Cancel</button>
                <button className="btn-primary" onClick={handleImport} disabled={importing}>
                  {importing ? "Importing..." : "Import"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ─── Glossary Modal ──────────────────────────────────── */}
        {showGlossary && (
          <div className="modal-overlay" onClick={() => setShowGlossary(false)}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header-row">
                <h3><BookOpen size={18} style={{ verticalAlign: "middle", marginRight: 8 }} />Glossary</h3>
                <button className="btn-icon" onClick={() => setShowGlossary(false)}>
                  <X size={18} />
                </button>
              </div>
              <p className="glossary-desc">
                Define terminology that AI translations must follow. Add a term and its translations per language.
              </p>

              {/* Add new term */}
              {!isViewer && (
                <div className="glossary-add-row">
                  <input
                    type="text"
                    placeholder="English term..."
                    value={newTerm}
                    onChange={(e) => setNewTerm(e.target.value)}
                    className="glossary-term-input"
                  />
                  <input
                    type="text"
                    placeholder="Notes (optional)"
                    value={newTermNotes}
                    onChange={(e) => setNewTermNotes(e.target.value)}
                    className="glossary-notes-input"
                  />
                  <button className="btn-primary btn-sm" onClick={addGlossaryEntry} disabled={!newTerm.trim()}>
                    <Plus size={14} /> Add
                  </button>
                </div>
              )}

              {/* Glossary table */}
              {glossary.length === 0 ? (
                <p className="glossary-empty">No glossary terms yet.</p>
              ) : (
                <div className="glossary-table-wrapper">
                  <table className="glossary-table">
                    <thead>
                      <tr>
                        <th>Term (EN)</th>
                        {project?.supportedLanguages
                          .filter((l) => l !== "en")
                          .map((lang) => (
                            <th key={lang}>{LANG_NAMES[lang] || lang}</th>
                          ))}
                        <th>Notes</th>
                        {isOwner && <th></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {glossary.map((g) => (
                        <tr key={g._id}>
                          <td className="glossary-term-cell">{g.term}</td>
                          {project?.supportedLanguages
                            .filter((l) => l !== "en")
                            .map((lang) => (
                              <td key={lang}>
                                <input
                                  type="text"
                                  className="glossary-cell-input"
                                  value={g.translations[lang] || ""}
                                  placeholder={`${LANG_NAMES[lang]}...`}
                                  disabled={isViewer}
                                  onBlur={(e) => {
                                    const val = e.target.value;
                                    if (val !== (g.translations[lang] || "")) {
                                      updateGlossaryTranslation(g._id, lang, val);
                                    }
                                  }}
                                  onChange={(e) => {
                                    setGlossary((prev) =>
                                      prev.map((entry) =>
                                        entry._id === g._id
                                          ? { ...entry, translations: { ...entry.translations, [lang]: e.target.value } }
                                          : entry
                                      )
                                    );
                                  }}
                                />
                              </td>
                            ))}
                          <td className="glossary-notes-cell">{g.notes || "—"}</td>
                          {isOwner && (
                            <td>
                              <button
                                className="btn-icon-danger"
                                onClick={() => deleteGlossaryEntry(g._id)}
                              >
                                <Trash2 size={12} />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── Preview Panel ──────────────────────────────────── */}
        {showPreview && (
          <div className="preview-panel">
            <div className="preview-header">
              <h4>Font Preview</h4>
              <select
                value={previewKey}
                onChange={(e) => setPreviewKey(e.target.value)}
                className="preview-select"
              >
                <option value="">Select a key to preview...</option>
                {translations.map((t) => (
                  <option key={t._id} value={t.key}>{t.key}</option>
                ))}
              </select>
            </div>
            {previewTranslation ? (
              <div className="preview-grid">
                {project?.supportedLanguages.map((lang) => (
                  <div key={lang} className="preview-item">
                    <span className="preview-lang">{LANG_NAMES[lang] || lang}</span>
                    <p
                      className="preview-text"
                      style={{
                        fontFamily: LANG_FONTS[lang] || "'DM Sans', sans-serif",
                        direction: RTL_LANGS.has(lang) ? "rtl" : "ltr",
                        textAlign: RTL_LANGS.has(lang) ? "right" : "left",
                      }}
                    >
                      {valueAt(previewTranslation, lang, currentRegister) || (
                        <span className="preview-empty">No translation</span>
                      )}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="preview-placeholder">Select a key above to see how it renders in each language</p>
            )}
          </div>
        )}

        {/* ─── Batch Progress Banner ─────────────────────────── */}
        {batchTranslating && batchProgress && (
          <div className="batch-progress-banner">
            <Sparkles size={16} className="batch-spinner" />
            <span>{batchProgress}</span>
          </div>
        )}

        {/* ─── Review Queue Header ────────────────────────────── */}
        {reviewQueueMode && (
          <div className="review-queue-header">
            <span className="review-queue-title">
              Review Queue — {filtered.length} AI translations for {LANG_NAMES[langFilter] || langFilter}
            </span>
            <button className="btn-ghost" onClick={exitReviewQueue}>
              <X size={14} /> Exit Review
            </button>
          </div>
        )}

        {/* ─── Translation Table ──────────────────────────────── */}
        {filtered.length === 0 && translations.length === 0 ? (
          <div className="empty-state">
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="empty-state-art">
              <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />
              <ellipse cx="32" cy="32" rx="12" ry="28" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />
              <line x1="4" y1="32" x2="60" y2="32" stroke="currentColor" strokeWidth="1.5" />
              <line x1="10" y1="20" x2="54" y2="20" stroke="currentColor" strokeWidth="1" opacity="0.5" />
              <line x1="10" y1="44" x2="54" y2="44" stroke="currentColor" strokeWidth="1" opacity="0.5" />
            </svg>
            <h3>No translation keys yet</h3>
            <p>Add your first key to start building your translation table</p>
            {!isViewer && (
              <button className="btn-primary btn-empty-action" onClick={() => setShowAddKey(true)}>
                <Plus size={16} /> Add your first key
              </button>
            )}
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="empty-state-art">
              <circle cx="28" cy="28" r="18" stroke="currentColor" strokeWidth="1.5" />
              <line x1="41" y1="41" x2="58" y2="58" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <h3>No results found</h3>
            <p>No keys or translations match your search{statusFilter !== "all" ? " and filters" : ""}</p>
            {(statusFilter !== "all" || langFilter !== "all") && (
              <button className="btn-ghost btn-empty-action" onClick={() => { setStatusFilter("all"); setLangFilter("all"); }}>
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="translation-table-wrapper">
            <table className="translation-table">
              <thead>
                <tr>
                  <th className="col-key">Key</th>
                  {project?.supportedLanguages.map((lang) => (
                    <th key={lang} className="col-lang">
                      <span className="th-lang-name">{LANG_NAMES[lang] || lang}</span>
                      <span className="th-lang-code">{lang}</span>
                    </th>
                  ))}
                  <th className="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <React.Fragment key={t._id}>
                  <tr>
                    {/* Key column */}
                    <td className="col-key">
                      <code className="key-name">{t.key}</code>
                      {t.context && <span className="key-context">{t.context}</span>}
                      {missingCount(t) > 0 && (
                        <span className="missing-badge">
                          <AlertCircle size={12} />
                          {missingCount(t)} missing
                        </span>
                      )}
                    </td>

                    {/* Language columns — show the active register's cell.
                        English is locked to "default" since English doesn't get
                        formal/casual variants in this product. */}
                    {project?.supportedLanguages.map((lang, colIdx) => {
                      const langRegister = lang === "en" ? "default" : currentRegister;
                      const langSource = sourceAt(t, lang, langRegister);
                      const isAI = langSource === "ai";
                      const isApproved = langSource === "approved";
                      const editable = canEditLang(lang);
                      const rowIdx = filtered.indexOf(t);
                      const cellValue = valueAt(t, lang, langRegister);
                      const enValue = valueAt(t, "en", "default");
                      return (
                        <td key={lang} className="col-lang">
                          <div className="cell-wrapper">
                            <input
                              type="text"
                              className={`cell-input ${RTL_LANGS.has(lang) ? "rtl" : ""}`}
                              data-row={rowIdx}
                              data-col={colIdx}
                              value={cellValue}
                              onChange={(e) => handleValueChange(t._id, lang, e.target.value)}
                              onFocus={() => handleCellFocus(t._id, lang, cellValue)}
                              onBlur={() => { saveTranslation(t, lastEditedLangRef.current); setCellFocused(false); }}
                              onKeyDown={(e) => handleCellKeyDown(e, t, lang)}
                              placeholder={`${LANG_NAMES[lang] || lang}...`}
                              dir={RTL_LANGS.has(lang) ? "rtl" : "ltr"}
                              disabled={!editable}
                            />
                            <div className="cell-source-actions">
                              {isAI && !isViewer && (
                                <>
                                  <span className="ai-badge-cell">AI</span>
                                  <button
                                    className="btn-approve"
                                    title="Approve this translation"
                                    onClick={() => reviewTranslation(t._id, lang, "approve")}
                                  >
                                    <Check size={12} />
                                  </button>
                                  <button
                                    className="btn-reject"
                                    title="Reject and remove this translation"
                                    onClick={() => reviewTranslation(t._id, lang, "reject")}
                                  >
                                    <XCircle size={12} />
                                  </button>
                                </>
                              )}
                              {isAI && isViewer && (
                                <span className="ai-badge-cell">AI</span>
                              )}
                              {isApproved && (
                                <span className="approved-badge-cell">Approved</span>
                              )}
                              {cellValue && (
                                <button
                                  className="btn-icon btn-history"
                                  title="View history"
                                  onClick={() => openCellHistory(t._id, lang)}
                                >
                                  <Clock size={10} />
                                </button>
                              )}
                              {lang === "en" && enValue && glossaryTermSet.size > 0 &&
                                enValue.toLowerCase().split(/\s+/).some((w: string) => glossaryTermSet.has(w)) && (
                                <span className="glossary-dot" title="Contains glossary terms">
                                  <BookOpen size={10} />
                                </span>
                              )}
                            </div>
                            {/* History popover */}
                            {historyPopover?.translationId === t._id && historyPopover?.lang === lang && (
                              <div className="history-popover">
                                <div className="history-popover-header">
                                  <span>History</span>
                                  <button className="btn-icon" onClick={() => setHistoryPopover(null)}>
                                    <X size={12} />
                                  </button>
                                </div>
                                {cellHistory.length === 0 ? (
                                  <p className="text-muted text-sm">No history yet.</p>
                                ) : (
                                  cellHistory.map((h) => (
                                    <div key={h._id} className="history-entry">
                                      <div className="history-meta">
                                        <span>{h.changedBy?.name}</span>
                                        <span className="history-time">
                                          {new Date(h.createdAt).toLocaleString()}
                                        </span>
                                      </div>
                                      <div className="history-values">
                                        {h.oldValue && (
                                          <span className="diff-old">{h.oldValue}</span>
                                        )}
                                        <span className="diff-new">{h.newValue}</span>
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                      );
                    })}

                    {/* Actions column */}
                    <td className="col-actions">
                      <div className="row-actions">
                        {saving === t._id && (
                          <span className="save-indicator"><Save size={14} /></span>
                        )}
                        {reviewQueueMode && langFilter !== "all" && t.sources?.[langFilter] === "ai" && (
                          <>
                            <button
                              className="btn-review-approve"
                              title="Approve"
                              onClick={() => reviewTranslation(t._id, langFilter, "approve")}
                            >
                              <Check size={14} /> Approve
                            </button>
                            <button
                              className="btn-review-reject"
                              title="Reject"
                              onClick={() => reviewTranslation(t._id, langFilter, "reject")}
                            >
                              <XCircle size={14} /> Reject
                            </button>
                          </>
                        )}
                        <button
                          className={`btn-icon btn-comment ${expandedComments === t._id ? "active" : ""}`}
                          title="Comments"
                          onClick={() => toggleComments(t._id)}
                        >
                          <MessageSquare size={14} />
                          {(commentCounts[t._id] || 0) > 0 && (
                            <span className="comment-count">{commentCounts[t._id]}</span>
                          )}
                        </button>
                        {isOwner && (
                          <button
                            className="btn-icon-danger"
                            onClick={() => deleteTranslation(t._id)}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {/* Expandable comment panel */}
                  {expandedComments === t._id && (
                    <tr className="comment-row">
                      <td colSpan={(project?.supportedLanguages.length || 0) + 2}>
                        <div className="comment-panel">
                          <div className="comment-list">
                            {comments.length === 0 ? (
                              <p className="comment-empty">No comments yet. Start a discussion!</p>
                            ) : (
                              comments.map((c) => (
                                <div key={c._id} className="comment-item">
                                  <div className="comment-meta">
                                    <span className="comment-author">{c.userId?.name || "Unknown"}</span>
                                    {c.lang && (
                                      <span className="comment-lang-tag">{LANG_NAMES[c.lang] || c.lang}</span>
                                    )}
                                    <span className="comment-time">
                                      {new Date(c.createdAt).toLocaleString()}
                                    </span>
                                    {(isOwner || c.userId?._id === "self") && (
                                      <button
                                        className="btn-icon comment-delete"
                                        onClick={() => deleteComment(c._id, t._id)}
                                        title="Delete comment"
                                      >
                                        <Trash2 size={12} />
                                      </button>
                                    )}
                                  </div>
                                  <p className="comment-content">{c.content}</p>
                                </div>
                              ))
                            )}
                          </div>
                          {!isViewer && (
                            <div className="comment-compose">
                              <select
                                className="comment-lang-select"
                                value={commentLang}
                                onChange={(e) => setCommentLang(e.target.value)}
                              >
                                <option value="">General</option>
                                {project?.supportedLanguages.map((lang) => (
                                  <option key={lang} value={lang}>
                                    {LANG_NAMES[lang] || lang}
                                  </option>
                                ))}
                              </select>
                              <input
                                type="text"
                                className="comment-input"
                                placeholder="Add a comment..."
                                value={commentText}
                                onChange={(e) => setCommentText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    postComment(t._id);
                                  }
                                }}
                              />
                              <button
                                className="btn-icon btn-send"
                                onClick={() => postComment(t._id)}
                                disabled={postingComment || !commentText.trim()}
                              >
                                <Send size={14} />
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ─── Load More ─────────────────────────────────────── */}
        {pagination && pagination.page < pagination.totalPages && (
          <div className="load-more-wrapper">
            <button
              className="btn-ghost"
              onClick={() => {
                const next = currentPage + 1;
                setCurrentPage(next);
                fetchTranslations(next, true);
              }}
            >
              Load more ({pagination.total - translations.length} remaining)
            </button>
          </div>
        )}
      </main>

      {/* Close export dropdown when clicking outside */}
      {showExport && (
        <div className="backdrop" onClick={() => setShowExport(false)} />
      )}

      {/* Keyboard shortcut hints */}
      {cellFocused && (
        <div className="shortcut-hint-bar">
          <span><kbd>Enter</kbd> next row</span>
          <span><kbd>Tab</kbd> next column</span>
          <span><kbd>Esc</kbd> discard</span>
          <span><kbd>Ctrl+S</kbd> save</span>
        </div>
      )}

      {/* Toast notifications */}
      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

// Local Globe SVG component (to avoid importing from lucide twice)
function Globe(props: any) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={props.size || 24} height={props.size || 24}
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={props.strokeWidth || 2}
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}
