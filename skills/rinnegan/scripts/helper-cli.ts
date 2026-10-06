#!/usr/bin/env bun
// The JSON-reading bodies of rinnegan's shell verifiers. Every argument arrives as an argv element,
// so a path never passes through a code string. A command that cannot read what it is given exits
// 1 with nothing on stdout; the calling script decides what that means.
// Usage: helper-cli.ts inventory-count <inventory.json>
//        helper-cli.ts inventory-stack <inventory.json>
//        helper-cli.ts inventory-layers <inventory.json>
//        helper-cli.ts findings-unique-files <findings.jsonl>
//        helper-cli.ts sample-lines <file> <count>
//        helper-cli.ts finding-fields (<field> <default>)...    (one finding as JSON on stdin; each value then a NUL)
import { isRecord, readTextStrict } from "@quality/io.ts";
import { pyStr } from "@quality/py-format.ts";

const FILE_COMMANDS = ["inventory-count", "inventory-stack", "inventory-layers", "findings-unique-files"] as const;
export type FileCommand = (typeof FILE_COMMANDS)[number];

// $(...) drops the trailing newlines of what a command printed.
const dropTrailingNewlines = (text: string): string => text.replace(/\n+$/, "");
// $(...) also drops NUL bytes, and a NUL is what ends each value finding-fields prints.
const dropNul = (text: string): string => text.replaceAll("\0", "");

const fieldPairs = (args: string[]): Array<readonly [string, string]> =>
  Array.from({ length: args.length / 2 }, (_, i) => [args[2 * i] ?? "", args[2 * i + 1] ?? ""] as const);

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

function readInventory(path: string): Record<string, unknown> {
  const inventory: unknown = JSON.parse(readTextStrict(path));
  if (!isRecord(inventory)) throw new TypeError(`${path}: expected an object`);
  return inventory;
}

// The distinct "file" values of a findings file; a line that is not JSON counts for nothing.
function uniqueFiles(path: string): number {
  const files = new Set<string>();
  for (const line of readTextStrict(path).split(/\r\n|\r|\n/)) {
    try {
      const finding: unknown = JSON.parse(line.trim());
      if (isRecord(finding)) files.add(pyStr(finding["file"] ?? ""));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return files.size;
}

const isFileCommand = (value: string | undefined): value is FileCommand => FILE_COMMANDS.some((known) => known === value);

export function runFileCommand(command: FileCommand, path: string): number {
  try {
    switch (command) {
      case "inventory-count": {
        const total = readInventory(path)["total_files"];
        if (total === undefined) return 1;
        say(pyStr(total));
        return 0;
      }
      case "inventory-stack":
        say(pyStr(readInventory(path)["stack"] ?? "unknown"));
        return 0;
      case "inventory-layers": {
        const layers = readInventory(path)["layers"] ?? {};
        if (!isRecord(layers)) return 1;
        for (const layer of Object.keys(layers)) say(layer);
        return 0;
      }
      case "findings-unique-files":
        say(String(uniqueFiles(path)));
        return 0;
    }
  } catch {
    return 1;
  }
}

// `count` of the file's lines, in random order (shuf -n, which not every system ships).
export function sampleLines(path: string, count: number): string[] {
  const lines = readTextStrict(path).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (let i = lines.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [lines[i], lines[j]] = [lines[j] ?? "", lines[i] ?? ""];
  }
  return lines.slice(0, count);
}

// Each requested field of a finding, with the default a missing key gets; undefined when the line is not a JSON object.
export function findingFields(findingJson: string, wanted: ReadonlyArray<readonly [string, string]>): string[] | undefined {
  let finding: unknown;
  try {
    finding = JSON.parse(findingJson);
  } catch {
    return undefined;
  }
  if (!isRecord(finding)) return undefined;
  return wanted.map(([field, fallback]) => (field in finding ? pyStr(finding[field]) : fallback));
}

if (import.meta.main) {
  const [command, first, second, ...rest] = process.argv.slice(2);
  if (isFileCommand(command) && first !== undefined) {
    process.exitCode = runFileCommand(command, first);
  } else if (command === "sample-lines" && first !== undefined && second !== undefined) {
    for (const line of sampleLines(first, Number(second))) say(line);
  } else if (command === "finding-fields" && first !== undefined && second !== undefined && rest.length % 2 === 0) {
    const values = findingFields(await Bun.stdin.text(), fieldPairs([first, second, ...rest]));
    if (values === undefined) process.exitCode = 1;
    else for (const value of values) process.stdout.write(`${dropTrailingNewlines(dropNul(value))}\0`);
  } else {
    console.error(`Usage: helper-cli.ts ${[...FILE_COMMANDS, "sample-lines", "finding-fields"].join(" | ")} <args>`);
    process.exitCode = 2;
  }
}
