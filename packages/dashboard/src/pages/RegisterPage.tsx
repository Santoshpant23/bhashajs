/**
 * Register Page
 * 
 * Name/email/password form for creating a new account.
 * On success, redirects to /projects.
 */

import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { getErrorMessage } from "../utils/api";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { register } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Allow JoinPage to round-trip through register and back: /register?redirect=/join?token=...
  // Restrict to internal paths so an attacker can't craft an open-redirect URL.
  const redirect = searchParams.get("redirect");
  const safeRedirect = redirect && redirect.startsWith("/") ? redirect : "/projects";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await register(name, email, password);
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
          <p className="auth-subtitle">Create your account</p>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              required
            />
          </div>
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
              placeholder="At least 6 characters"
              required
              minLength={6}
            />
          </div>
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? "Creating account..." : "Create Account"}
          </button>
        </form>

        <p className="auth-footer">
          Already have an account?{" "}
          <Link to={redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : "/login"}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
