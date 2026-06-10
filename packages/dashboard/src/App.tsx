/**
 * App Component
 * 
 * Root component that sets up routing and auth context.
 * ProtectedRoute: redirects to /login if not authenticated.
 * PublicRoute: redirects to /projects if already logged in.
 */

import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { NotificationProvider } from "./context/NotificationContext";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import ProjectsPage from "./pages/ProjectsPage";
import TranslationEditor from "./pages/TranslationEditor";
import DemoPage from "./pages/DemoPage";
import JoinPage from "./pages/JoinPage";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isLoggedIn } = useAuth();
  const location = useLocation();
  if (!isLoggedIn) {
    const redirect = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?redirect=${redirect}`} replace />;
  }
  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isLoggedIn } = useAuth();
  const location = useLocation();
  if (isLoggedIn) {
    // If the URL carries ?redirect=/something, send the already-logged-in user there
    // instead of bouncing them to /projects (matters for invite flows).
    const params = new URLSearchParams(location.search);
    const redirect = params.get("redirect");
    // Only allow a same-origin path: must start with a SINGLE "/" and not be
    // followed by "/" or "\" (which would make it a protocol-relative URL like
    // "//evil.com" or "/\evil.com" — an open redirect). Otherwise go to /projects.
    const safe = redirect && /^\/(?![/\\])/.test(redirect) ? redirect : "/projects";
    return <Navigate to={safe} replace />;
  }
  return <>{children}</>;
}

function ProjectEditorRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  return <TranslationEditor key={projectId} />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<PublicRoute><LoginPage /></PublicRoute>} />
      <Route path="/register" element={<PublicRoute><RegisterPage /></PublicRoute>} />
      <Route path="/forgot-password" element={<PublicRoute><ForgotPasswordPage /></PublicRoute>} />
      <Route path="/reset-password" element={<PublicRoute><ResetPasswordPage /></PublicRoute>} />
      <Route path="/projects" element={<ProtectedRoute><ProjectsPage /></ProtectedRoute>} />
      <Route path="/projects/:projectId" element={<ProtectedRoute><ProjectEditorRoute /></ProtectedRoute>} />
      <Route path="/join" element={<JoinPage />} />
      <Route path="/demo" element={<DemoPage />} />
      <Route path="*" element={<Navigate to="/login" />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <NotificationProvider>
          <AppRoutes />
        </NotificationProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
