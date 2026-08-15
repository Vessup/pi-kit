import { expect, test } from "bun:test";
import { renderTerminalOutput } from "../terminal-output";

test("terminal redraws retain only the final visible progress frame", () => {
	const frames = Array.from(
		{ length: 1_000 },
		(_, index) => `\u001b[1G\u001b[J\u001b[35m${index % 2 ? "◐" : "◓"}\u001b[39m Running build ${index}`,
	).join("");
	expect(renderTerminalOutput(`${frames}\u001b[1G\u001b[Jsuccess: build-1\n`)).toBe("success: build-1\n");
});

test("terminal output handles carriage returns, erasure, and ordinary ANSI colors", () => {
	expect(renderTerminalOutput("0%\r50%\r100%\n\u001b[31mfailed\u001b[39m\n")).toBe("100%\nfailed\n");
	expect(renderTerminalOutput("first\nsecond\u001b[1G\u001b[Jreplacement")).toBe("first\nreplacement");
	expect(renderTerminalOutput("abc\u001b[2KX")).toBe("   X");
});

test("ordinary command output is unchanged", () => {
	const output = "one\ntwo\n";
	expect(renderTerminalOutput(output)).toBe(output);
});
