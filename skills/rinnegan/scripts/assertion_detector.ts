// Detect test functions that contain zero assertions. Python test files are read through the
// Python grammar (nested and async tests, real call shapes); TypeScript test files through a
// line scan for test/it blocks and expect() calls. An assertion-free test is a smoke test at
// best and gives false confidence.
import { parser } from "@lezer/python";
import { basename, join } from "node:path";
import { readTextOrNull, walkProjectFiles } from "@quality/files.ts";
import type { Finding } from "@quality/types.ts";

type PyNode = ReturnType<typeof parser.parse>["topNode"];

const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", "dist", "build",
]);
const TEST_FUNCTION_PREFIX = "test_";
const UNITTEST_ASSERT_PREFIXES: readonly string[] = ["assert", "fail"];
const PYTEST_ASSERT_CALLS: ReadonlySet<string> = new Set(["raises"]);
const MOCK_ASSERT_PREFIXES: readonly string[] = [
  "assert_called", "assert_not_called", "assert_called_once", "assert_called_with",
  "assert_called_once_with", "assert_any_call", "assert_has_calls",
];
const ASSERTION_PHASE = 9;
const TS_TEST_FILE_SUFFIXES: readonly string[] = [".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx"];
const TS_TEST_BLOCK = /(?:test|it)\s*\(\s*['"`]/;
const TS_TEST_NAME = /(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/;
const TS_EXPECT = /expect\s*\(/;

function makeAssertionFinding(file: string, line: number, testName: string): Finding {
  const description = `Test '${testName}' has no assertions`;
  return {
    rule: "R08",
    severity: "MEDIUM",
    category: "build",
    file,
    line,
    end_line: line,
    snippet: description,
    current_code: description,
    description,
    explanation: description,
    search_pattern: "",
    phase: ASSERTION_PHASE,
    effort: "low",
    scanner: "assertion-detector",
    confidence: "high",
    confidence_reason: "Deterministic: AST/grep assertion analysis",
    tool_rule_id: "no-assertions",
    cwe: [],
  };
}

// Python reads source with universal newlines, so \r\n and a lone \r both end a line.
const normalizeNewlines = (text: string): string => text.replace(/\r\n?/g, "\n");

function someDescendant(node: PyNode, predicate: (child: PyNode) => boolean): boolean {
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (predicate(child) || someDescendant(child, predicate)) return true;
  }
  return false;
}

// A call whose callee is `name.attr` or `expr.attr`: self.assert*/self.fail*, pytest.raises,
// or any object's mock assertion method.
function isAssertCall(call: PyNode, source: string): boolean {
  const callee = call.firstChild;
  if (callee === null || callee.name !== "MemberExpression") return false;
  const attribute = callee.lastChild;
  const dot = attribute?.prevSibling;
  if (attribute === null || attribute.name !== "PropertyName" || dot?.name !== ".") return false;
  const attr = source.slice(attribute.from, attribute.to);
  const object = callee.firstChild;
  const objectName = object !== null && object.name === "VariableName" && object.nextSibling?.from === dot.from ? source.slice(object.from, object.to) : null;
  if (objectName === "self" && UNITTEST_ASSERT_PREFIXES.some((prefix) => attr.startsWith(prefix))) return true;
  if (objectName === "pytest" && PYTEST_ASSERT_CALLS.has(attr)) return true;
  return MOCK_ASSERT_PREFIXES.some((prefix) => attr.startsWith(prefix));
}

const hasAssertion = (func: PyNode, source: string): boolean =>
  someDescendant(func, (node) => node.name === "AssertStatement" || (node.name === "CallExpression" && isAssertCall(node, source)));

function checkPythonFile(path: string, relPath: string): Finding[] {
  const text = readTextOrNull(path);
  if (text === null) return [];
  const source = normalizeNewlines(text);
  const tree = parser.parse(source);
  let syntaxError = false;
  tree.iterate({
    enter: (node) => {
      if (node.type.isError) syntaxError = true;
      return !syntaxError;
    },
  });
  if (syntaxError) return [];
  const findings: Finding[] = [];
  tree.iterate({
    enter: (ref) => {
      if (ref.name !== "FunctionDefinition") return;
      const func = ref.node;
      const nameNode = func.getChild("VariableName");
      if (nameNode === null) return;
      const name = source.slice(nameNode.from, nameNode.to);
      if (!name.startsWith(TEST_FUNCTION_PREFIX) || hasAssertion(func, source)) return;
      const line = source.slice(0, func.from).split("\n").length;
      findings.push(makeAssertionFinding(relPath, line, name));
    },
  });
  return findings;
}

const isPythonTestFile = (filename: string): boolean =>
  filename.endsWith(".py") && (filename.startsWith(TEST_FUNCTION_PREFIX) || filename.endsWith("_test.py"));

function scanPythonTests(projectDir: string): Finding[] {
  return walkProjectFiles(projectDir, SKIP_DIRS)
    .filter((rel) => isPythonTestFile(basename(rel)))
    .flatMap((rel) => checkPythonFile(join(projectDir, rel), rel));
}

// A test block runs from its own line to the line before the next block (or the file end);
// it is assertion-free when no expect() call appears in that span.
function checkTypescriptFile(path: string, relPath: string): Finding[] {
  const text = readTextOrNull(path);
  if (text === null) return [];
  const lines = normalizeNewlines(text).split("\n");
  const blocks: { line: number; name: string }[] = [];
  lines.forEach((text, index) => {
    if (!TS_TEST_BLOCK.test(text)) return;
    blocks.push({ line: index + 1, name: TS_TEST_NAME.exec(text)?.[1] ?? `anonymous_test_line_${index + 1}` });
  });
  return blocks.flatMap((block, index) => {
    const endLine = blocks[index + 1]?.line ?? lines.length + 1;
    const span = lines.slice(block.line - 1, endLine - 1).join("\n");
    return TS_EXPECT.test(span) ? [] : [makeAssertionFinding(relPath, block.line, block.name)];
  });
}

function scanTypescriptTests(projectDir: string): Finding[] {
  return walkProjectFiles(projectDir, SKIP_DIRS)
    .filter((rel) => TS_TEST_FILE_SUFFIXES.some((suffix) => rel.endsWith(suffix)))
    .flatMap((rel) => checkTypescriptFile(join(projectDir, rel), rel));
}

export function detectAssertionFreeTests(projectDir: string, stack: string): Finding[] {
  if (stack === "python") return scanPythonTests(projectDir);
  if (stack === "typescript") return scanTypescriptTests(projectDir);
  return [];
}
