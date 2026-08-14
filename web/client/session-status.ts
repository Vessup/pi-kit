import { hasActiveWebSubagents, type WebSession } from "../protocol";

export type DisplaySessionStatus = Exclude<WebSession["status"], "offline"> | "inactive";

export function hasActiveSessionWork(session: Pick<WebSession, "status" | "subagents">): boolean {
	return session.status === "working" || hasActiveWebSubagents(session.subagents);
}

export function displaySessionStatus(session: Pick<WebSession, "source" | "status" | "subagents">): DisplaySessionStatus {
	if (session.status === "idle" && hasActiveSessionWork(session)) return "working";
	return session.status === "offline" ? "inactive" : session.status;
}
