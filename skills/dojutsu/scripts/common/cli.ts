// argparse's failure form for the quality CLIs: the usage line and "<prog>: error: <message>" on
// stderr, exit status 2.
const USAGE_ERROR_STATUS = 2;

export function usageError(usage: string, prog: string, message: string): never {
  process.stderr.write(`${usage}\n${prog}: error: ${message}\n`);
  return process.exit(USAGE_ERROR_STATUS);
}

// int(): optional sign and digits, surrounding whitespace allowed.
export function parseIntArg(text: string): number | undefined {
  return /^\s*[+-]?\d+\s*$/.test(text) ? Number(text) : undefined;
}
