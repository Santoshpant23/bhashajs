/**
 * API Utility
 * 
 * Centralized axios instance that:
 * - Automatically attaches JWT token to every request
 * - Redirects to login on 401 (expired token)
 * - Extracts data from the { success, data } wrapper
 */

import axios from "axios";

const api = axios.create({
  baseURL: "/api",
});

// Attach token before every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("bhashajs_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle 401 responses globally
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem("bhashajs_token");
      localStorage.removeItem("bhashajs_userId");
      window.location.href = "/login";
    }
    return Promise.reject(error);
  }
);

/**
 * Helper to extract the error message from our API's error format.
 * Our API always returns { success: false, message: "..." } on errors.
 */
export function getErrorMessage(error: any): string {
  return error?.response?.data?.message || "Something went wrong";
}

export default api;
