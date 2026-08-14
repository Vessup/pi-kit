import { expect, test } from "bun:test";
import { anchoredScrollTop, resolveScrollFollow } from "../web/client/scroll-follow.ts";

test("layout growth while following stays pinned without showing the down arrow", () => {
	expect(resolveScrollFollow(true, 240)).toEqual({
		following: true,
		showButton: false,
		pinToBottom: true,
	});
});

test("an explicit user scroll away from the bottom remains unfollowed", () => {
	expect(resolveScrollFollow(false, 240)).toEqual({
		following: false,
		showButton: true,
		pinToBottom: false,
	});
});

test("an unpinned reader near the bottom remains frozen during layout changes", () => {
	expect(resolveScrollFollow(false, 20)).toEqual({
		following: false,
		showButton: true,
		pinToBottom: false,
	});
});

test("passive layout changes cannot resume while the down arrow is visible", () => {
	expect(resolveScrollFollow(false, 0, undefined, false)).toEqual({
		following: false,
		showButton: true,
		pinToBottom: false,
	});
});

test("explicit downward input at the actual bottom resumes following", () => {
	expect(resolveScrollFollow(false, 0, undefined, true)).toEqual({
		following: true,
		showButton: false,
		pinToBottom: false,
	});
});

test("anchor correction offsets only visual movement caused above the viewport", () => {
	expect(anchoredScrollTop(420, 100, 135)).toBe(455);
	expect(anchoredScrollTop(420, 100, 100)).toBe(420);
});
