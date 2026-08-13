import { expect, test } from "bun:test";
import { resolveScrollFollow } from "../web/client/scroll-follow.ts";

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

test("reaching the bottom resumes following and hides the down arrow", () => {
	expect(resolveScrollFollow(false, 20)).toEqual({
		following: true,
		showButton: false,
		pinToBottom: false,
	});
});
