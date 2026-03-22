/**
 * Validation Helper Utility
 * 
 * Reusable validation functions for common checks.
 * Returns error message string if invalid, or null if valid.
 */

import mongoose from "mongoose";

/** Check if a string field is present and not just whitespace */
export function validateRequired(value: any, fieldName: string): string | null {
  if (!value || (typeof value === "string" && !value.trim())) {
    return `${fieldName} is required`;
  }
  return null;
}

/** Check if a string is a valid email format */
export function validateEmail(email: string): string | null {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return "Invalid email format";
  }
  return null;
}

/** Check if a password meets minimum length */
export function validatePassword(password: string, minLength = 6): string | null {
  if (!password || password.length < minLength) {
    return `Password must be at least ${minLength} characters`;
  }
  return null;
}

/** Check if a string is a valid MongoDB ObjectId */
export function validateObjectId(id: string, fieldName: string): string | null {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return `Invalid ${fieldName}`;
  }
  return null;
}

/** Check if an array has at least one item */
export function validateArrayNotEmpty(arr: any, fieldName: string): string | null {
  if (!Array.isArray(arr) || arr.length === 0) {
    return `${fieldName} must have at least one item`;
  }
  return null;
}

/**
 * Run multiple validations and return the first error found.
 * Usage: const error = validateAll(
 *   () => validateRequired(name, "Name"),
 *   () => validateEmail(email),
 * );
 */
export function validateAll(...checks: (() => string | null)[]): string | null {
  for (const check of checks) {
    const error = check();
    if (error) return error;
  }
  return null;
}
