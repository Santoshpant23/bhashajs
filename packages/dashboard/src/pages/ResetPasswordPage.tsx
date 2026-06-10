import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import api, { getErrorMessage } from "../utils/api";

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    setError("");
    if (!token) {
      setError("Invalid or expired reset link");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);
    try {
      const res = await api.post("/auth/reset-password", { token, password });
      setMessage(res.data.data.message);
      setPassword("");
      setConfirm("");
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
          <p className="auth-subtitle">Choose a new password</p>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {message && <div className="success-banner">{message}</div>}

        {!message ? (
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>New password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                required
                minLength={6}
              />
            </div>
            <div className="form-group">
              <label>Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Re-enter password"
                required
                minLength={6}
              />
            </div>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? "Resetting..." : "Reset password"}
            </button>
          </form>
        ) : (
          <Link to="/login" className="btn-primary">Sign in</Link>
        )}
      </div>
    </div>
  );
}
