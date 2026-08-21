import type { SessionSort } from "./session-utils";

export const SESSION_ORDER_KEY = "pi-web-session-order-v1";
export const SESSION_SORT_KEY = "pi-web-session-sort-v1";
export const COLLAPSED_PROJECTS_KEY = "pi-web-collapsed-projects-v1";
export const LAST_SESSION_KEY = "pi-web-last-session-v1";

export function loadSessionOrder(): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(SESSION_ORDER_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function loadSessionSort(): SessionSort {
  try {
    const value = localStorage.getItem(SESSION_SORT_KEY);
    return value === "oldest" || value === "custom" ? value : "newest";
  } catch {
    return "newest";
  }
}

export function loadCollapsedProjects(): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(COLLAPSED_PROJECTS_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function loadLastSessionId(): string | null {
  try {
    const value = localStorage.getItem(LAST_SESSION_KEY);
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

export function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are best-effort when browser storage is denied or full.
  }
}

export function hashSessionId(): string | null {
  const match = window.location.hash.match(/#\/sessions\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function setHashSessionId(sessionId: string): void {
  window.location.hash = `#/sessions/${encodeURIComponent(sessionId)}`;
}
