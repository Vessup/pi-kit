import { type Dirent, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { resolveWebCwd } from "./paths.js";
import { resolveSessionProject } from "./projects.js";

const MAX_DIRECTORY_SUGGESTIONS = 20;

export type DirectorySuggestionOptions = {
  baseDir?: string;
  homeDir?: string;
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Format a directory for the browser using the ~ shorthand whenever possible. */
function displayPath(path: string, home: string): string {
  const relation = relative(home, path);
  if (relation === "") return "~";
  if (!relation.startsWith("..") && !relation.startsWith("/")) {
    return `~/${relation.split("\\").join("/")}`;
  }
  return path;
}

/**
 * Suggest directories that continue the typed path.
 *
 * The last path segment is treated as a prefix filter over the parent
 * directory's entries, so "~/vess" suggests ~/vessup rather than listing it.
 * A trailing slash lists the named directory's children so completions can
 * drill down level by level. Suggestions stop once the listed directory is
 * inside a Git repository: the field selects a repository, so paths beneath
 * one are noise. Missing or unreadable directories return no suggestions
 * instead of failing.
 */
export function listDirectorySuggestions(
  query: string,
  options: DirectorySuggestionOptions = {},
): string[] {
  const home = resolve(options.homeDir ?? homedir());
  const trimmed = query.trim();
  let parent: string;
  let prefix: string;
  if (!trimmed || trimmed === "~") {
    parent = home;
    prefix = "";
  } else {
    let resolved: string;
    try {
      resolved = resolveWebCwd(trimmed, {
        baseDir: options.baseDir,
        homeDir: options.homeDir,
      });
    } catch {
      // Unsupported shorthand such as ~user cannot be autocompleted.
      return [];
    }
    if (trimmed.endsWith("/")) {
      parent = resolved;
      prefix = "";
    } else {
      parent = dirname(resolved);
      prefix = basename(resolved);
    }
  }
  if (!isDirectory(parent)) return [];
  if (resolveSessionProject(parent).id.startsWith("git:")) return [];
  const showHidden = prefix.startsWith(".");
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const lowered = prefix.toLowerCase();
  const matches = entries
    .filter((entry) => {
      if (!showHidden && entry.name.startsWith(".")) return false;
      if (!entry.name.toLowerCase().startsWith(lowered)) return false;
      if (entry.isDirectory()) return true;
      // Follow symlinks to directories so linked checkouts autocomplete.
      if (entry.name.startsWith(".")) return false;
      return isDirectory(join(parent, entry.name));
    })
    .map((entry) => entry.name)
    .sort((left, right) =>
      left.toLowerCase().localeCompare(right.toLowerCase()),
    )
    .slice(0, MAX_DIRECTORY_SUGGESTIONS);
  return matches.map((name) => displayPath(join(parent, name), home));
}
