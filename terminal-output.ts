const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;

/** Render terminal cursor updates into the final visible text. */
export function renderTerminalOutput(source: string): string {
	if (!source.includes("\u001b") && !source.includes("\r") && !source.includes("\b")) return source;

	let rows: string[][] = [[]];
	let row = 0;
	let column = 0;
	const currentRow = () => {
		while (rows.length <= row) rows.push([]);
		return rows[row]!;
	};
	const moveToColumn = (next: number) => {
		column = Math.max(0, next);
	};
	const eraseDisplay = (mode: number) => {
		if (mode === 2 || mode === 3) {
			rows = [[]];
			row = 0;
			column = 0;
			return;
		}
		if (mode === 0) {
			currentRow().length = Math.min(column, currentRow().length);
			rows.length = row + 1;
		}
	};
	const eraseLine = (mode: number) => {
		const line = currentRow();
		if (mode === 2) {
			line.length = 0;
			column = 0;
		} else if (mode === 0) line.length = Math.min(column, line.length);
		else if (mode === 1) {
			for (let index = 0; index <= Math.min(column, line.length - 1); index += 1) line[index] = " ";
		}
	};

	for (let index = 0; index < source.length; index += 1) {
		const character = source[index]!;
		if (character === "\u001b") {
			const introducer = source[index + 1];
			if (introducer === "]") {
				index += 2;
				while (index < source.length && source[index] !== "\u0007" && !(source[index] === "\u001b" && source[index + 1] === "\\")) index += 1;
				if (source[index] === "\u001b") index += 1;
				continue;
			}
			if (introducer !== "[") {
				if (introducer !== undefined) index += 1;
				continue;
			}
			let end = index + 2;
			while (end < source.length) {
				const code = source.charCodeAt(end);
				if (code >= CSI_FINAL_MIN && code <= CSI_FINAL_MAX) break;
				end += 1;
			}
			if (end >= source.length) break;
			const final = source[end]!;
			const rawParameters = source.slice(index + 2, end).replace(/^[?>]/, "");
			const parameters = rawParameters.split(";").map((value) => Number.parseInt(value, 10) || 0);
			const first = parameters[0] ?? 0;
			if (final === "G") moveToColumn((first || 1) - 1);
			else if (final === "H" || final === "f") {
				row = Math.max(0, (first || 1) - 1);
				moveToColumn((parameters[1] || 1) - 1);
			} else if (final === "A") row = Math.max(0, row - (first || 1));
			else if (final === "B") row += first || 1;
			else if (final === "C") column += first || 1;
			else if (final === "D") moveToColumn(column - (first || 1));
			else if (final === "J") eraseDisplay(first);
			else if (final === "K") eraseLine(first);
			index = end;
			continue;
		}
		if (character === "\r") {
			column = 0;
			continue;
		}
		if (character === "\n") {
			row += 1;
			column = 0;
			currentRow();
			continue;
		}
		if (character === "\b") {
			moveToColumn(column - 1);
			continue;
		}
		if (character === "\t") {
			const spaces = 8 - (column % 8);
			for (let count = 0; count < spaces; count += 1) currentRow()[column++] = " ";
			continue;
		}
		if (character < " ") continue;
		const line = currentRow();
		while (line.length < column) line.push(" ");
		line[column++] = character;
	}

	return rows.map((line) => line.join("").replace(/ +$/g, "")).join("\n");
}
