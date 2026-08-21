import {
  compareWebSessions,
  orderWebSessions,
  type WebSession,
} from "../protocol";
import { displaySessionStatus } from "./session-status";

export type SessionSort = "newest" | "oldest" | "custom";

export function sessionStatusClasses(session: WebSession): string {
  return `semantic-session-status is-${displaySessionStatus(session)}`;
}

export function sessionStatusLabel(session: WebSession): string {
  return displaySessionStatus(session);
}

export function sessionTitle(session: WebSession): string {
  return (
    session.name?.trim() ||
    session.preview?.trim() ||
    session.file?.split("/").pop() ||
    session.id.slice(0, 8)
  );
}

export function sessionDirectory(session: WebSession): string {
  return session.cwd
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~");
}

export function sessionSubtitle(session: WebSession): string {
  const directory = sessionDirectory(session);
  return session.branch ? `${directory} · ${session.branch}` : directory;
}

export function sessionMatches(session: WebSession, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    sessionTitle(session),
    session.cwd,
    session.branch,
    session.projectName,
    session.model,
    session.selectedModel,
    session.lastModel,
    session.status,
    sessionStatusLabel(session),
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

export function sortSessions(sessions: WebSession[]): WebSession[] {
  return [...sessions].sort(compareWebSessions);
}

export function sortSessionsForSidebar(
  sessions: WebSession[],
  sort: SessionSort,
  customOrder: readonly string[],
): WebSession[] {
  if (sort === "custom") return orderWebSessions(sessions, customOrder);
  if (sort === "newest") return sortSessions(sessions);
  return [...sessions].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}
