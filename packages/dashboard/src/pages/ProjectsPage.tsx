/**
 * Projects Page
 *
 * Lists all projects the user has access to (as owner, translator, or viewer).
 * Create new projects with language selection.
 * Edit project settings and manage team members (owner only).
 * Delete projects with confirmation (owner only).
 */

import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import api, { getErrorMessage } from "../utils/api";
import {
  Plus,
  Trash2,
  Globe,
  ChevronRight,
  LogOut,
  Settings,
  User,
  Users,
  Copy,
  X,
  Key,
  RefreshCw,
  Check,
  Plus as PlusIcon,
  Ban,
} from "lucide-react";

interface Project {
  _id: string;
  name: string;
  defaultLanguage: string;
  supportedLanguages: string[];
  apiKey?: string;
  vertical?: string | null;
  aiMonthlyCap?: number;
  createdAt: string;
  myRole?: string; // "owner" | "translator" | "viewer"
}

// Current-period AI usage for the project open in Settings.
interface AiUsage {
  period: string;
  cap: number;
  keysTranslated: number;
  voiceCalls: number;
  aiCalls: number;
  percentUsed: number;
}

// Vertical options shown in project settings. The values match the keys in
// the server-side VERTICAL_GUIDE (services/ai-provider.ts) — keep in sync.
const VERTICAL_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "", label: "None", hint: "No domain bias — translations stay generic" },
  { value: "fintech", label: "Fintech / Banking", hint: "RBI / SBP / Bangladesh Bank tone, KYC vocabulary" },
  { value: "insurance", label: "Insurance", hint: "IRDAI tone, formal policy-holder language" },
  { value: "health", label: "Health / Pharma", hint: "Patient-friendly, consent-explicit phrasing" },
  { value: "ecommerce", label: "E-commerce", hint: "Conversion-friendly, casual register encouraged" },
  { value: "gov", label: "Government", hint: "Formal, neutral, official vocabulary" },
  { value: "edtech", label: "EdTech", hint: "Student-friendly, encouraging, clear" },
];

interface TeamMember {
  _id: string;
  email: string;
  role: string;
  assignedLanguages: string[];
  status: string;
  userId?: { _id: string; name: string; email: string };
  invitedBy?: { name: string };
}

// A scoped SDK key as returned by GET /projects/:id/keys — always masked,
// never the raw secret. The full secret is only seen once, at creation.
interface ScopedKey {
  id: string;
  name: string;
  maskedKey: string;
  readOnly: boolean;
  allowedOrigins: string[];
  revoked: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

// Language code → display name mapping for South Asian languages.
// Native scripts first, then Latin-script (Romanized) variants.
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
  // Latin-script variants
  "hi-Latn": "Hinglish",
  "ne-Latn": "Roman Nepali",
  "ur-Latn": "Roman Urdu",
  "bn-Latn": "Banglish",
  "pa-Latn": "Roman Punjabi",
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create modal state
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [selectedLangs, setSelectedLangs] = useState<string[]>(["en", "hi"]);

