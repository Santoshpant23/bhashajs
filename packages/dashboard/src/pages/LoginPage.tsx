/**
 * Login Page
 * 
 * Simple email/password form.
 * On success, redirects to /projects.
 * Uses the consistent error format from the API.
 */

import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { getErrorMessage } from "../utils/api";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Honor ?redirect= so an invite link can route through login and back to /join.
  const redirect = searchParams.get("redirect");
  const safeRedirect = redirect && redirect.startsWith("/") ? redirect : "/projects";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate(safeRedirect);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <h1 className="logo">भाषा<span>JS</span></h1>
          <p className="auth-subtitle">Sign in to your dashboard</p>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <p className="auth-footer">
          Don't have an account?{" "}
          <Link to={redirect ? `/register?redirect=${encodeURIComponent(redirect)}` : "/register"}>
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
