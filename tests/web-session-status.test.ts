import { expect, test } from "bun:test";
import { displaySessionStatus } from "../web/client/session-status.ts";

test("only dormant terminal sessions are labeled inactive", () => {
	expect(displaySessionStatus({ source: "web", status: "offline" })).toBe("idle");
	expect(displaySessionStatus({ source: "saved", status: "offline" })).toBe("inactive");
	expect(displaySessionStatus({ source: "tui", status: "offline" })).toBe("inactive");
	expect(displaySessionStatus({ source: "web", status: "working" })).toBe("working");
});
