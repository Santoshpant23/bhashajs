/**
 * Join Page — Accept a team invite
 *
 * URL: /join?token=xxx
 * If logged in: calls accept-invite API, redirects to project.
 * If not logged in: shows login/register links (preserving token).
 */

import { useState, useEffect } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import api, { getErrorMessage } from "../utils/api";

export default function JoinPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const navigate = useNavigate();
  const { isLoggedIn } = useAuth();

  const [status, setStatus] = useState<"loading" | "success" | "error" | "needsAuth">("loading");
  const [message, setMessage] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("No invite token found. Please check your invite link.");
      return;
    }

    if (!isLoggedIn) {
      setStatus("needsAuth");
      return;
    }

    acceptInvite();
  }, [token, isLoggedIn]);

  async function acceptInvite() {
    try {
      const res = await api.post("/team/accept-invite", { token });
      const data = res.data.data;
      setStatus("success");
      setMessage(`You've joined "${data.projectName}" as ${data.role}!`);
      setProjectId(data.projectId);
    } catch (e) {
      setStatus("error");
      setMessage(getErrorMessage(e));
    }
  }

  if (!token) {
    return (
      <div className="join-page">
        <div className="join-card">
          <h2>Invalid Invite</h2>
          <p>No invite token found. Please check your invite link.</p>
          <Link to="/login" className="btn-primary">Go to Login</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="join-page">
      <div className="join-card">
        <h1 className="join-logo">भाषाJS</h1>

        {status === "loading" && <p>Accepting invite...</p>}

        {status === "needsAuth" && (
          <>
            <h2>You've been invited!</h2>
            <p>Log in or create an account to accept this invite.</p>
            <div className="join-actions">
              <Link to={`/login?redirect=/join?token=${token}`} className="btn-primary">
                Log In
              </Link>
              <Link to={`/register?redirect=/join?token=${token}`} className="btn-ghost">
                Create Account
              </Link>
            </div>
          </>
        )}

        {status === "success" && (
          <>
            <h2>Welcome to the team!</h2>
            <p>{message}</p>
            <button
              className="btn-primary"
              onClick={() => navigate(`/projects/${projectId}`)}
            >
              Open Project
            </button>
          </>
        )}

        {status === "error" && (
          <>
            <h2>Something went wrong</h2>
            <p className="error-text">{message}</p>
            <Link to="/projects" className="btn-primary">Go to Projects</Link>
          </>
        )}
      </div>
    </div>
  );
}