  // Settings modal state
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"settings" | "team" | "api-key">("settings");
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editName, setEditName] = useState("");
  const [editLangs, setEditLangs] = useState<string[]>([]);
  const [editVertical, setEditVertical] = useState<string>("");
  // AI usage for the project open in Settings (read-only meter).
  const [settingsUsage, setSettingsUsage] = useState<AiUsage | null>(null);

  // Team management state
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("translator");
  const [inviteLangs, setInviteLangs] = useState<string[]>([]);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [teamLoading, setTeamLoading] = useState(false);

  // API key state (legacy single key)
  const [apiKeyCopied, setApiKeyCopied] = useState(false);
  const [regeneratingKey, setRegeneratingKey] = useState(false);

  // Scoped API keys state
  const [scopedKeys, setScopedKeys] = useState<ScopedKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyOrigins, setNewKeyOrigins] = useState("");
  const [newKeyReadOnly, setNewKeyReadOnly] = useState(true);
  const [creatingKey, setCreatingKey] = useState(false);
  // The full secret of a just-created key — shown ONCE, then dismissed.
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  const { logout, userName } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    fetchProjects();
  }, []);

  async function fetchProjects() {
    try {
      const res = await api.get("/projects");
      setProjects(res.data.data);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  // ─── Create Project ──────────────────────────────────────────
  async function createProject() {
    if (!newName.trim()) return;
    try {
      await api.post("/projects", {
        name: newName,
        supportedLanguages: selectedLangs,
        defaultLanguage: "en",
      });
      setNewName("");
      setShowCreate(false);
      setSelectedLangs(["en", "hi"]);
      fetchProjects();
    } catch (e) {
      alert(getErrorMessage(e));
    }
  }

  // ─── Delete Project ──────────────────────────────────────────
  async function deleteProject(id: string) {
    if (!window.confirm("Delete this project and ALL its translations? This cannot be undone.")) return;
    try {
      await api.delete(`/projects/${id}`);
      fetchProjects();
    } catch (e) {
      alert(getErrorMessage(e));
    }
  }

  // ─── Settings + Team ──────────────────────────────────────────
  function openSettings(project: Project, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingProject(project);
    setEditName(project.name);
    setEditLangs([...project.supportedLanguages]);
    setEditVertical(project.vertical || "");
    setSettingsTab("settings");
    setShowSettings(true);
    setInviteLink(null);
    setInviteEmail("");
    setInviteRole("translator");
    setInviteLangs([]);
    // Reset + load scoped keys for the API Key tab.
    setScopedKeys([]);
    setCreatedSecret(null);
    setNewKeyName("");
    setNewKeyOrigins("");
    setNewKeyReadOnly(true);
    setSettingsUsage(null);
    fetchTeam(project._id);
    fetchScopedKeys(project._id);
    fetchSettingsUsage(project._id);
  }

  async function fetchSettingsUsage(id: string) {
    try {
      const res = await api.get(`/projects/${id}/usage`);
      const data = res.data.data;
      if (data && typeof data.keysTranslated === "number") setSettingsUsage(data);
    } catch (e) {
      // Older servers won't have this endpoint — the meter just won't render.
    }
  }

  async function saveSettings() {
    if (!editingProject || !editName.trim()) return;
    try {
      await api.put(`/projects/${editingProject._id}`, {
        name: editName,
        supportedLanguages: editLangs,
        vertical: editVertical, // empty string clears the tag server-side
      });
      setShowSettings(false);
      setEditingProject(null);
      fetchProjects();
    } catch (e) {
      alert(getErrorMessage(e));
    }
  }

  // ─── Team Management ──────────────────────────────────────────
  async function fetchTeam(projectId: string) {
    setTeamLoading(true);
    try {
      const res = await api.get(`/projects/${projectId}/team`);
      setTeamMembers(res.data.data);
    } catch (e) {
      console.error("Failed to fetch team:", getErrorMessage(e));
    } finally {
      setTeamLoading(false);
    }
  }

  async function sendInvite() {
    if (!editingProject || !inviteEmail.trim()) return;
    try {
      const res = await api.post(`/projects/${editingProject._id}/team/invite`, {
        email: inviteEmail.trim(),
        role: inviteRole,
        assignedLanguages: inviteLangs,
      });
      const data = res.data.data;
      setInviteLink(`${window.location.origin}${data.inviteLink}`);
      setInviteEmail("");
      fetchTeam(editingProject._id);
    } catch (e) {
      alert(getErrorMessage(e));
    }
  }

  async function removeMember(memberId: string) {
    if (!editingProject) return;
    if (!window.confirm("Remove this team member?")) return;
    try {
      await api.delete(`/projects/${editingProject._id}/team/${memberId}`);
      fetchTeam(editingProject._id);
    } catch (e) {
      alert(getErrorMessage(e));
    }
  }

  function copyInviteLink() {
    if (inviteLink) {
      navigator.clipboard.writeText(inviteLink);
      alert("Invite link copied!");
    }
  }

  // ─── API Key ────────────────────────────────────────────────
  function copyApiKey() {
    if (editingProject?.apiKey) {
      navigator.clipboard.writeText(editingProject.apiKey);
      setApiKeyCopied(true);
      setTimeout(() => setApiKeyCopied(false), 2000);
    }
  }

  async function regenerateApiKey() {
    if (!editingProject) return;
    if (!window.confirm("Regenerate API key? The old key will stop working immediately.")) return;
    setRegeneratingKey(true);
    try {
      const res = await api.post(`/projects/${editingProject._id}/regenerate-key`);
      const newKey = res.data.data.apiKey;
      setEditingProject({ ...editingProject, apiKey: newKey });
      // Also update in the projects list
      setProjects((prev) =>
        prev.map((p) => (p._id === editingProject._id ? { ...p, apiKey: newKey } : p))
      );
    } catch (e) {
      alert(getErrorMessage(e));
    } finally {
      setRegeneratingKey(false);
    }
  }

  // ─── Scoped API Keys ─────────────────────────────────────────
  async function fetchScopedKeys(projectId: string) {
    setKeysLoading(true);
    try {
      const res = await api.get(`/projects/${projectId}/keys`);
      setScopedKeys(res.data.data);
    } catch (e) {
      console.error("Failed to fetch API keys:", getErrorMessage(e));
    } finally {
      setKeysLoading(false);
    }
  }

  async function createScopedKey() {
    if (!editingProject || !newKeyName.trim()) return;
    setCreatingKey(true);
    try {
      // Split the comma/space/newline-separated origin allowlist into hosts;
      // the server normalizes full URLs → bare hostnames.
      const allowedOrigins = newKeyOrigins
        .split(/[\s,]+/)
        .map((o) => o.trim())
        .filter(Boolean);
      const res = await api.post(`/projects/${editingProject._id}/keys`, {
        name: newKeyName.trim(),
        allowedOrigins,
        readOnly: newKeyReadOnly,
      });
      // Surface the full secret ONCE; the list view only ever shows it masked.
      setCreatedSecret(res.data.data.key);
      setSecretCopied(false);
      setNewKeyName("");
      setNewKeyOrigins("");
      setNewKeyReadOnly(true);
      fetchScopedKeys(editingProject._id);
    } catch (e) {
      alert(getErrorMessage(e));
    } finally {
      setCreatingKey(false);
    }
  }

  async function revokeScopedKey(keyId: string) {
    if (!editingProject) return;
    if (!window.confirm("Revoke this key? Apps using it will stop working immediately.")) return;
    try {
      await api.post(`/projects/${editingProject._id}/keys/${keyId}/revoke`);
      fetchScopedKeys(editingProject._id);
    } catch (e) {
      alert(getErrorMessage(e));
    }
  }

  function copyCreatedSecret() {
    if (createdSecret) {
      navigator.clipboard.writeText(createdSecret);
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    }
  }

  // ─── Language Toggle Helper ──────────────────────────────────
  function toggleLang(lang: string, setter: React.Dispatch<React.SetStateAction<string[]>>) {
    if (lang === "en") return;
    setter((prev) =>
      prev.includes(lang) ? prev.filter((l) => l !== lang) : [...prev, lang]
    );
  }

  const roleBadgeClass = (role: string) => {
    if (role === "owner") return "role-badge role-owner";
    if (role === "translator") return "role-badge role-translator";
    return "role-badge role-viewer";
  };

  return (
    <div className="page-container">
      {/* ─── Header ─────────────────────────────────────────── */}
      <header className="page-header">
        <div className="header-left">
          {/* Logo doubles as a "home" link — clicking returns to /projects.
              On the projects page itself this is a no-op refresh, but the
              affordance keeps users from feeling stranded on sub-pages. */}
          <Link to="/projects" className="logo-link" aria-label="Go to projects home">
            <h1 className="logo-small">भाषा<span>JS</span></h1>
          </Link>
        </div>
        <div className="header-actions">
          {userName && (
            <span className="user-greeting">
              <User size={16} />
              {userName}
            </span>
          )}
          <button className="btn-ghost" onClick={logout}>
            <LogOut size={18} />
            Sign out
          </button>
        </div>
      </header>

      <main className="page-main">
        {/* ─── Title Row ──────────────────────────────────────── */}
        <div className="page-title-row">
          <div>
            <h2 className="page-title">Your Projects</h2>
            <p className="page-desc">Manage your internationalization projects</p>
          </div>
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={18} />
            New Project
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {/* ─── Create Project Modal ───────────────────────────── */}
        {showCreate && (
          <div className="modal-overlay" onClick={() => setShowCreate(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>Create New Project</h3>
              <div className="form-group">
                <label>Project Name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="My Website"
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>Languages</label>
                <div className="lang-grid">
                  {Object.entries(LANG_NAMES).map(([code, name]) => (
                    <button
                      key={code}
                      className={`lang-chip ${selectedLangs.includes(code) ? "active" : ""} ${code === "en" ? "locked" : ""}`}
                      onClick={() => toggleLang(code, setSelectedLangs)}
                    >
                      {name}
                      <span className="lang-code">{code}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
                <button className="btn-primary" onClick={createProject}>Create Project</button>
              </div>
            </div>
          </div>
        )}

        {/* ─── Settings + Team Modal ──────────────────────────── */}
        {showSettings && editingProject && (
          <div className="modal-overlay" onClick={() => setShowSettings(false)}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header-row">
                <h3>{editingProject.name}</h3>
                <button className="btn-icon" onClick={() => setShowSettings(false)}>
                  <X size={18} />
                </button>
              </div>

              {/* Tab bar */}
              <div className="modal-tabs">
                <button
                  className={`modal-tab ${settingsTab === "settings" ? "active" : ""}`}
                  onClick={() => setSettingsTab("settings")}
                >
                  <Settings size={14} /> Settings
                </button>
                <button
                  className={`modal-tab ${settingsTab === "team" ? "active" : ""}`}
                  onClick={() => setSettingsTab("team")}
                >
                  <Users size={14} /> Team
                </button>
                <button
                  className={`modal-tab ${settingsTab === "api-key" ? "active" : ""}`}
                  onClick={() => setSettingsTab("api-key")}
                >
                  <Key size={14} /> API Key
                </button>
              </div>

              {/* Settings Tab */}
              {settingsTab === "settings" && (
                <>
                  <div className="form-group">
                    <label>Project Name</label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="form-group">
                    <label>Languages</label>
                    <div className="lang-grid">
                      {Object.entries(LANG_NAMES).map(([code, name]) => (
                        <button
                          key={code}
                          className={`lang-chip ${editLangs.includes(code) ? "active" : ""} ${code === "en" ? "locked" : ""}`}
                          onClick={() => toggleLang(code, setEditLangs)}
                        >
                          {name}
                          <span className="lang-code">{code}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Vertical / Domain</label>
                    <select
                      value={editVertical}
                      onChange={(e) => setEditVertical(e.target.value)}
                      className="vertical-select"
                    >
                      {VERTICAL_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <span className="form-hint">
                      {VERTICAL_OPTIONS.find((o) => o.value === editVertical)?.hint ||
                        "Tagging your project gives the AI translator domain-specific guidance and unlocks the matching vertical packs."}
                    </span>
                  </div>
                  {/* AI usage this month vs the monthly cap (read-only). AI
                      translate/voice are blocked with a 429 once the cap is hit. */}
                  {settingsUsage && settingsUsage.cap > 0 && (
                    <div className="form-group">
                      <label>AI usage this month ({settingsUsage.period})</label>
                      <div className="stat-progress" style={{ height: 8 }}>
                        <div
                          className="stat-progress-fill"
                          style={{
                            width: `${settingsUsage.percentUsed}%`,
                            background:
                              settingsUsage.percentUsed >= 100
                                ? "#ef4444"
                                : settingsUsage.percentUsed >= 80
                                ? "#f59e0b"
                                : undefined,
                          }}
                        />
                      </div>
                      <span className="form-hint">
                        {settingsUsage.keysTranslated.toLocaleString()} /{" "}
                        {settingsUsage.cap.toLocaleString()} keys translated.
                        {settingsUsage.percentUsed >= 100
                          ? " Monthly cap reached — resets next month."
                          : " AI translate is blocked once the cap is reached."}
                      </span>
                    </div>
                  )}
                  <div className="modal-actions">
                    <button className="btn-ghost" onClick={() => setShowSettings(false)}>Cancel</button>
                    <button className="btn-primary" onClick={saveSettings}>Save Changes</button>
                  </div>
                </>
              )}

              {/* API Key Tab */}
              {settingsTab === "api-key" && (
                <div className="api-key-tab">
                  <p className="api-key-desc">
                    Use this API key in your app's SDK to fetch translations.
                    Pass it as the <code>projectKey</code> prop in <code>&lt;I18nProvider&gt;</code>.
                  </p>
                  <div className="api-key-box">
                    <code className="api-key-value">
                      {editingProject.apiKey || "No key generated"}
                    </code>
                    <button
                      className="btn-icon"
                      onClick={copyApiKey}
                      title="Copy API key"
                    >
                      {apiKeyCopied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                  <div className="api-key-actions">
                    <button
                      className="btn-ghost btn-sm"
                      onClick={regenerateApiKey}
                      disabled={regeneratingKey}
                    >
                      <RefreshCw size={14} className={regeneratingKey ? "spin" : ""} />
                      {regeneratingKey ? "Regenerating..." : "Regenerate Key"}
                    </button>
                  </div>

                  {/* ─── Scoped, rotatable keys ──────────────────── */}
                  <div className="scoped-keys">
                    <h4>Scoped API Keys</h4>
                    <p className="api-key-desc">
                      Create additional keys you can revoke independently, lock to
                      specific origins, and mark read-only — without rotating the key
                      above. The full secret is shown only once at creation.
                    </p>

                    {/* One-time secret reveal after creation */}
                    {createdSecret && (
                      <div className="new-key-reveal">
                        <div className="new-key-reveal-head">
                          <span>New key — copy it now, it won't be shown again.</span>
                          <button
                            className="btn-icon"
                            onClick={() => setCreatedSecret(null)}
                            title="Dismiss"
                          >
                            <X size={14} />
                          </button>
                        </div>
                        <div className="api-key-box">
                          <code className="api-key-value">{createdSecret}</code>
                          <button
                            className="btn-icon"
                            onClick={copyCreatedSecret}
                            title="Copy key"
                          >
                            {secretCopied ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Create form */}
                    <div className="new-key-form">
                      <div className="invite-row">
                        <input
                          type="text"
                          value={newKeyName}
                          onChange={(e) => setNewKeyName(e.target.value)}
                          placeholder="Key name (e.g. Production web)"
                          className="invite-email"
                        />
                        <button
                          className="btn-primary btn-sm"
                          onClick={createScopedKey}
                          disabled={creatingKey || !newKeyName.trim()}
                        >
                          <PlusIcon size={14} />
                          {creatingKey ? "Creating..." : "Create key"}
                        </button>
                      </div>
                      <input
                        type="text"
                        value={newKeyOrigins}
                        onChange={(e) => setNewKeyOrigins(e.target.value)}
                        placeholder="Allowed origins (optional, comma-separated, e.g. app.example.com)"
                        className="new-key-origins"
                      />
                      <label className="new-key-readonly">
                        <input
                          type="checkbox"
                          checked={newKeyReadOnly}
                          onChange={(e) => setNewKeyReadOnly(e.target.checked)}
                        />
                        Read-only
                      </label>
                    </div>

                    {/* Keys list (masked) */}
                    <div className="scoped-keys-list">
                      {keysLoading ? (
                        <p className="text-muted">Loading...</p>
                      ) : scopedKeys.length === 0 ? (
                        <p className="text-muted">No scoped keys yet.</p>
                      ) : (
                        scopedKeys.map((k) => (
                          <div
                            key={k.id}
                            className={`scoped-key-row ${k.revoked ? "revoked" : ""}`}
                          >
                            <div className="scoped-key-info">
                              <span className="scoped-key-name">{k.name}</span>
                              <code className="scoped-key-masked">{k.maskedKey}</code>
                              <div className="scoped-key-meta">
                                {k.readOnly && <span className="key-tag">read-only</span>}
                                {k.allowedOrigins.length > 0 && (
                                  <span className="key-tag">
                                    {k.allowedOrigins.join(", ")}
                                  </span>
                                )}
                                {k.revoked && <span className="key-tag revoked">revoked</span>}
                                <span className="key-meta-muted">
                                  {k.lastUsedAt
                                    ? `Last used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                                    : "Never used"}
                                </span>
                              </div>
                            </div>
                            {!k.revoked && (
                              <button
                                className="btn-icon-danger"
                                onClick={() => revokeScopedKey(k.id)}
                                title="Revoke key"
                              >
                                <Ban size={14} />
                              </button>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="api-key-usage">
                    <h4>Quick Start</h4>
                    <pre className="code-block">{`npm install bhasha-js`}</pre>
                    <pre className="code-block">{`import { I18nProvider } from "bhasha-js";

<I18nProvider
  projectKey="${editingProject.apiKey || "bjs_your_key_here"}"
  defaultLang="en"
>
  <App />
</I18nProvider>`}</pre>
                  </div>
                </div>
              )}

              {/* Team Tab */}
              {settingsTab === "team" && (
                <div className="team-tab">
                  {/* Invite Form */}
                  <div className="team-invite-form">
                    <h4>Invite a Member</h4>
                    <div className="invite-row">
                      <input
                        type="email"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        placeholder="email@example.com"
                        className="invite-email"
                      />
                      <select
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value)}
                        className="invite-role-select"
                      >
                        <option value="translator">Translator</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <button className="btn-primary btn-sm" onClick={sendInvite}>
                        Invite
                      </button>
                    </div>
                    {inviteRole === "translator" && (
                      <div className="invite-langs">
                        <label>Assigned languages:</label>
                        <div className="lang-grid lang-grid-sm">
                          {editingProject.supportedLanguages
                            .filter((l) => l !== "en")
                            .map((code) => (
                              <button
                                key={code}
                                className={`lang-chip lang-chip-sm ${inviteLangs.includes(code) ? "active" : ""}`}
                                onClick={() => toggleLang(code, setInviteLangs)}
                              >
                                {LANG_NAMES[code] || code}
                              </button>
                            ))}
                        </div>
                      </div>
                    )}
                    {inviteLink && (
                      <div className="invite-link-box">
                        <span className="invite-link-text">{inviteLink}</span>
                        <button className="btn-icon" onClick={copyInviteLink} title="Copy link">
                          <Copy size={14} />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Members List */}
                  <div className="team-members-list">
                    <h4>Members</h4>
                    {teamLoading ? (
                      <p className="text-muted">Loading...</p>
                    ) : teamMembers.length === 0 ? (
                      <p className="text-muted">No team members yet.</p>
                    ) : (
                      teamMembers.map((m) => (
                        <div key={m._id} className="team-member-row">
                          <div className="member-info">
                            <span className="member-name">
                              {m.userId?.name || m.email}
                            </span>
                            {m.status === "pending" && (
                              <span className="pending-badge">Pending</span>
                            )}
                            <span className={roleBadgeClass(m.role)}>{m.role}</span>
                            {m.assignedLanguages.length > 0 && (
                              <span className="member-langs">
                                ({m.assignedLanguages.map((l) => LANG_NAMES[l] || l).join(", ")})
                              </span>
                            )}
                          </div>
                          {m.role !== "owner" && (
                            <button
                              className="btn-icon-danger"
                              onClick={() => removeMember(m._id)}
                              title="Remove member"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── Projects List ──────────────────────────────────── */}
        {loading ? (
          <div className="empty-state">Loading...</div>
        ) : projects.length === 0 ? (
          <div className="empty-state">
            <Globe size={48} strokeWidth={1} />
            <h3>No projects yet</h3>
            <p>Create your first project to start translating</p>
          </div>
        ) : (
          <div className="projects-grid">
            {projects.map((project) => {
              const isOwner = project.myRole === "owner";
              return (
                <div
                  key={project._id}
                  className="project-card"
                  onClick={() => navigate(`/projects/${project._id}`)}
                >
                  <div className="project-card-top">
                    <div className="project-card-title-row">
                      <h3>{project.name}</h3>
                      {project.myRole && (
                        <span className={roleBadgeClass(project.myRole)}>
                          {project.myRole}
                        </span>
                      )}
                    </div>
                    <div className="project-card-actions">
                      {isOwner && (
                        <>
                          <button
                            className="btn-icon"
                            onClick={(e) => openSettings(project, e)}
                            title="Project settings"
                          >
                            <Settings size={16} />
                          </button>
                          <button
                            className="btn-icon-danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteProject(project._id);
                            }}
                            title="Delete project"
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="project-card-langs">
                    {project.supportedLanguages.map((lang) => (
                      <span key={lang} className="lang-badge">
                        {LANG_NAMES[lang] || lang}
                      </span>
                    ))}
                  </div>
                  <div className="project-card-footer">
                    <span className="project-date">
                      Created {new Date(project.createdAt).toLocaleDateString()}
                    </span>
                    <ChevronRight size={16} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
