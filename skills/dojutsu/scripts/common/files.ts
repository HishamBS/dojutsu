// Directory walking and tolerant reads for the deterministic project tools. Both reproduce
// the Python walk those tools used: name-ordered, files before subdirectories, symlinked
// directories neither listed nor descended into, unreadable directories skipped.
import { readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { readTextStrict } from "@quality/io.ts";

function isDirectory(entry: Dirent, absPath: string): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function walkInto(root: string, relDir: string, skipDirs: ReadonlySet<string>, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, relDir), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const subdirs: string[] = [];
  for (const entry of entries) {
    const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    if (isDirectory(entry, join(root, rel))) {
      if (!skipDirs.has(entry.name) && !entry.isSymbolicLink()) subdirs.push(rel);
    } else {
      out.push(rel);
    }
  }
  for (const sub of subdirs) walkInto(root, sub, skipDirs, out);
}

// Root-relative, slash-separated file paths below `root`, never entering a directory named
// in `skipDirs`.
export function walkProjectFiles(root: string, skipDirs: ReadonlySet<string>): string[] {
  const files: string[] = [];
  walkInto(root, "", skipDirs, files);
  return files;
}

// The file's text, or null when it cannot be read or is not valid UTF-8: the tools that
// scan a whole tree skip such a file rather than fail the audit.
export function readTextOrNull(path: string): string | null {
  try {
    return readTextStrict(path);
  } catch {
    return null;
  }
}
