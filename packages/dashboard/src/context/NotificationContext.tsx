/**
 * Notification Context
 *
 * Provides in-app notifications with 30s polling.
 * Bell icon and dropdown consume this via useNotifications().
 */

import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import api from "../utils/api";
import { useAuth } from "./AuthContext";

interface AppNotification {
  _id: string;
  type: string;
  message: string;
  projectId?: string;
  read: boolean;
  createdAt: string;
}

interface NotificationContextType {
  unreadCount: number;
  notifications: AppNotification[];
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  refresh: () => void;
}

const NotificationContext = createContext<NotificationContextType | null>(null);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { isLoggedIn } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  async function fetchNotifications() {
    try {
      const res = await api.get("/notifications");
      setNotifications(res.data.data.notifications);
      setUnreadCount(res.data.data.unreadCount);
    } catch {
      // non-critical
    }
  }

  useEffect(() => {
    if (!isLoggedIn) return;
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30_000);
    return () => clearInterval(interval);
  }, [isLoggedIn]);

  async function markRead(id: string) {
    try {
      await api.put(`/notifications/${id}/read`);
      fetchNotifications();
    } catch { /* ignore */ }
  }

  async function markAllRead() {
    try {
      await api.put("/notifications/read-all");
      fetchNotifications();
    } catch { /* ignore */ }
  }

  return (
    <NotificationContext.Provider
      value={{ unreadCount, notifications, markRead, markAllRead, refresh: fetchNotifications }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be inside NotificationProvider");
  return ctx;
}
