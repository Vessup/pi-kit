import type { WebSession } from "../protocol";

export type DisplaySessionStatus = Exclude<WebSession["status"], "offline"> | "inactive";

/** Browser-owned sessions are daemon-managed and remain logically idle while their RPC runtime restores. */
export function displaySessionStatus(session: Pick<WebSession, "source" | "status">): DisplaySessionStatus {
	if (session.status !== "offline") return session.status;
	return session.source === "web" ? "idle" : "inactive";
}
