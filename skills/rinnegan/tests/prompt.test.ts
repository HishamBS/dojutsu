import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNSCANNED_FILES_KEY } from "@rinnegan/handle_partial_scan.ts";

const PROMPT = readFileSync(join(import.meta.dir, "..", "scanner-prompt.md"), "utf8");

interface PromptCase {
  name: string;
  holds: (prompt: string) => boolean;
}

describe("scanner-prompt.md", () => {
  it.each<PromptCase>([
    { name: "gives no density-note instruction, in any form", holds: (prompt) => !prompt.includes("DENSITY_NOTE") },
    {
      name: "sets no lower bound on findings per KLOC",
      holds: (prompt) => !["below 1/KLOC", "below 1 finding", "fewer than 1 finding per KLOC"].some((bound) => prompt.includes(bound)),
    },
    {
      name: "says that no findings on a clean file is correct",
      holds: (prompt) => prompt.includes("0 findings on a clean file is correct") || prompt.includes("Zero findings on a clean file is correct"),
    },
    { name: "keeps the guidance not to manufacture findings", holds: (prompt) => prompt.includes("manufacture") },
    { name: "asks a partial scan for the sentinel key the pipeline reads", holds: (prompt) => prompt.includes(`"${UNSCANNED_FILES_KEY}"`) },
  ])("$name", ({ holds }) => {
    expect(holds(PROMPT)).toBe(true);
  });
});
