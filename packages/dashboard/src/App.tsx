/**
 * App Component
 * 
 * Root component that sets up routing and auth context.
 * ProtectedRoute: redirects to /login if not authenticated.
 * PublicRoute: redirects to /projects if already logged in.
 */

import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { NotificationProvider } from "./context/NotificationContext";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ProjectsPage from "./pages/ProjectsPage";
import TranslationEditor from "./pages/TranslationEditor";
import DemoPage from "./pages/DemoPage";
import JoinPage from "./pages/JoinPage";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isLoggedIn } = useAuth();
  if (!isLoggedIn) return <Navigate to="/login" />;
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
    const safe = redirect && redirect.startsWith("/") ? redirect : "/projects";
    return <Navigate to={safe} replace />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<PublicRoute><LoginPage /></PublicRoute>} />
      <Route path="/register" element={<PublicRoute><RegisterPage /></PublicRoute>} />
      <Route path="/projects" element={<ProtectedRoute><ProjectsPage /></ProtectedRoute>} />
      <Route path="/projects/:projectId" element={<ProtectedRoute><TranslationEditor /></ProtectedRoute>} />
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
