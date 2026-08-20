import { MAX_TOOL_OUTPUT_BYTES, type SubagentStatus } from "./types.js";

export function formatTokens(count: number): string {
  if (count < 1_000) return `${count}`;
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function sanitizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function stringifyCompact(value: unknown, max = 200): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  const characters = Array.from(text);
  return characters.length > max
    ? `${characters.slice(0, max).join("")}…`
    : text;
}

export function truncateChars(text: string, maximum: number): string {
  const characters = Array.from(text);
  return characters.length <= maximum
    ? text
    : `${characters.slice(0, maximum).join("")}\n[… ${characters.length - maximum} characters omitted]`;
}

export function statusIcon(status: SubagentStatus): string {
  switch (status) {
    case "creating":
    case "working":
    case "terminating":
      return "◐";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "terminated":
      return "■";
  }
}

export function statusColor(
  status: SubagentStatus,
): "warning" | "success" | "error" | "muted" {
  switch (status) {
    case "creating":
    case "working":
    case "terminating":
      return "warning";
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "terminated":
      return "muted";
  }
}

export function subagentFooterSummary(
  statuses: Iterable<SubagentStatus>,
): { text: string; status: SubagentStatus } | undefined {
  let total = 0;
  let working = 0;
  let completed = 0;
  let failed = 0;
  let terminated = 0;
  for (const status of statuses) {
    total++;
    if (
      status === "creating" ||
      status === "working" ||
      status === "terminating"
    )
      working++;
    else if (status === "completed") completed++;
    else if (status === "failed") failed++;
    else terminated++;
  }
  if (total === 0) return undefined;
  const parts = [`${total} subagent${total === 1 ? "" : "s"}`];
  if (working) parts.push(`${working} working`);
  if (completed) parts.push(`${completed} done`);
  if (failed) parts.push(`${failed} failed`);
  if (terminated) parts.push(`${terminated} stopped`);
  return {
    text: parts.join(" • "),
    status: failed
      ? "failed"
      : working
        ? "working"
        : terminated
          ? "terminated"
          : "completed",
  };
}

export function truncateToolOutput(text: string): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= MAX_TOOL_OUTPUT_BYTES) return text;
  let end = MAX_TOOL_OUTPUT_BYTES;
  let output = "";
  while (end > 0) {
    try {
      output = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, end),
      );
      break;
    } catch {
      // A valid JavaScript string can only leave a partial UTF-8 code point at
      // the byte boundary, so at most three trailing bytes are discarded.
      end--;
    }
  }
  return `${output}\n\n[Output truncated: ${buffer.length - end} bytes omitted. Re-read a specific subagent or use the transcript modal for details.]`;
}

export function modelName(
  model: { provider: string; id: string } | undefined,
): string {
  return model ? `${model.provider}/${model.id}` : "no-model";
}
