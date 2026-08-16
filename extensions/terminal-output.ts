import {
  type ExtensionAPI,
  isBashToolResult,
} from "@earendil-works/pi-coding-agent";
import { renderTerminalOutput } from "../terminal-output.js";

export default function terminalOutputExtension(pi: ExtensionAPI) {
  pi.on("tool_result", (event) => {
    if (!isBashToolResult(event)) return;
    let changed = false;
    const content = event.content.map((part) => {
      if (part.type !== "text") return part;
      const text = renderTerminalOutput(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { content } : undefined;
  });
}
