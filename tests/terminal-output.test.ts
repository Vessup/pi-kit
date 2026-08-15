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

test("oversized vertical cursor parameters are bounded", () => {
	const huge = "9".repeat(400);
	for (const command of ["B", "H", "f"]) {
		const cursor = command === "B" ? `${huge}B` : `${huge};${huge}${command}`;
		const output = renderTerminalOutput(`top\u001b[${cursor}X`);
		expect(output.startsWith("top\n")).toBe(true);
		expect(output.split("\n").at(-1)?.trim()).toBe("X");
		expect(output.split("\n")).toHaveLength(10_000);
	}
});

test("oversized horizontal cursor parameters and aggregate materialization are bounded", () => {
	const huge = "9".repeat(400);
	const line = renderTerminalOutput(`prefix\u001b[${huge}CX`);
	expect(line).toHaveLength(10_000);
	expect(line.startsWith("prefix")).toBe(true);
	expect(line.endsWith("X")).toBe(true);

	const denseRows = Array.from({ length: 200 }, (_, row) => `\u001b[${row + 1};1H\u001b[${huge}CX`).join("");
	const output = renderTerminalOutput(denseRows);
	expect(output.length).toBeLessThanOrEqual(100_100);
	expect(output.match(/X/g)).toHaveLength(10);
});

test("ordinary command output is unchanged", () => {
	const output = "one\ntwo\n";
	expect(renderTerminalOutput(output)).toBe(output);
});
