/**
 * Projects Page
 *
 * Lists all projects the user has access to (as owner, translator, or viewer).
 * Create new projects with language selection.
 * Edit project settings and manage team members (owner only).
 * Delete projects with confirmation (owner only).
 */

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
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
} from "lucide-react";

interface Project {
  _id: string;
  name: string;
  defaultLanguage: string;
  supportedLanguages: string[];
  apiKey?: string;
  createdAt: string;
  myRole?: string; // "owner" | "translator" | "viewer"
}

interface TeamMember {
  _id: string;
  email: string;
  role: string;
  assignedLanguages: string[];
  status: string;
  userId?: { _id: string; name: string; email: string };
  invitedBy?: { name: string };
}

// Language code → display name mapping for South Asian languages
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

  // Team management state
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("translator");
  const [inviteLangs, setInviteLangs] = useState<string[]>([]);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [teamLoading, setTeamLoading] = useState(false);

  // API key state
  const [apiKeyCopied, setApiKeyCopied] = useState(false);
  const [regeneratingKey, setRegeneratingKey] = useState(false);

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
    setSettingsTab("settings");
    setShowSettings(true);
    setInviteLink(null);
    setInviteEmail("");
    setInviteRole("translator");
    setInviteLangs([]);
    fetchTeam(project._id);
  }

  async function saveSettings() {
    if (!editingProject || !editName.trim()) return;
    try {
      await api.put(`/projects/${editingProject._id}`, {
        name: editName,
        supportedLanguages: editLangs,
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
          <h1 className="logo-small">भाषा<span>JS</span></h1>
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
                  <div className="api-key-usage">
                    <h4>Quick Start</h4>
                    <pre className="code-block">{`npm install bhasha-js`}</pre>
                    <pre className="code-block">{`import { I18nProvider } from "bhasha-js";

<I18nProvider
  projectKey="${editingProject.apiKey || "bjs_your_key_here"}"
  apiUrl="${window.location.origin}/api"
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
