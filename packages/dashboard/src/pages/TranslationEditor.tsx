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
import { useParams, useNavigate, Link } from "react-router-dom";
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
  Shield,
} from "lucide-react";
import { useNotifications } from "../context/NotificationContext";
import { useAuth } from "../context/AuthContext";

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

interface VoiceCell {
  ipa: string;
  ssml: string;
}

interface Translation {
  _id: string;
  key: string;
  // Nested by (lang → register → string). Server returns the full nested map;
  // the editor reads the slice for the currently active register.
  translations: Record<string, Record<string, string>>;
  context?: string;
  source: string;
  sources?: Record<string, Record<string, string>>; // per (lang, register): "human" | "ai" | "approved"
  voice?: Record<string, Record<string, VoiceCell>>;     // per (lang, register): { ipa, ssml }
  // Compliance lock — when true, AI drafts on this key are NOT served by the
  // SDK. Only `human` or `approved` cells reach end users. Set automatically
  // on pack import for items with a regulator citation.
  regulated?: boolean;
  mandatedBy?: string;
}

/** Read a (lang, register) cell, with default-register fallback so a partially
 *  localized casual register still shows something useful in the UI. */
function valueAt(t: Translation, lang: string, register: Register): string {
  const langMap = t.translations?.[lang];
  if (!langMap) return "";
  return langMap[register] || langMap.default || "";
}
function strictValueAt(t: Translation, lang: string, register: Register): string {
  const langMap = t.translations?.[lang];
  if (!langMap) return "";
  return langMap[lang === "en" ? "default" : register] ?? "";
}

function strictSourceAt(t: Translation, lang: string, register: Register): string | undefined {
  const langMap = t.sources?.[lang];
  if (!langMap) return undefined;
  return langMap[lang === "en" ? "default" : register];
}

/** Read the voice-data cell for a (lang, register), with default-register fallback. */
function voiceAt(t: Translation, lang: string, register: Register): VoiceCell | undefined {
  const langMap = t.voice?.[lang];
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
  // For translators: list of language codes the user is assigned to.
  // Owners get an empty array here (they can edit everything by role).
  // We use this to disable cells the server would 403 on anyway.
  myAssignedLanguages?: string[];
  // Monthly AI translation cap (keys/month). Surfaced read-only here.
  aiMonthlyCap?: number;
}

// AI usage meter for the current "YYYY-MM" period, read from
// GET /projects/:id/usage. Drives the "AI usage this month: X / cap" widget.
interface AiUsage {
  period: string;
  cap: number;
  keysTranslated: number;
  voiceCalls: number;
  aiCalls: number;
  percentUsed: number;
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

// ─── Compliance audit (owner-only) ──────────────────────────
// The sellable artifact: per regulated key, its citation + current per-cell
// status + the full approval history (each event's approver resolved to
// name/email). Mirrors GET /projects/:id/compliance/audit.
interface AuditEvent {
  lang: string;
  register: Register;
  oldValue: string;
  newValue: string;
  source: string;
  changedBy: { name: string; email: string };
  createdAt: string;
}
interface AuditKey {
  key: string;
  mandatedBy: string;
  // reviewClean = no unreviewed (ai/pending) copy can serve — the lock
  // guarantee. complete = every supported language approved in the default
  // register. fullyApproved = reviewClean AND complete. A regulated key can
  // be reviewClean (nothing unreviewed serves) yet incomplete (languages not
  // translated at all): review-clean ≠ fully translated.
  reviewClean: boolean;
  complete: boolean;
  fullyApproved: boolean;
  missingLanguages: string[];
  statuses: { lang: string; register: Register; status: string }[];
  history: AuditEvent[];
}
interface ComplianceSummary {
  total: number;
  reviewClean: number;
  complete: number;
  fullyApproved: number;
  withUnreviewed: number;
}

// Language display names — 13 South Asian languages + English + Latin-script variants
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
  // Latin-script variants — names use the colloquial term Gen-Z users recognize
  "hi-Latn": "Hinglish",
  "ne-Latn": "Roman Nepali",
  "ur-Latn": "Roman Urdu",
  "bn-Latn": "Banglish",
  "pa-Latn": "Roman Punjabi",
};

// Google Fonts for each script — used in preview panel.
// Latin-script variants render with a clean Latin font (no special font loading).
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
  // Latin-script: same font as English. Indistinguishable visually, by design.
  "hi-Latn": "'DM Sans', sans-serif",
  "ne-Latn": "'DM Sans', sans-serif",
  "ur-Latn": "'DM Sans', sans-serif",
  "bn-Latn": "'DM Sans', sans-serif",
  "pa-Latn": "'DM Sans', sans-serif",
};

// RTL languages — Latin-script variants are LTR even when their base language is RTL
// (Latin script is intrinsically LTR; that's why people use it for casual typing).
const RTL_LANGS = new Set(["ur", "pa-PK"]);

