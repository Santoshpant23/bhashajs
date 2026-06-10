/**
 * Auth Context
 * 
 * Provides authentication state and methods to the entire app.
 * Any component can call useAuth() to get login/register/logout.
 * Token is stored in localStorage so it persists across refreshes.
 */

import { createContext, useContext, useState, ReactNode } from "react";
import api from "../utils/api";

interface AuthContextType {
  isLoggedIn: boolean;
  userId: string | null;
  userName: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

function getStoredItem(key: string): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isLoggedIn, setIsLoggedIn] = useState(
    () => !!getStoredItem("bhashajs_token") && !!getStoredItem("bhashajs_userId")
  );
  const [userId, setUserId] = useState<string | null>(() =>
    getStoredItem("bhashajs_token") ? getStoredItem("bhashajs_userId") : null
  );
  const [userName, setUserName] = useState<string | null>(() =>
    getStoredItem("bhashajs_token") ? getStoredItem("bhashajs_userName") : null
  );

  async function login(email: string, password: string) {
    // API returns { success: true, data: { token, userId, name } }
    const res = await api.post("/auth/login", { email, password });
    const { token, userId, name } = res.data.data;
    localStorage.setItem("bhashajs_token", token);
    localStorage.setItem("bhashajs_userId", userId);
    localStorage.setItem("bhashajs_userName", name);
    setIsLoggedIn(true);
    setUserId(userId);
    setUserName(name);
  }

  async function register(name: string, email: string, password: string) {
    const res = await api.post("/auth/register", { name, email, password });
    const { token, userId, name: userName } = res.data.data;
    localStorage.setItem("bhashajs_token", token);
    localStorage.setItem("bhashajs_userId", userId);
    localStorage.setItem("bhashajs_userName", userName);
    setIsLoggedIn(true);
    setUserId(userId);
    setUserName(userName);
  }

  function logout() {
    // Best-effort server-side revocation: bumps the user's tokenVersion so this
    // token (and any other sessions) stops verifying. Fire it BEFORE clearing
    // localStorage so the request still carries the token; don't block the UI.
    api.post("/auth/logout").catch(() => {
      /* revocation is best-effort — the client clears its token regardless */
    });
    localStorage.removeItem("bhashajs_token");
    localStorage.removeItem("bhashajs_userId");
    localStorage.removeItem("bhashajs_userName");
    setIsLoggedIn(false);
    setUserId(null);
    setUserName(null);
  }

  return (
    <AuthContext.Provider value={{ isLoggedIn, userId, userName, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// Custom hook — any component can access auth state
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
