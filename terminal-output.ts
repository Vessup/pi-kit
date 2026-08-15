const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;
const MAX_RENDERED_ROWS = 10_000;
const MAX_RENDERED_COLUMNS = 10_000;
const MAX_RENDERED_CELLS = 100_000;

/** Render terminal cursor updates into the final visible text. */
export function renderTerminalOutput(source: string): string {
	if (!source.includes("\u001b") && !source.includes("\r") && !source.includes("\b")) return source;

	let rows: string[][] = [[]];
	let row = 0;
	let column = 0;
	let renderedCells = 0;
	const currentRow = () => {
		while (rows.length <= row) rows.push([]);
		return rows[row]!;
	};
	const moveToRow = (next: number) => {
		row = Math.max(0, Math.min(MAX_RENDERED_ROWS - 1, next));
	};
	const moveToColumn = (next: number) => {
		column = Math.max(0, Math.min(MAX_RENDERED_COLUMNS - 1, next));
	};
	const truncateLine = (line: string[], length: number) => {
		const nextLength = Math.min(length, line.length);
		renderedCells -= line.length - nextLength;
		line.length = nextLength;
	};
	const writeCharacter = (character: string): boolean => {
		if (column >= MAX_RENDERED_COLUMNS) return false;
		const line = currentRow();
		const addedCells = Math.max(0, column + 1 - line.length);
		if (renderedCells + addedCells > MAX_RENDERED_CELLS) return false;
		while (line.length < column) line.push(" ");
		line[column] = character;
		renderedCells += addedCells;
		column += 1;
		return true;
	};
	const eraseDisplay = (mode: number) => {
		if (mode === 2 || mode === 3) {
			rows = [[]];
			row = 0;
			column = 0;
			renderedCells = 0;
			return;
		}
		if (mode === 0) {
			truncateLine(currentRow(), column);
			for (let index = row + 1; index < rows.length; index += 1) renderedCells -= rows[index]!.length;
			rows.length = row + 1;
		}
	};
	const eraseLine = (mode: number) => {
		const line = currentRow();
		if (mode === 2) truncateLine(line, 0);
		else if (mode === 0) truncateLine(line, column);
		else if (mode === 1) {
			for (let index = 0; index <= Math.min(column, line.length - 1); index += 1) line[index] = " ";
		}
	};

	rendering: for (let index = 0; index < source.length; index += 1) {
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
				moveToRow((first || 1) - 1);
				moveToColumn((parameters[1] || 1) - 1);
			} else if (final === "A") moveToRow(row - (first || 1));
			else if (final === "B") moveToRow(row + (first || 1));
			else if (final === "C") moveToColumn(column + (first || 1));
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
			moveToRow(row + 1);
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
			for (let count = 0; count < spaces; count += 1) {
				if (!writeCharacter(" ")) break rendering;
			}
			continue;
		}
		if (character < " ") continue;
		if (!writeCharacter(character)) break;
	}

	return rows.map((line) => line.join("").replace(/ +$/g, "")).join("\n");
}
