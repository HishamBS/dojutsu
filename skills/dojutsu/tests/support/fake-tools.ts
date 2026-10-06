// Shared fixture support: fake external tools for the deterministic tool runner. A fake is a
// small shell script that prints canned output, standing in for the real tool at the process
// boundary. They live in a scratch directory that replaces the PATH (plus the system
// directories the scripts themselves need) for the duration of one call.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SYSTEM_PATH = "/usr/bin:/bin";
const EXECUTABLE_MODE = 0o755;
const FAKE_PREFIX = "quality-skills-tools-";
const HEREDOC_END = "FAKE_TOOL_EOF";

// A script that prints `text` verbatim (no shell expansion) and exits 0.
export function printing(text: string): string {
  return `cat <<'${HEREDOC_END}'\n${text}\n${HEREDOC_END}\n`;
}

// Write an executable shell script at `path`, creating its directory.
export function writeExecutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, EXECUTABLE_MODE);
}

// Run `run` with PATH set to a scratch directory holding the `bin` fakes (name -> script
// body) and HOME pointed at an empty directory, then restore both and remove the scratch.
export async function withToolEnvironment<T>(tools: Record<string, string>, run: () => T | Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), FAKE_PREFIX));
  const binDir = join(scratch, "bin");
  const homeDir = join(scratch, "home");
  mkdirSync(homeDir, { recursive: true });
  for (const [name, body] of Object.entries(tools)) writeExecutable(join(binDir, name), body);
  const saved = { path: process.env["PATH"], home: process.env["HOME"] };
  process.env["PATH"] = `${binDir}:${SYSTEM_PATH}`;
  process.env["HOME"] = homeDir;
  try {
    return await run();
  } finally {
    if (saved.path === undefined) delete process.env["PATH"];
    else process.env["PATH"] = saved.path;
    if (saved.home === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved.home;
    rmSync(scratch, { recursive: true, force: true });
  }
}

const REGISTRY_SCRIPT =
  "const server = Bun.serve({ port: 0, fetch: () => new Response(process.env.REGISTRY_BODY, { status: Number(process.env.REGISTRY_STATUS), headers: { 'content-type': 'application/json' } }) });\n" +
  "console.log(server.port);\n";

export type FakeRegistry = { url: string; stop: () => void };

// A local package registry in its own process (the audited command blocks this one while it
// runs), answering every request with `body` and `status`.
export async function startRegistry(body: unknown, status = 200): Promise<FakeRegistry> {
  const scratch = mkdtempSync(join(tmpdir(), FAKE_PREFIX));
  const script = join(scratch, "registry.ts");
  writeFileSync(script, REGISTRY_SCRIPT);
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, REGISTRY_BODY: JSON.stringify(body), REGISTRY_STATUS: String(status) },
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  const port = new TextDecoder().decode(first.value).trim();
  return {
    url: `http://127.0.0.1:${port}/`,
    stop: () => {
      child.kill();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
