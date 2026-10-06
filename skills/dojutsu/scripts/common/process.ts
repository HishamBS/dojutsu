// Run an external command with an argv array (paths stay data, never shell text) and a
// deadline. The command is looked up on the PATH of the environment passed in, so a test
// that sets PATH on `process.env` and a user who changed it see the same executable.
export type CommandOutcome =
  | { status: "missing" }
  | { status: "timeout" }
  | { status: "exited"; exitCode: number; stdout: string; stderr: string };

export type CommandOptions = { cwd: string; timeoutMs: number };

export function runCommand(argv: readonly string[], options: CommandOptions): CommandOutcome {
  try {
    const result = Bun.spawnSync([...argv], { cwd: options.cwd, env: process.env, timeout: options.timeoutMs, stdout: "pipe", stderr: "pipe" });
    if (result.exitedDueToTimeout === true) return { status: "timeout" };
    return { status: "exited", exitCode: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch {
    return { status: "missing" };
  }
}
