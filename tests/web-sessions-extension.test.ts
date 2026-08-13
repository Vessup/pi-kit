import { expect, test } from "bun:test";
import { isScopedModelAllowed } from "../extensions/web-sessions.ts";

test("web model selection honors the session model scope", () => {
	const scoped = [
		{ model: { provider: "anthropic", id: "allowed" } },
		{ model: { provider: "openai", id: "also-allowed" } },
	];
	expect(isScopedModelAllowed(scoped, "anthropic", "allowed")).toBe(true);
	expect(isScopedModelAllowed(scoped, "anthropic", "excluded")).toBe(false);
	expect(isScopedModelAllowed(scoped, "openai", "allowed")).toBe(false);
	expect(isScopedModelAllowed([], "any", "model")).toBe(true);
});