export default function TranslationEditor() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { userId } = useAuth();

  // Core state
  const [project, setProject] = useState<Project | null>(null);
  const [translations, setTranslations] = useState<Translation[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const registerStorageKey = projectId ? `bhashajs_register:${projectId}` : "bhashajs_register";

  // Active register — drives which (lang, register) slice the editor reads
  // and which cell edits/AI runs target. Persisted to localStorage so a
  // translator who lives in "casual" mode doesn't have to reset it every visit.
  const [currentRegister, setCurrentRegister] = useState<Register>(() => {
    const saved = typeof window !== "undefined"
      ? ((window.localStorage.getItem(registerStorageKey) ||
          window.localStorage.getItem("bhashajs_register")) as Register | null)
      : null;
    return saved && REGISTERS.includes(saved) ? saved : "default";
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(registerStorageKey, currentRegister);
    } catch { /* localStorage may be blocked — non-critical */ }
    // Re-slice stats for the new register. If the project hasn't loaded yet,
    // the initial fetch in the load effect handles the first render.
    if (project) fetchStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRegister, registerStorageKey]);

  // Filters
  type StatusFilter = "all" | "untranslated" | "ai-pending" | "approved";
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [langFilter, setLangFilter] = useState<string>("all");

  // Pagination
  interface PaginationInfo { page: number; limit: number; total: number; totalPages: number; }
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Track unsaved changes — PER CELL, not as a single global flag.
  //
  // The bug a global boolean caused: edit English, then edit Hindi while
  // English is still saving; when English's PUT resolves it clears the one
  // global flag → the leave/beforeunload guard no longer warns and the Hindi
  // edit is silently lost. So we keep a SET of dirty cell keys
  // (`${id}:${lang}:${register}`) and derive `hasUnsaved` from `size > 0`.
  // Saving cell A removes ONLY A's key, never B's. Each cell-level mutation
  // routes through `markCellDirty` / `markCellClean`, which recompute the
  // derived flag from the set so it always reflects "is ANY cell dirty".
  const dirtyCellsRef = useRef<Set<string>>(new Set());
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const unsavedRef = useRef(false);
  // Holds the latest `effectiveRegister` closure (assigned each render once the
  // function is defined below). The dirty-key helper reads it so it always uses
  // the CURRENT register, never one captured in an earlier render.
  const effectiveRegisterRef = useRef<(lang: string) => Register>((lang) =>
    lang === "en" ? "default" : "default"
  );

  // The register-aware dirty key for a cell — `${id}:${lang}:${register}`. EVERY
  // per-cell map (this dirty set, `originalValueRef`, `inFlightSavesRef`) keys on
  // this exact shape so they stay consistent: a (lang, register) pair is one
  // cell, and switching registers never aliases two different cells onto one key.
  //
  // The `register` is OPTIONAL: synchronous callers (typing, Escape) omit it and
  // we resolve the cell's CURRENT register from `effectiveRegisterRef`. But the
  // async save-completion handler MUST pass the register it actually saved —
  // reading the current register there is the cross-register race (the user may
  // have switched registers mid-flight), so we thread the saved register in.
  const cellKey = useCallback(
    (id: string, lang: string, register?: Register) =>
      `${id}:${lang}:${register ?? effectiveRegisterRef.current(lang)}`,
    []
  );
  // Sync the derived `hasUnsaved` flag from the dirty set's size. Called after
  // every add/remove so the unload guard, the goBack confirm, the register-
  // switch confirm, and the visible indicator all see the same source of truth.
  const syncHasUnsaved = useCallback(() => {
    setHasUnsaved(dirtyCellsRef.current.size > 0);
  }, []);
  const markCellDirty = useCallback(
    (id: string, lang: string, register?: Register) => {
      dirtyCellsRef.current.add(cellKey(id, lang, register));
      syncHasUnsaved();
    },
    [cellKey, syncHasUnsaved]
  );
  const markCellClean = useCallback(
    (id: string, lang: string, register?: Register) => {
      dirtyCellsRef.current.delete(cellKey(id, lang, register));
      syncHasUnsaved();
    },
    [cellKey, syncHasUnsaved]
  );

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

  // Translation Memory coverage — counts of human-verified pairs per (lang, register).
  // The flywheel: more approvals → larger corpus → eventually a fine-tunable
  // dataset for a register-aware South-Asian translation model. Threshold is
  // advisory; we surface progress as a number, not a gate.
  const [tmCoverage, setTmCoverage] = useState<{
    total: number;
    fineTunableThreshold: number;
  } | null>(null);

  // AI usage this month vs the project's monthly cap. Refreshed on load and
  // after each AI translate so the meter reflects what was just spent.
  const [aiUsage, setAiUsage] = useState<AiUsage | null>(null);

  // AI Translation modal
  const [showAIModal, setShowAIModal] = useState(false);
  const [aiTargetLang, setAITargetLang] = useState("");
  const [aiTranslating, setAITranslating] = useState(false);
  const [aiResult, setAIResult] = useState<string | null>(null);

  // Voice mode — when ON, each translation cell shows IPA underneath and a
  // "Generate voice" button replaces the AI Translate primary action.
  const [voiceMode, setVoiceMode] = useState(false);
  const [generatingVoice, setGeneratingVoice] = useState(false);

  // Vertical Packs modal — pre-loaded translation packs for regulated verticals
  interface VerticalPackMeta {
    _id: string;
    code: string;
    name: string;
    description: string;
    vertical: string;
    regulator?: string;
    jurisdiction?: string;
    languages: string[];
    registers: string[];
    official: boolean;
    isSample: boolean;
  }
  const [showPacks, setShowPacks] = useState(false);
  const [packs, setPacks] = useState<VerticalPackMeta[]>([]);
  const [packsLoading, setPacksLoading] = useState(false);
  const [importingPack, setImportingPack] = useState<string | null>(null);

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
  // Per-cell optimistic baseline, keyed by `${id}:${lang}:${register}` (the same
  // register-qualified shape as the dirty set and the in-flight guard) so a
  // formal-register baseline never overwrites the default-register one for the
  // same (id, lang). The change-guard reads it to decide whether a save is a
  // real edit or a no-op.
  const originalValueRef = useRef<Record<string, string>>({});
  // Set to a cell's `${id}:${lang}:${register}` key when Escape cancels its edit.
  // The cell then blurs synchronously and fires onBlur → saveTranslation BEFORE
  // React has committed the revert, so the save's change-guard would still see
  // the edited value and persist the cancelled copy. The blur handler checks and
  // clears this flag to skip exactly one save after an Escape-cancel.
  const skipNextBlurSaveRef = useRef<string | null>(null);
  // Per-cell "save in flight" guard. Holds the `${id}:${lang}:${register}` keys
  // with a PUT currently pending. A second save for the SAME cell (e.g. Ctrl+S
  // then the blur it triggers, which fires before the PUT resolves) is dropped so
  // the same edit isn't persisted twice. Register-qualified so an in-flight save
  // in one register never blocks an edit in another. Cleared in the finally block.
  const inFlightSavesRef = useRef<Set<string>>(new Set());
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
  const [approveAllRunning, setApproveAllRunning] = useState(false);
  const [approveAllProgress, setApproveAllProgress] = useState("");

  // Compliance audit (owner-only) — the regulated-key trail + export.
  const [showCompliance, setShowCompliance] = useState(false);
  const [complianceLoading, setComplianceLoading] = useState(false);
  const [auditKeys, setAuditKeys] = useState<AuditKey[]>([]);
  const [complianceSummary, setComplianceSummary] = useState<ComplianceSummary | null>(null);
  const [exportingAudit, setExportingAudit] = useState(false);

  // ─── Data Fetching ───────────────────────────────────────────
  useEffect(() => {
    fetchProject();
    fetchTranslations();
    fetchStats();
    fetchGlossary();
    fetchUsage();
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

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  async function fetchProject() {
    try {
      const res = await api.get(`/projects/${projectId}`);
      setProject(res.data.data);
    } catch (e) {
      console.error("Failed to fetch project:", getErrorMessage(e));
    }
  }

  async function fetchUsage() {
    try {
      const res = await api.get(`/projects/${projectId}/usage`);
      const data = res.data.data;
      if (data && typeof data.keysTranslated === "number") {
        setAiUsage(data);
      }
    } catch (e) {
      // Older servers won't have this endpoint — the meter just won't render.
    }
  }

  // `searchOverride` lets callers pass the CURRENT input value directly. The
  // debounced search handler must use it because the `searchQuery` state read
  // from this closure is the value from the render that scheduled the timeout —
  // i.e. the PREVIOUS query — so without the override a search runs one keystroke
  // behind. When omitted we fall back to the `searchQuery` state (normal paging).
  async function fetchTranslations(pageNum = 1, append = false, searchOverride?: string) {
    try {
      const params = new URLSearchParams({
        page: String(pageNum),
        limit: "50",
      });
      const search = searchOverride !== undefined ? searchOverride : searchQuery;
      if (search) params.set("search", search);
      const res = await api.get(`/translations/${projectId}?${params}`);
      const { data: items, pagination: pag, commentCounts: counts } = res.data.data;
      if (append) {
        setTranslations((prev) => [...prev, ...items]);
        if (counts && typeof counts === "object") {
          setCommentCounts((prev) => ({ ...prev, ...counts }));
        }
      } else {
        setTranslations(items);
        if (counts && typeof counts === "object") {
          setCommentCounts(counts);
        }
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
      const data = res.data.data;
      // New server returns { languages, registers } where registers[lang][reg] = cell.
      // Old server returns just { languages }. Slice the active register out so the
      // stats panel matches what the user is currently editing.
      if (data.registers) {
        const flat: Record<string, LangStats> = {};
        for (const lang of Object.keys(data.registers)) {
          const cell = data.registers[lang][currentRegister];
          if (cell) flat[lang] = cell;
        }
        setStats(flat);
      } else {
        setStats(data.languages || {});
      }
    } catch (e) {
      // Stats are non-critical, silently fail
    }
    // TM coverage fires alongside stats — same trigger surfaces (project load,
    // post-approve, post-AI-translate). Failure here is also non-critical;
    // the widget just doesn't render.
    try {
      const res = await api.get(`/translations/${projectId}/memory/coverage`);
      const data = res.data.data;
      if (data && typeof data.total === "number") {
        setTmCoverage({
          total: data.total,
          fineTunableThreshold: data.fineTunableThreshold || 5000,
        });
      }
    } catch (e) {
      // Older servers won't have this endpoint. Stay silent.
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
  //
  // English is locked to the "default" register everywhere — both reads and
  // writes. Without this, editing the English column while the user is on the
  // formal/casual tab would write the new English value into formal/casual and
  // leave the actual `default` cell stale, then reads in default would show
  // empty. The bug surfaced as "I edited English and my casual translations
  // disappeared" once the user switched registers.
  function effectiveRegister(lang: string): Register {
    return lang === "en" ? "default" : currentRegister;
  }
  // Keep a ref to the latest `effectiveRegister` so the dirty-cell key helper
  // (a stable useCallback) always computes the CURRENT register without
  // capturing a stale `currentRegister` from an earlier render.
  effectiveRegisterRef.current = effectiveRegister;

  function handleValueChange(translationId: string, lang: string, value: string) {
    // Mark THIS cell dirty (per-cell), not a single global flag. The derived
    // `hasUnsaved` follows the set's size, so a concurrent save of another cell
    // can never clear this edit's unsaved state.
    markCellDirty(translationId, lang);
    const reg = effectiveRegister(lang);
    setTranslations((prev) =>
      prev.map((t) => (t._id === translationId ? withValue(t, lang, reg, value) : t))
    );
  }

  // Save to server when user clicks out of a cell (onBlur) or hits Ctrl+S. The
  // server only touches the (editedLang, editedRegister) cell, so we send just
  // that pair. Caller passes the actual edited language — we derive its
  // effective register here so English always saves to "default".
  async function saveTranslation(
    translation: Translation,
    editedLang?: string,
    // The register to persist. Normal callers (blur, Ctrl+S) omit it and we
    // derive the cell's CURRENT register. The autosave-on-completion re-invoke
    // passes the register it originally saved so a mid-flight register switch
    // can't redirect the re-save to the wrong register.
    savedRegister?: Register
  ) {
    // The register being persisted by THIS call. Captured ONCE here and threaded
    // through the entire save lifecycle (baseline key, in-flight guard, dirty-set
    // key, provenance write, autosave-on-completion). The async completion handler
    // below must NEVER re-read the currently-selected register — the user can
    // switch registers while this PUT is in flight, which would otherwise clear or
    // block the WRONG register's cell (the cross-register save race).
    const editedRegister: Register = savedRegister
      ? savedRegister
      : editedLang
      ? effectiveRegister(editedLang)
      : currentRegister;

    // ─── Change-guard (covers EVERY caller: blur, Ctrl+S, and any future one) ──
    // A PUT stamps the edited cell's provenance — for a regulated key that can
    // flip an unreviewed AI/pending cell to a servable state. So a save must
    // only fire when the value ACTUALLY changed versus what was last loaded or
    // persisted. `originalValueRef` is the per-(id, lang, register) baseline
    // captured on focus (blur path) and refreshed across each save below; the
    // Ctrl+S path reuses that same baseline, so an unchanged AI cell is never
    // promoted to "human" just because the owner pressed Ctrl+S over it.
    //
    // `savedValue` is the exact value this save is persisting for the edited
    // cell. Captured up front so the success handler can tell whether a NEWER
    // edit landed while the PUT was in flight (don't clear `hasUnsaved` /
    // re-baseline blindly).
    const savedValue = editedLang
      ? valueAt(translation, editedLang, editedRegister)
      : undefined;
    // Register-qualified so the baseline/in-flight guard for (id, lang, formal)
    // never collides with (id, lang, default) — same shape as the dirty set.
    const refKey = editedLang
      ? `${translation._id}:${editedLang}:${editedRegister}`
      : null;
    // Prior baseline for `refKey`, captured before the optimistic overwrite so a
    // failed PUT can restore it (see catch).
    let refKeyHadBaseline = false;
    let priorBaseline: string | undefined;
    // Set in the success path when the cell diverged mid-flight — the freshest
    // row to re-save once the in-flight guard is released (see finally).
    let pendingResave: Translation | undefined;

    if (editedLang && refKey) {
      // Only guard when we have a baseline for this cell (set on focus / prior
      // save). Without one we can't prove "unchanged", so fall through and save.
      if (refKey in originalValueRef.current && savedValue === originalValueRef.current[refKey]) {
        return; // No-op: nothing changed → no PUT, no provenance change.
      }
      // ─── In-flight guard (double-PUT fix) ──────────────────────────────────
      // Ctrl+S calls this, then the blur it triggers calls it AGAIN before the
      // first PUT resolves. Because the baseline below is refreshed OPTIMISTICALLY
      // (and the response handler refreshes it again), the second call would
      // normally be caught by the no-op guard — but the optimistic refresh races
      // React's re-render of `translation`, so we also hard-block any concurrent
      // save for the same cell. Exactly one PUT fires per cell per in-flight
      // window; a genuine new edit after the PUT resolves still saves.
      //
      // BUT: a real NEW edit typed while the first PUT is still in flight must
      // not be silently dropped. The cell stays dirty (its dirty-set key is
      // still present), and when the in-flight save completes it detects the
      // divergence and AUTO RE-SAVES the newer value (see the success path).
      // So here we just skip starting a second concurrent PUT.
      if (inFlightSavesRef.current.has(refKey)) {
        return;
      }
      inFlightSavesRef.current.add(refKey);
      // Capture the prior baseline so we can roll it back if the PUT fails.
      refKeyHadBaseline = refKey in originalValueRef.current;
      priorBaseline = originalValueRef.current[refKey];
      // Refresh the no-op baseline OPTIMISTICALLY, at the START of the save, to
      // the value we're about to persist. An immediate second save for this
      // cell (same value) now sees value === baseline and is skipped, so Ctrl+S
      // then blur is one PUT, not two. If the PUT fails we roll the baseline
      // back in the catch so a retry still goes through.
      originalValueRef.current[refKey] = savedValue as string;
    }

    setSaving(translation._id);
    try {
      const res = await api.put(`/translations/${translation._id}`, {
        translations: translation.translations,
        context: translation.context,
        editedLang,
        editedRegister,
      });
      // Use the SERVER's canonical result for the cell's provenance instead of
      // hardcoding "human". On a regulated key, a non-owner edit is stamped
      // "pending" by the server (held for approval, NOT served by the SDK), so
      // stamping "human" locally would mislead the UI into showing a withheld
      // cell as live. The PUT returns the full saved translation; read the
      // actually-stored source from it. If the response somehow lacks it, fall
      // back to leaving the existing source as-is rather than assuming "human".
      const saved = res.data?.data as Translation | undefined;
      const serverSource = editedLang
        ? saved?.sources?.[editedLang]?.[editedRegister]
        : undefined;
      // Did a NEWER edit land on this cell while the PUT was in flight? We read
      // the LATEST value from state (the closure's `translation` is stale) inside
      // the updater below. If the live value still equals what we saved, the
      // save is current → safe to mark clean. If it diverged, the user typed
      // more; we must NOT clear the dirty flag (that would risk losing the newer
      // edit and, on a re-save, duplicate audit history).
      let cellIsStillSavedValue = true;
      // The freshest row for this key — captured from inside the updater (the
      // closure's `translation` is stale). Used to AUTO RE-SAVE the newer value
      // if the user edited the cell while this PUT was in flight.
      let latestRow: Translation | undefined;
      setTranslations((prev) =>
        prev.map((t) => {
          if (t._id !== translation._id) return t;
          latestRow = t;
          if (editedLang && savedValue !== undefined) {
            cellIsStillSavedValue =
              valueAt(t, editedLang, editedRegister) === savedValue;
          }
          const updatedSources = { ...(t.sources || {}) };
          // Only stamp the server's provenance when the cell hasn't changed
          // since the save — stamping it onto a newer, not-yet-saved value would
          // mislabel that pending edit as already-persisted.
          if (editedLang && serverSource && cellIsStillSavedValue) {
            updatedSources[editedLang] = {
              ...(updatedSources[editedLang] || {}),
              [editedRegister]: serverSource,
            };
          }
          // Mirror the row-level `source` from the server's saved doc when
          // present; never blindly hardcode "human".
          return { ...t, source: saved?.source ?? t.source, sources: updatedSources };
        })
      );
      if (editedLang && refKey) {
        // Refresh the no-op baseline to what was actually persisted. When the
        // cell is unchanged this matches the optimistic baseline set at the
        // start (harmless). When a NEWER edit landed mid-flight, the baseline is
        // still the just-saved value — so the next save sees current ≠ baseline
        // and persists the newer content (no lost edit), while THIS handler
        // leaves the dirty flag set below.
        originalValueRef.current[refKey] = savedValue as string;
      }
      // Only mark THIS cell clean when no newer edit landed mid-flight. A late
      // response must never clear another (or this) cell's unsaved state for
      // content the user has since changed. Per-cell AND per-register: pass the
      // register we ACTUALLY saved (`editedRegister`), NOT the currently-selected
      // one — if the user switched registers while this PUT was in flight, reading
      // the current register here would clear the wrong register's dirty key.
      if (editedLang && cellIsStillSavedValue) {
        markCellClean(translation._id, editedLang, editedRegister);
      } else if (editedLang && !cellIsStillSavedValue) {
        // A NEWER edit landed on this cell while the PUT was in flight (e.g. the
        // user kept typing, or a blur-save was dropped by the in-flight guard).
        // The cell is still dirty. Queue an AUTO RE-SAVE of the newer value so
        // the queued edit persists WITHOUT the user saving again. We do it in
        // `finally` (after the in-flight guard is released) so the re-invocation
        // isn't itself blocked as "concurrent".
        //
        // Loop guard: the baseline was just refreshed to `savedValue`, so the
        // re-save's own change-guard fires the PUT only while the live value
        // differs from what was last persisted. Once the value stops changing,
        // a re-save persists it once and the next pass is a no-op — no infinite
        // loop, the natural change-guard caps it.
        pendingResave = latestRow;
      }
      fetchStats();
    } catch (e) {
      // The PUT failed — the edit was NOT persisted. Keep the unsaved-changes
      // guard active and surface the failure so the user doesn't believe a lost
      // edit saved (silent data loss in a translation tool).
      const msg = getErrorMessage(e);
      console.error("Failed to save:", msg);
      // Roll the optimistic baseline back so a retry (blur/Ctrl+S) is NOT
      // mistaken for a no-op and actually re-attempts the save.
      if (refKey) {
        if (refKeyHadBaseline) {
          originalValueRef.current[refKey] = priorBaseline as string;
        } else {
          delete originalValueRef.current[refKey];
        }
      }
      // The edit was NOT persisted — keep THIS cell dirty so the leave guard
      // still warns (per-cell AND per-register: the register we tried to save,
      // not the currently-selected one, since the user may have switched).
      if (editedLang) markCellDirty(translation._id, editedLang, editedRegister);
      showToast(`Save failed — your edit was NOT saved: ${msg}`, "error");
    } finally {
      // Release the per-cell in-flight guard so the NEXT genuine edit can save.
      if (refKey) inFlightSavesRef.current.delete(refKey);
      // AUTO RE-SAVE the newer value if the cell changed while this PUT was in
      // flight. Done AFTER releasing the in-flight guard above so this re-invoke
      // isn't dropped as "concurrent". The re-save's change-guard (baseline now
      // === the just-persisted value) makes it a no-op once the value settles,
      // so this can't loop forever. Pass the SAVED register so the re-save targets
      // the same register even if the user switched the selector mid-flight.
      if (pendingResave && editedLang) {
        saveTranslation(pendingResave, editedLang, editedRegister);
      }
      setTimeout(() => setSaving(null), 600);
    }
  }

  // Approve or reject an AI translation for the currently selected register
  // of a given language. Reviewing in "casual" never touches "default".
  async function reviewTranslationRequest(
    translationId: string,
    lang: string,
    action: "approve" | "reject",
    register: Register = currentRegister
  ) {
    await api.post(`/translations/${translationId}/review`, {
      lang,
      action,
      register,
    });
  }

  async function reviewTranslation(translationId: string, lang: string, action: "approve" | "reject") {
    try {
      await reviewTranslationRequest(translationId, lang, action);
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
      (t) => strictValueAt(t, sourceLang, "default").trim() && !strictValueAt(t, lang, currentRegister).trim()
    ).length;
  }

  async function handleAITranslate() {
    if (!aiTargetLang) return;
    // Stale state can hold a value that's no longer in the user's
    // assignedLanguages (e.g. owner unassigned them while the modal was open).
    // Bail with a clear toast rather than firing a request the server will 403.
    if (!canEditLang(aiTargetLang)) {
      showToast(`You're not assigned to translate ${LANG_NAMES[aiTargetLang] || aiTargetLang}.`, "error");
      return;
    }
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
      fetchUsage();
    } catch (e) {
      showToast(getErrorMessage(e), "error");
      // A 429 means the monthly cap was hit — refresh the meter so it shows full.
      fetchUsage();
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

  // ─── Compliance audit (owner-only) ────────────────────────────

  // Open the compliance panel and load both the per-key trail and the roll-up
  // summary. Owner-only on the server; the button is also owner-gated, but a
  // 403 here just leaves the panel empty rather than throwing.
  async function openCompliance() {
    setShowCompliance(true);
    setComplianceLoading(true);
    try {
      const [auditRes, summaryRes] = await Promise.all([
        api.get(`/projects/${projectId}/compliance/audit`),
        api.get(`/projects/${projectId}/compliance/summary`),
      ]);
      setAuditKeys(auditRes.data.data.keys || []);
      setComplianceSummary(summaryRes.data.data);
    } catch (e) {
      setAuditKeys([]);
      setComplianceSummary(null);
      showToast(getErrorMessage(e), "error");
    } finally {
      setComplianceLoading(false);
    }
  }

  // Download the audit trail. JSON re-fetches the full object; CSV asks the
  // server for its flat one-row-per-event export (responseType "text" so axios
  // doesn't try to JSON-parse it). Both go through the existing blob helpers.
  async function exportAudit(format: "json" | "csv") {
    if (!project) return;
    setExportingAudit(true);
    try {
      if (format === "json") {
        const res = await api.get(`/projects/${projectId}/compliance/audit`);
        downloadJson(res.data.data, `${project.name}-compliance-audit.json`);
      } else {
        const res = await api.get(`/projects/${projectId}/compliance/audit`, {
          params: { format: "csv" },
          responseType: "text",
        });
        downloadBlob(
          res.data,
          `${project.name}-compliance-audit.csv`,
          "text/csv;charset=utf-8;"
        );
      }
      showToast(`Audit trail exported (${format.toUpperCase()})`);
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    } finally {
      setExportingAudit(false);
    }
  }

  // The most recent approver/author of a regulated key, for the row tooltip.
  // Prefers an approval event; falls back to the newest event overall.
  function lastApproverFor(key: string): { name: string; source: string } | null {
    const audit = auditKeys.find((k) => k.key === key);
    if (!audit || audit.history.length === 0) return null;
    const approval = audit.history.find((h) => h.source === "approved");
    const ev = approval || audit.history[0];
    return { name: ev.changedBy?.name || "Unknown", source: ev.source };
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

  // ─── Voice (IPA + SSML) ──────────────────────────────────────

  async function generateVoiceForLang(lang: string) {
    if (!projectId) return;
    if (!canEditLang(lang)) {
      showToast(`You're not assigned to translate ${LANG_NAMES[lang] || lang}.`, "error");
      return;
    }
    setGeneratingVoice(true);
    try {
      const res = await api.post(`/translations/${projectId}/generate-voice`, {
        lang,
        register: currentRegister,
      });
      const data = res.data.data;
      showToast(`Voice data generated for ${data.generated} key(s) in ${LANG_NAMES[lang] || lang} (${currentRegister})`);
      await fetchTranslations();
      fetchUsage();
    } catch (e) {
      showToast(getErrorMessage(e), "error");
      fetchUsage();
    } finally {
      setGeneratingVoice(false);
    }
  }

  // ─── Vertical Packs ──────────────────────────────────────────

  async function openPacksModal() {
    setShowPacks(true);
    setPacksLoading(true);
    try {
      const res = await api.get("/packs");
      setPacks(res.data.data);
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    } finally {
      setPacksLoading(false);
    }
  }

  async function importPack(code: string) {
    if (!projectId) return;
    setImportingPack(code);
    try {
      const res = await api.post(`/projects/${projectId}/import-pack`, { code });
      const data = res.data.data;
      const skippedNote = data.skippedLangs?.length
        ? ` (skipped ${data.skippedLangs.join(", ")} — not in this project)`
        : "";
      showToast(`${data.created} new + ${data.updated} updated${skippedNote}`);
      await fetchTranslations();
      await fetchStats();
      setShowPacks(false);
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    } finally {
      setImportingPack(null);
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
    setBatchProgress(`Translating ${missing} keys to ${LANG_NAMES[lang] || lang} (${currentRegister})...`);

    try {
      const res = await api.post(`/translations/${projectId}/ai-translate`, {
        targetLang: lang,
        register: currentRegister,
      });
      const data = res.data.data;
      setBatchProgress(`Done! ${data.translated} translations generated.`);
      showToast(`${data.translated} ${currentRegister} AI translations generated for ${LANG_NAMES[lang] || lang}`);

      // Refresh data
      await fetchTranslations();
      await fetchStats();
      fetchUsage();

      // Enter review queue mode
      setStatusFilter("ai-pending");
      setLangFilter(lang);
      setReviewQueueMode(true);
    } catch (e) {
      showToast(getErrorMessage(e), "error");
      setBatchProgress("");
      // 429 (cap hit) — refresh the meter so it reflects the spend.
      fetchUsage();
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

  // Capture the change-guard baseline for the focused cell, keyed by the cell's
  // register so the formal baseline never overwrites the default one for the same
  // (id, lang). English is always "default"; other langs use the active register.
  function handleCellFocus(translationId: string, lang: string, value: string) {
    const register = effectiveRegister(lang);
    originalValueRef.current[`${translationId}:${lang}:${register}`] = value;
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
      // Register-qualified key so the baseline read, the dirty-set clear, and the
      // skip-next-blur flag all reference the SAME cell as the focus/blur/save
      // paths — a Escape in "formal" must not touch the "default" cell's state.
      const register = effectiveRegister(lang);
      const refKey = `${translation._id}:${lang}:${register}`;
      const original = originalValueRef.current[refKey] ?? "";
      handleValueChange(translation._id, lang, original);
      // Escape reverts to the baseline → THIS cell is clean again. Clear only
      // its dirty key (handleValueChange above re-added it); other cells that
      // are still dirty must keep warning on leave.
      markCellClean(translation._id, lang, register);
      // The revert above is queued, not committed — so the blur this triggers
      // would otherwise save the still-edited closure value. Flag this cell so
      // the onBlur skips its save exactly once: Escape is a true cancel.
      skipNextBlurSaveRef.current = refKey;
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
  const isTranslator = myRole === "translator";
  // Translator's assigned languages from server. Owners ignore this list (they
  // can edit anything). Empty list for a translator means "no languages
  // assigned yet" — they get a read-only view until an owner assigns some.
  const assignedLangs = new Set<string>(project?.myAssignedLanguages || []);
  const canEditLang = (lang: string) => {
    if (isViewer) return false;
    if (isTranslator) return assignedLangs.has(lang);
    return true;
  };
  // Languages this user can actually take action on. Used to gate AI translate,
  // import, voice generation, and glossary editing so the dropdown only ever
  // contains options the server would accept — no more "select fr → 403".
  const editableLangs = (project?.supportedLanguages || []).filter(canEditLang);

  // The project's source/baseline language — the language other translations are
  // derived from (defaults to "en" if the project hasn't loaded yet). Importing
  // this is the setup action, so we always allow it regardless of role
  // assignment — a translator must be able to import the English baseline even
  // if they aren't "assigned" to it.
  const sourceLang = project?.defaultLanguage || "en";

  // Import dropdown options — editable languages PLUS the source/baseline
  // language (deduped), so the baseline is always importable.
  const importLangOptions = Array.from(new Set([...editableLangs, sourceLang]));
  const effectiveImportRegister: Register =
    importLang === "en" || importLang === sourceLang ? "default" : currentRegister;

  // ─── Import ──────────────────────────────────────────────────

  function openImportModal() {
    // Default to the source/baseline language when the current selection isn't a
    // valid option (e.g. the user can't edit the previously-selected language).
    if (!importLangOptions.includes(importLang)) {
      setImportLang(sourceLang);
    }
    setShowImport(true);
  }

  async function handleImport() {
    // Allow the source/baseline language regardless of assignment — it's the
    // setup action. Otherwise enforce the normal edit gate.
    if (importLang !== sourceLang && !canEditLang(importLang)) {
      showToast(`You're not assigned to translate ${LANG_NAMES[importLang] || importLang}.`, "error");
      return;
    }
    try {
      const data = JSON.parse(importJson);
      if (typeof data !== "object" || Array.isArray(data)) {
        showToast("JSON must be an object like { \"key\": \"value\" }", "error");
        return;
      }

      setImporting(true);

      // Bulk import targets a single (lang, register) cell. Use the active
      // register so the import lands where the user is currently editing.
      const res = await api.post(`/translations/${projectId}/bulk`, {
        lang: importLang,
        register: effectiveImportRegister,
        translations: data,
      });

      const result = res.data.data;
      showToast(result.message);
      if (Array.isArray(result.skippedKeys) && result.skippedKeys.length > 0) {
        const firstFive = result.skippedKeys.slice(0, 5);
        const suffix = result.skippedKeys.length > 5 ? ", ..." : "";
        showToast(`Skipped ${result.skipped} keys (${firstFive.join(", ")}${suffix})`, "info");
        console.warn("BhashaJS import skipped keys:", result.skippedKeys);
      }
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

  // Fetch the ENTIRE project (all pages) for export — the grid only holds one
  // page, so exporting the `translations` state would silently produce a
  // partial file presented as complete.
  async function fetchAllForExport(): Promise<Translation[]> {
    const all: Translation[] = [];
    const limit = 200; // server caps page size at 200
    let page = 1;
    for (;;) {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      const res = await api.get(`/translations/${projectId}?${params}`);
      const { data: items, pagination: pag } = res.data.data;
      all.push(...items);
      const total = pag?.total ?? all.length;
      if (all.length >= total || !items.length) break;
      page++;
    }
    return all;
  }

  // Export all languages combined — uses the currently active register.
  // Filename includes the register so a multi-register export doesn't clobber
  // a default-register one with the same name.
  async function exportAll() {
    if (!project) return;
    try {
      const rows = await fetchAllForExport();
      const exportData: Record<string, Record<string, string>> = Object.create(null);
      for (const lang of project.supportedLanguages) {
        exportData[lang] = Object.create(null);
        for (const t of rows) {
          const v = strictValueAt(t, lang, currentRegister);
          if (v) exportData[lang][t.key] = v;
        }
      }
      downloadJson(exportData, `${project.name}-${currentRegister}-all-translations.json`);
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    }
    setShowExport(false);
  }

  // Export a single language as flat JSON (this is what i18n libraries expect),
  // at the currently active register.
  async function exportLang(lang: string) {
    if (!project) return;
    try {
      const rows = await fetchAllForExport();
      const exportData: Record<string, string> = Object.create(null);
      for (const t of rows) {
        const v = strictValueAt(t, lang, currentRegister);
        if (v) exportData[t.key] = v;
      }
      downloadJson(exportData, `${project.name}-${lang}-${currentRegister}.json`);
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    }
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

  function csvField(raw: string): string {
    const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replace(/"/g, '""')}"`;
  }

  function androidResourceName(key: string): string {
    const name = key.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    return /^\d/.test(name) ? `_${name}` : name;
  }

  function escapeAndroidString(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, '\\"')
      .replace(/'/g, "\\'");
  }

  function escapeIOSString(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/"/g, '\\"');
  }

  // Export as CSV (all languages) at the active register.
  async function exportCSV() {
    if (!project) return;
    try {
      const allRows = await fetchAllForExport();
      const langs = project.supportedLanguages;
      const header = ["key", ...langs].map(csvField).join(",");
      const rows = allRows.map((t) => {
        const cols = [
          csvField(t.key),
          ...langs.map((lang) => {
            const val = strictValueAt(t, lang, currentRegister);
            return csvField(val);
          }),
        ];
        return cols.join(",");
      });
      downloadBlob([header, ...rows].join("\n"), `${project.name}-${currentRegister}-translations.csv`, "text/csv;charset=utf-8;");
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    }
    setShowExport(false);
  }

  // Export as Android XML (per language) at the active register.
  async function exportAndroidXML(lang: string) {
    if (!project) return;
    try {
      const rows = await fetchAllForExport();
      const lines = ['<?xml version="1.0" encoding="utf-8"?>', "<resources>"];
      for (const t of rows) {
        const val = strictValueAt(t, lang, currentRegister);
        if (!val) continue;
        const escaped = escapeAndroidString(val);
        const resName = androidResourceName(t.key);
        lines.push(`  <string name="${resName}">${escaped}</string>`);
      }
      lines.push("</resources>");
      downloadBlob(lines.join("\n"), `strings-${lang}-${currentRegister}.xml`, "application/xml");
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    }
    setShowExport(false);
  }

  // Export as iOS .strings (per language) at the active register.
  async function exportIOSStrings(lang: string) {
    if (!project) return;
    try {
      const rows = await fetchAllForExport();
      const lines = [`/* ${project.name} — ${lang} (${currentRegister}) */`, ""];
      for (const t of rows) {
        const val = strictValueAt(t, lang, currentRegister);
        if (!val) continue;
        if (t.context) lines.push(`/* ${t.context} */`);
        lines.push(`"${t.key}" = "${escapeIOSString(val)}";`);
        lines.push("");
      }
      downloadBlob(lines.join("\n"), `${lang}-${currentRegister}.strings`, "text/plain");
    } catch (e) {
      showToast(getErrorMessage(e), "error");
    }
    setShowExport(false);
  }

  // ─── Helpers ─────────────────────────────────────────────────

  // Count missing translations for a key at the active register.
  function missingCount(translation: Translation): number {
    if (!project) return 0;
    return project.supportedLanguages.filter(
      (lang) => !strictValueAt(translation, lang, currentRegister).trim()
    ).length;
  }

  // Filter translations by search query + status + language. All checks operate
  // on the active register (so "untranslated" in casual mode means
  // "casual variant missing", not "default missing").
  //
  // KNOWN LIMITATION (out of scope): status filters and the missing-counts only
  // inspect the currently-loaded page of translations, not the whole project.
  // Proper status filtering would need server-side support; not done here.
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
        const src = strictSourceAt(t, langFilter, currentRegister);
        if (statusFilter === "untranslated" && strictValueAt(t, langFilter, currentRegister).trim()) return false;
        if (statusFilter === "ai-pending" && src !== "ai") return false;
        if (statusFilter === "approved" && src !== "approved") return false;
      } else {
        // Apply across all languages at the active register
        if (statusFilter === "untranslated") {
          const hasMissing = project?.supportedLanguages.some(
            (lang) => lang !== sourceLang && !strictValueAt(t, lang, currentRegister).trim()
          );
          if (!hasMissing) return false;
        } else if (statusFilter === "ai-pending") {
          const hasAI = project?.supportedLanguages.some((lang) => strictSourceAt(t, lang, currentRegister) === "ai");
          if (!hasAI) return false;
        } else if (statusFilter === "approved") {
          const hasApproved = project?.supportedLanguages.some((lang) => strictSourceAt(t, lang, currentRegister) === "approved");
          if (!hasApproved) return false;
        }
      }
    } else if (langFilter !== "all") {
      // Language-only filter: show keys missing this language at the active register
      if (strictValueAt(t, langFilter, currentRegister).trim()) return false;
    }
    return true;
  });
  const approveAllTargets =
    reviewQueueMode && langFilter !== "all"
      ? filtered.filter((t) => strictSourceAt(t, langFilter, currentRegister) === "ai")
      : [];

  async function approveAllAITranslations() {
    if (langFilter === "all" || approveAllTargets.length === 0) return;
    const lang = langFilter;
    const register = currentRegister;
    const targets = [...approveAllTargets];
    const total = targets.length;
    if (!window.confirm(`Approve all ${total} AI translations for ${LANG_NAMES[lang] || lang}?`)) {
      return;
    }

    setApproveAllRunning(true);
    let succeeded = 0;
    try {
      for (const t of targets) {
        setApproveAllProgress(`Approving ${succeeded + 1}/${total}...`);
        await reviewTranslationRequest(t._id, lang, "approve", register);
        succeeded++;
      }
      showToast(`Approved ${succeeded} AI translations`);
    } catch (e) {
      showToast(`Approve all stopped after ${succeeded}/${total}: ${getErrorMessage(e)}`, "error");
    } finally {
      await fetchTranslations();
      await fetchStats();
      setApproveAllRunning(false);
      setApproveAllProgress("");
    }
  }

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
          {/* Logo first so it's always visible top-left as the "home" anchor;
              Back button next for one-step navigation. Both lead to /projects
              but the logo follows the convention people expect. */}
          <Link to="/projects" className="logo-link" aria-label="Go to projects home">
            <h1 className="logo-small">भाषा<span>JS</span></h1>
          </Link>
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
          {/* Unsaved indicator — driven by the PER-CELL dirty set (size > 0),
              not a single global flag. Visible whenever ANY cell is dirty, so a
              concurrent save of one cell can't make it disappear while another
              cell still has unsaved edits. */}
          {hasUnsaved && (
            <span className="unsaved-indicator" data-testid="unsaved-indicator" title="You have unsaved changes">
              Unsaved changes
            </span>
          )}
          {!isViewer && (
            <button className="btn-ai" onClick={openAIModal}>
              <Sparkles size={16} />
              AI Translate
            </button>
          )}
          {myRole === "owner" && (
            <button className="btn-ghost" onClick={openPacksModal} title="Browse curated translation packs for regulated verticals">
              <BookOpen size={16} />
              Packs
            </button>
          )}
          {myRole === "owner" && (
            <button
              className="btn-ghost"
              onClick={openCompliance}
              title="Auditable compliance trail for regulated keys — who approved what, when, against which citation"
            >
              <Shield size={16} />
              Compliance
            </button>
          )}
          {!isViewer && (
            <button
              className={`btn-ghost ${voiceMode ? "active" : ""}`}
              onClick={() => setVoiceMode((v) => !v)}
              title="Toggle voice mode — show IPA phonetic transcription under each cell"
            >
              {voiceMode ? "Voice ON" : "Voice"}
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
            <button className="btn-ghost" onClick={openImportModal}>
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
            {/* TM coverage — visible signal of the flywheel. Every approved
                AI translation increments this. Above the threshold, the corpus
                is large enough to seed register-aware fine-tuning of a small
                open model. We surface progress as a number, not a gate. */}
            {tmCoverage && tmCoverage.total > 0 && (
              <div
                className="stat-item tm-coverage"
                title={`Translation Memory has ${tmCoverage.total} verified pair${
                  tmCoverage.total === 1 ? "" : "s"
                }. At ~${tmCoverage.fineTunableThreshold} per (language, register) cell this corpus becomes useful for fine-tuning a custom translator.`}
                style={{ marginLeft: "auto", opacity: 0.85 }}
              >
                <span className="stat-lang">TM</span>
                <span className="stat-pct">
                  {tmCoverage.total.toLocaleString()} pair
                  {tmCoverage.total === 1 ? "" : "s"}
                </span>
              </div>
            )}
            {/* AI usage this month vs the project's monthly cap. The bar turns
                amber as it nears the cap and red at/over it so the cost ceiling
                is visible right where AI translate is triggered. */}
            {aiUsage && aiUsage.cap > 0 && (
              <div
                className="stat-item ai-usage"
                title={`AI usage this month (${aiUsage.period}): ${aiUsage.keysTranslated.toLocaleString()} of ${aiUsage.cap.toLocaleString()} keys. Translate/voice are blocked once the cap is reached; it resets next month.`}
                style={{ marginLeft: tmCoverage && tmCoverage.total > 0 ? undefined : "auto" }}
              >
                <span className="stat-lang">AI</span>
                <div className="stat-progress">
                  <div
                    className="stat-progress-fill"
                    style={{
                      width: `${aiUsage.percentUsed}%`,
                      background:
                        aiUsage.percentUsed >= 100
                          ? "#ef4444"
                          : aiUsage.percentUsed >= 80
                          ? "#f59e0b"
                          : undefined,
                    }}
                  />
                </div>
                <span className="stat-pct">
                  {aiUsage.keysTranslated.toLocaleString()} / {aiUsage.cap.toLocaleString()}
                </span>
              </div>
            )}
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
              placeholder="Search keys..."
              value={searchQuery}
              onChange={(e) => {
                const val = e.target.value;
                setSearchQuery(val);
                clearTimeout(searchDebounceRef.current);
                searchDebounceRef.current = setTimeout(() => {
                  setCurrentPage(1);
                  // Pass the CURRENT input value explicitly — the `searchQuery`
                  // state captured in fetchTranslations' closure is the previous
                  // term, so without this the query would lag one keystroke.
                  fetchTranslations(1, false, val);
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

        {/* ─── Voice Mode Bar ─────────────────────────────────────── */}
        {/* Shown only when voice mode is on. Fires AI generation for missing
            IPA/SSML cells in the currently selected register, one language at
            a time. Existing voice data is preserved unless explicitly overwritten. */}
        {voiceMode && project && !isViewer && (
          <div className="voice-bar">
            <span className="voice-bar-label">Generate voice for:</span>
            {editableLangs.length === 0 ? (
              <span className="voice-bar-status">No languages assigned to you yet.</span>
            ) : (
              editableLangs.map((lang) => (
                <button
                  key={lang}
                  className="voice-gen-btn"
                  onClick={() => generateVoiceForLang(lang)}
                  disabled={generatingVoice}
                  title={`Generate IPA + SSML for ${LANG_NAMES[lang] || lang} (${currentRegister})`}
                >
                  {LANG_NAMES[lang] || lang}
                </button>
              ))
            )}
            {generatingVoice && <span className="voice-bar-status">Generating…</span>}
          </div>
        )}

        {/* ─── Register Switcher ─────────────────────────────────── */}
        {/* Three registers per language: Default, Formal, Casual.
            Switching here re-renders every cell at the chosen register and
            scopes saves/AI/import to that register. English is always read at
            "default" since English has no formal/casual variants. */}
        <div className="register-bar">
          <span className="register-bar-label">Register:</span>
          <div className="register-tabs" role="tablist">
            {REGISTERS.map((reg) => (
              <button
                key={reg}
                role="tab"
                aria-selected={currentRegister === reg}
                title={REGISTER_HINTS[reg]}
                className={`register-tab ${currentRegister === reg ? "active" : ""}`}
                onClick={() => {
                  if (hasUnsaved) {
                    if (!window.confirm("You have unsaved changes — switch register anyway?")) return;
                  }
                  setCurrentRegister(reg);
                }}
              >
                {REGISTER_LABELS[reg]}
              </button>
            ))}
          </div>
          <span className="register-hint">{REGISTER_HINTS[currentRegister]}</span>
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
                <span className="form-hint">Letters, numbers, dots, underscores, and hyphens; must start with a letter or number</span>
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

        {/* ─── Vertical Packs Modal ───────────────────────────── */}
        {showPacks && (
          <div className="modal-overlay" onClick={() => !importingPack && setShowPacks(false)}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header-row">
                <h3>
                  <BookOpen size={18} style={{ verticalAlign: "middle", marginRight: 8 }} />
                  Vertical Packs
                </h3>
                <button className="btn-icon" onClick={() => !importingPack && setShowPacks(false)}>
                  <X size={18} />
                </button>
              </div>
              <p className="form-hint" style={{ marginBottom: "1rem" }}>
                Curated translation packs for regulated verticals — fintech KYC, insurance,
                pharma, government UI. Importing fills empty cells with vetted phrasing;
                your existing translations are never overwritten.
              </p>
              {packsLoading ? (
                <p>Loading packs...</p>
              ) : packs.length === 0 ? (
                <p className="text-muted">No packs available yet.</p>
              ) : (
                <div className="packs-list">
                  {packs.map((p) => (
                    <div key={p._id} className="pack-card">
                      <div className="pack-card-header">
                        <h4 className="pack-name">{p.name}</h4>
                        <div className="pack-badges">
                          {p.regulator && <span className="pack-badge pack-badge-regulator">{p.regulator}</span>}
                          {p.jurisdiction && <span className="pack-badge">{p.jurisdiction}</span>}
                          {p.isSample && <span className="pack-badge pack-badge-sample">Sample — review before prod use</span>}
                        </div>
                      </div>
                      <p className="pack-description">{p.description}</p>
                      <div className="pack-meta">
                        <span><strong>Languages:</strong> {p.languages.map((l) => LANG_NAMES[l] || l).join(", ")}</span>
                        <span><strong>Registers:</strong> {p.registers.join(", ")}</span>
                        <span><strong>Vertical:</strong> {p.vertical}</span>
                      </div>
                      <div className="pack-actions">
                        <button
                          className="btn-primary"
                          onClick={() => importPack(p.code)}
                          disabled={!!importingPack}
                        >
                          {importingPack === p.code ? "Importing..." : "Import"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── Compliance Audit Modal (owner-only) ────────────── */}
        {showCompliance && (
          <div className="modal-overlay" onClick={() => setShowCompliance(false)}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header-row">
                <h3>
                  <Shield size={18} style={{ verticalAlign: "middle", marginRight: 8 }} />
                  Compliance Audit
                </h3>
                <button className="btn-icon" onClick={() => setShowCompliance(false)}>
                  <X size={18} />
                </button>
              </div>
              <p className="form-hint" style={{ marginBottom: "1rem" }}>
                Auditable trail of every regulated key — who approved which copy,
                when, and against which regulator citation. Export it as evidence
                for your compliance review.
              </p>

              {/* Summary banner. Two honest states, not one: review-clean is
                  the lock guarantee (no unreviewed copy serves) and is distinct
                  from fully approved (review-clean AND every language complete).
                  A key can be review-clean yet not fully translated. */}
              {complianceSummary && (
                <div className="compliance-summary">
                  <div className="compliance-stat">
                    <span className="compliance-stat-num">{complianceSummary.total}</span>
                    <span className="compliance-stat-label">Regulated keys</span>
                  </div>
                  <div
                    className="compliance-stat compliance-stat-ok"
                    title="No unreviewed (AI/pending) copy can serve — the lock guarantee. May still be missing languages."
                  >
                    <span className="compliance-stat-num">{complianceSummary.reviewClean}</span>
                    <span className="compliance-stat-label">Review-clean</span>
                  </div>
                  <div
                    className="compliance-stat compliance-stat-ok"
                    title="Review-clean AND every supported language approved in the default register."
                  >
                    <span className="compliance-stat-num">{complianceSummary.fullyApproved}</span>
                    <span className="compliance-stat-label">Fully approved</span>
                  </div>
                  <div
                    className="compliance-stat compliance-stat-pending"
                    title="Has unreviewed (AI/pending) copy that would not serve under the lock."
                  >
                    <span className="compliance-stat-num">{complianceSummary.withUnreviewed}</span>
                    <span className="compliance-stat-label">Need review</span>
                  </div>
                </div>
              )}

              {/* Export actions */}
              <div className="compliance-export-bar">
                <button
                  className="btn-ghost"
                  onClick={() => exportAudit("json")}
                  disabled={exportingAudit}
                >
                  <Download size={14} /> Export audit trail (JSON)
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => exportAudit("csv")}
                  disabled={exportingAudit}
                >
                  <Download size={14} /> Export audit trail (CSV)
                </button>
              </div>

              {/* Per-key list */}
              {complianceLoading ? (
                <p>Loading compliance trail…</p>
              ) : auditKeys.length === 0 ? (
                <p className="text-muted">
                  No regulated keys yet. Lock a key (toggle “regulated” with a
                  citation) to start an audit trail.
                </p>
              ) : (
                <div className="compliance-list">
                  {auditKeys.map((k) => {
                    const approval = k.history.find((h) => h.source === "approved");
                    const lastEvent = approval || k.history[0];
                    return (
                      <div key={k.key} className="compliance-card">
                        <div className="compliance-card-header">
                          <code className="key-name">
                            <span style={{ marginRight: "0.4em" }} aria-hidden>🔒</span>
                            {k.key}
                          </code>
                          {/* Two distinct states. Review-clean = the lock
                              guarantee (no unreviewed copy serves). Fully
                              approved = review-clean AND every language
                              complete. We never label a review-clean-but-
                              incomplete key "Fully approved" — that would
                              imply an English-only regulated key is done. */}
                          <span className="compliance-badge-group">
                            <span
                              className={`compliance-badge ${
                                k.reviewClean
                                  ? "compliance-badge-ok"
                                  : "compliance-badge-pending"
                              }`}
                              title="No unreviewed (AI/pending) copy can serve under the lock."
                            >
                              {k.reviewClean ? "Review-clean" : "Needs review"}
                            </span>
                            <span
                              className={`compliance-badge ${
                                k.fullyApproved
                                  ? "compliance-badge-ok"
                                  : "compliance-badge-pending"
                              }`}
                              title="Review-clean AND every supported language approved in the default register."
                            >
                              {k.fullyApproved ? "Fully approved" : "Incomplete"}
                            </span>
                          </span>
                        </div>
                        {/* The key insight: review-clean ≠ fully translated.
                            When clean but not complete, name the gap so the
                            owner doesn't read "Review-clean" as "shippable". */}
                        {k.reviewClean && !k.complete && k.missingLanguages.length > 0 && (
                          <p className="compliance-missing">
                            Review-clean, but missing:{" "}
                            {k.missingLanguages
                              .map((l) => LANG_NAMES[l] || l)
                              .join(", ")}
                          </p>
                        )}
                        {k.mandatedBy && (
                          <p className="compliance-citation">
                            <strong>Citation:</strong> {k.mandatedBy}
                          </p>
                        )}
                        <div className="compliance-statuses">
                          {k.statuses.length === 0 ? (
                            <span className="text-muted">No localized cells yet.</span>
                          ) : (
                            k.statuses.map((s, i) => (
                              <span
                                key={`${s.lang}-${s.register}-${i}`}
                                className={`compliance-cell-badge compliance-cell-${s.status}`}
                                title={`${LANG_NAMES[s.lang] || s.lang} · ${s.register}: ${s.status}`}
                              >
                                {LANG_NAMES[s.lang] || s.lang}/{s.register}: {s.status}
                              </span>
                            ))
                          )}
                        </div>
                        {lastEvent && (
                          <p className="compliance-last-approver">
                            Last {lastEvent.source} by{" "}
                            <strong>{lastEvent.changedBy?.name || "Unknown"}</strong>
                            {lastEvent.changedBy?.email ? ` (${lastEvent.changedBy.email})` : ""}
                            {" · "}
                            {new Date(lastEvent.createdAt).toLocaleString()}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
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
                  {editableLangs
                    .filter((l) => l !== "en")
                    .map((lang) => (
                      <option key={lang} value={lang}>
                        {LANG_NAMES[lang] || lang}
                      </option>
                    ))}
                </select>
                {editableLangs.filter((l) => l !== "en").length === 0 && (
                  <span className="form-hint">
                    You don't have any non-English languages assigned to translate.
                    Ask the project owner to assign you in Team settings.
                  </span>
                )}
              </div>
              {aiTargetLang && (
                <div className="ai-modal-info">
                  <span className="info-count">{missingForLang(aiTargetLang)}</span>
                  <span className="info-text">
                    keys with English text but missing {LANG_NAMES[aiTargetLang] || aiTargetLang}{" "}
                    <strong>{REGISTER_LABELS[currentRegister]}</strong> translation.
                    AI will generate them in the <strong>{currentRegister}</strong> register
                    — {REGISTER_HINTS[currentRegister].toLowerCase()}.
                    Switch the register tab on the editor to target a different one.
                  </span>
                </div>
              )}
              {aiUsage && aiUsage.cap > 0 && (
                <div
                  className="form-hint"
                  style={{
                    color: aiUsage.percentUsed >= 100 ? "#ef4444" : undefined,
                  }}
                >
                  AI usage this month: {aiUsage.keysTranslated.toLocaleString()} /{" "}
                  {aiUsage.cap.toLocaleString()} keys
                  {aiUsage.percentUsed >= 100
                    ? " — monthly cap reached, resets next month."
                    : "."}
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
                  {importLangOptions.map((lang) => (
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
                  Imports the <strong>{REGISTER_LABELS[effectiveImportRegister]}</strong> register
                  for {LANG_NAMES[importLang] || importLang}.{" "}
                  {effectiveImportRegister === "default" && (importLang === "en" || importLang === sourceLang)
                    ? "Source-language imports always use Default."
                    : "Switch the register tab above to import elsewhere."}
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
                                  disabled={!canEditLang(lang)}
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
              {approveAllRunning
                ? approveAllProgress
                : `Review Queue - ${approveAllTargets.length} AI translations for ${LANG_NAMES[langFilter] || langFilter}`}
            </span>
            <div className="review-queue-actions">
              <button
                className="btn-review-approve"
                onClick={approveAllAITranslations}
                disabled={approveAllRunning || approveAllTargets.length === 0 || langFilter === "all"}
              >
                <Check size={14} /> Approve all ({approveAllTargets.length})
              </button>
              <button className="btn-ghost" onClick={exitReviewQueue} disabled={approveAllRunning}>
                <X size={14} /> Exit Review
              </button>
            </div>
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
                      <code className="key-name">
                        {t.regulated && (() => {
                          // Surface the regulator citation + last approver (from
                          // the loaded audit data, if the owner has opened the
                          // Compliance panel this session) in the tooltip, not
                          // just a bare lock. Owners can click to open the trail.
                          const approver = lastApproverFor(t.key);
                          const base = t.mandatedBy
                            ? `Compliance lock — ${t.mandatedBy}.`
                            : "Compliance lock —";
                          const approverNote = approver
                            ? ` Last ${approver.source} by ${approver.name}.`
                            : "";
                          const tip = `${base}${approverNote} AI drafts on this key are NOT served by the SDK until an owner approves them.${isOwner ? " Click to open the audit trail." : ""}`;
                          return (
                            <span
                              className="regulated-lock"
                              title={tip}
                              style={{ marginRight: "0.4em", cursor: isOwner ? "pointer" : "help" }}
                              aria-label="regulated"
                              onClick={isOwner ? openCompliance : undefined}
                            >
                              🔒
                            </span>
                          );
                        })()}
                        {t.key}
                      </code>
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
                      const langSource = strictSourceAt(t, lang, langRegister);
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
                              onBlur={() => {
                                // If Escape just cancelled this cell, its revert
                                // is still queued (not committed), so saving now
                                // would persist the cancelled value. Skip exactly
                                // this one save and clear the flag. Register-
                                // qualified to match the key the Escape handler set.
                                const refKey = `${t._id}:${lang}:${langRegister}`;
                                if (skipNextBlurSaveRef.current === refKey) {
                                  skipNextBlurSaveRef.current = null;
                                  setCellFocused(false);
                                  return;
                                }
                                // saveTranslation owns the "did it actually
                                // change?" guard now (comparing against
                                // originalValueRef), so EVERY save path — blur,
                                // Ctrl+S, future callers — skips the PUT and the
                                // provenance stamp when nothing changed. We just
                                // ask it to save; it no-ops on an unchanged cell.
                                saveTranslation(t, lang);
                                setCellFocused(false);
                              }}
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
                            {/* Voice mode: show IPA underneath each cell. SSML is hover-only
                                (too noisy to render inline). Empty IPA = "not generated yet". */}
                            {voiceMode && cellValue && (() => {
                              const v = voiceAt(t, lang, langRegister);
                              return (
                                <div
                                  className={`voice-row ${v?.ipa ? "" : "voice-empty"}`}
                                  title={v?.ssml || "No SSML generated yet"}
                                >
                                  {v?.ipa || "— not generated —"}
                                </div>
                              );
                            })()}
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
                        {reviewQueueMode && langFilter !== "all" && strictSourceAt(t, langFilter, currentRegister) === "ai" && (
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
                                    {(isOwner || c.userId?._id === userId) && (
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
