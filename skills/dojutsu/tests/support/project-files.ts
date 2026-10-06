// Shared fixture support: build an owned scratch project from an explicit file map. Every
// root it creates is removed after the test that created it; nothing else is ever deleted.
import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRATCH_PREFIX = "quality-skills-";
const created: string[] = [];

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Returns the fixture project root; `files` maps project-relative paths to their content.
export function projectFiles(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  created.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const target = join(root, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}
