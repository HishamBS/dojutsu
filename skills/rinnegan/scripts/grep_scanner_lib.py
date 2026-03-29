"""Shared logic for grep-scanner.

Extracted from grep-scanner.py so tests can import directly
and pytest-cov can measure coverage.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from typing import TypedDict


class PatternDef(TypedDict, total=False):
    pattern: str
    rule: str
    severity: str
    category: str
    description: str
    phase: int
    explanation: str
    removable: bool
    target_code: str | None


class Finding(TypedDict, total=False):
    rule: str
    severity: str
    category: str
    file: str
    line: int
    end_line: int
    snippet: str
    current_code: str
    description: str
    explanation: str
    search_pattern: str
    target_code: str | None
    target_import: str | None
    fix_plan: str | None
    phase: int
    effort: str
    layer: str
    scanner: str


# ---- Category prefix mapping ------------------------------------------------

CATEGORY_PREFIX: dict[str, str] = {
    "security": "SEC",
    "typing": "TYP",
    "ssot-dry": "DRY",
    "architecture": "ARC",
    "clean-code": "CLN",
    "performance": "PRF",
    "data-integrity": "DAT",
    "refactoring": "REF",
    "full-stack": "STK",
    "documentation": "DOC",
    "build": "BLD",
}

# ---- Stack-specific patterns -------------------------------------------------

TYPESCRIPT_PATTERNS: list[PatternDef] = [
    {"pattern": r"console\.log\(", "rule": "R09", "severity": "MEDIUM", "category": "clean-code",
     "description": "console.log in production code", "phase": 5, "removable": True,
     "explanation": "Console.log statements leak debug information to browser devtools in production. They clutter the console, may expose sensitive data, and indicate incomplete cleanup after development. Remove or replace with a proper logging service."},
    {"pattern": r"console\.error\(", "rule": "R09", "severity": "MEDIUM", "category": "clean-code",
     "description": "console.error in production code", "phase": 5, "removable": True,
     "explanation": "Console.error should be replaced with structured error reporting (e.g., Sentry, LogRocket). Raw console output is not monitored in production and errors go unnoticed."},
    {"pattern": r"console\.warn\(", "rule": "R09", "severity": "MEDIUM", "category": "clean-code",
     "description": "console.warn in production code", "phase": 5, "removable": True,
     "explanation": "Console.warn clutters production output. Replace with a structured logging service that can be monitored and filtered."},
    {"pattern": r"eslint-disable", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "ESLint rule suppressed with eslint-disable", "phase": 0, "removable": True,
     "explanation": "eslint-disable comments bypass lint rules that exist to catch bugs. Each suppression should have a justification comment. Blanket disables indicate code that should be fixed, not silenced."},
    {"pattern": r"dangerouslySetInnerHTML", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "dangerouslySetInnerHTML without sanitization (XSS risk)", "phase": 1,
     "explanation": "Setting innerHTML from untrusted data allows Cross-Site Scripting (XSS) attacks. An attacker can inject malicious scripts that steal session tokens or redirect users. Always sanitize with DOMPurify before rendering HTML."},
    {"pattern": r"\.innerHTML\s*=", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "Direct innerHTML assignment (XSS risk)", "phase": 1,
     "explanation": "Direct innerHTML assignment bypasses React's built-in XSS protection. Use dangerouslySetInnerHTML with DOMPurify sanitization, or better, parse and render content safely."},
    {"pattern": r"\beval\(", "rule": "R05", "severity": "CRITICAL", "category": "security",
     "description": "eval() usage (code injection risk)", "phase": 1,
     "explanation": "eval() executes arbitrary code strings. If any user input reaches eval, an attacker can execute arbitrary JavaScript in the user's browser, stealing data or performing actions as the user."},
    {"pattern": r":\s*any\b", "rule": "R07", "severity": "HIGH", "category": "typing",
     "description": "Explicit 'any' type bypasses TypeScript safety", "phase": 2,
     "explanation": "Using 'any' disables TypeScript's type checking for that value. All downstream code loses type safety, and bugs that the compiler would normally catch become runtime errors. Use a specific type, generic, or 'unknown' instead."},
    {"pattern": r"as\s+any\b", "rule": "R07", "severity": "HIGH", "category": "typing",
     "description": "Type assertion to 'any' bypasses TypeScript safety", "phase": 2,
     "explanation": "Casting to 'any' silences the type checker but doesn't fix the underlying type mismatch. The code will fail at runtime when the actual type doesn't match expectations. Fix the type properly instead of casting."},
    {"pattern": r"=\s*any\b", "rule": "R07", "severity": "HIGH", "category": "typing",
     "description": "Type alias assigned to 'any' bypasses TypeScript safety", "phase": 2,
     "explanation": "Assigning a type alias to 'any' (e.g., type Foo = any) propagates unsafe typing to every usage site. All code using this alias loses type checking. Define a proper type structure or use 'unknown' instead."},
    {"pattern": r"[<,]\s*any\b", "rule": "R07", "severity": "HIGH", "category": "typing",
     "description": "Generic type parameter 'any' bypasses TypeScript safety", "phase": 2,
     "explanation": "Using 'any' as a generic parameter (e.g., Record<string, any>, Array<any>) defeats the purpose of the generic type. The contained values lose all type safety. Use a specific type, 'unknown', or a type parameter instead."},
    {"pattern": r"\bTODO\b", "rule": "R14", "severity": "LOW", "category": "build",
     "description": "TODO marker in production code", "phase": 0,
     "explanation": "TODO comments indicate incomplete implementation. In production code, every TODO should either be completed or tracked as a ticket. Stale TODOs accumulate and signal neglected code paths."},
    {"pattern": r"\bFIXME\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "FIXME marker indicates known bug", "phase": 0,
     "explanation": "FIXME comments mark known bugs or broken behavior. These should be fixed before release or tracked as high-priority tickets. Shipping code with FIXME markers means shipping known defects."},
    {"pattern": r"\bHACK\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "HACK marker indicates technical debt", "phase": 0,
     "explanation": "HACK comments mark intentional shortcuts that should be properly implemented. They indicate technical debt that will cause maintenance issues if not addressed."},
    {"pattern": r"localhost:\d+", "rule": "R12", "severity": "HIGH", "category": "data-integrity",
     "description": "Hardcoded localhost URL in production code", "phase": 7,
     "explanation": "Hardcoded localhost URLs will fail in any deployed environment. Use environment variables for all service URLs so the application works across development, staging, and production."},
    {"pattern": r"NEXT_PUBLIC_.*SECRET", "rule": "R05", "severity": "CRITICAL", "category": "security",
     "description": "Secret exposed via NEXT_PUBLIC_ prefix (visible in browser)", "phase": 1,
     "explanation": "Environment variables prefixed with NEXT_PUBLIC_ are bundled into client-side JavaScript and visible to all users. Secrets (API keys, client secrets) must NEVER use this prefix. Move to server-side only variables."},
    {"pattern": r"document\.cookie", "rule": "R05", "severity": "MEDIUM", "category": "security",
     "description": "Direct cookie manipulation without Secure/SameSite flags", "phase": 1,
     "explanation": "Direct document.cookie access bypasses security best practices. Cookies should be set with Secure (HTTPS only), SameSite (CSRF protection), and HttpOnly (no JavaScript access) flags via a proper cookie library."},
    {"pattern": r"throw\s+new\s+Error\(\s*\)", "rule": "R09", "severity": "MEDIUM", "category": "clean-code",
     "description": "Empty throw Error() with no message", "phase": 5,
     "explanation": "Throwing errors without messages makes debugging impossible. When this error appears in production logs, no one can determine what went wrong or where. Always include a descriptive error message."},
    {"pattern": r"rejectUnauthorized:\s*false", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "TLS certificate validation disabled", "phase": 1,
     "explanation": "Disabling certificate validation allows man-in-the-middle attacks. An attacker on the network can intercept and modify all traffic between the application and the API server. Never disable in production."},
    {"pattern": r"verify:\s*False", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "TLS certificate validation disabled (Python)", "phase": 1,
     "explanation": "Setting verify=False disables SSL certificate checking. An attacker can intercept all data between your application and the server. Always validate certificates in production."},
]

PYTHON_PATTERNS: list[PatternDef] = [
    {"pattern": r"console\.log\(|print\(", "rule": "R09", "severity": "MEDIUM", "category": "clean-code",
     "description": "print() in production code", "phase": 5,
     "explanation": "Print statements in production code clutter stdout and may leak sensitive information. Use a proper logging framework (logging module) with appropriate log levels."},
    {"pattern": r"\bAny\b", "rule": "R07", "severity": "HIGH", "category": "typing",
     "description": "Any type usage bypasses mypy safety", "phase": 2,
     "explanation": "Using Any disables type checking for that value and all code that touches it. Use specific types, generics, or Protocol types instead. Any spreads through the codebase and undermines the type system."},
    {"pattern": r"except\s*:", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "Bare except catches all exceptions including SystemExit", "phase": 1,
     "explanation": "A bare except catches everything including KeyboardInterrupt and SystemExit, making it impossible to stop the program. Catch specific exceptions (e.g., except ValueError, except IOError) to handle only expected failures."},
    {"pattern": r"eval\(", "rule": "R05", "severity": "CRITICAL", "category": "security",
     "description": "eval() usage (code injection risk)", "phase": 1,
     "explanation": "eval() executes arbitrary Python code. If any user input reaches eval, an attacker can execute system commands, read files, or take over the server. Use ast.literal_eval for safe parsing of data structures."},
    {"pattern": r"exec\(", "rule": "R05", "severity": "CRITICAL", "category": "security",
     "description": "exec() usage (code injection risk)", "phase": 1,
     "explanation": "exec() executes arbitrary Python code strings. Like eval(), it's a critical security risk if any user input is involved. Use specific functions or importlib for dynamic behavior instead."},
    {"pattern": r"shell\s*=\s*True", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "subprocess with shell=True (command injection risk)", "phase": 1,
     "explanation": "shell=True passes the command through the system shell, enabling command injection if any part of the command comes from user input. Use shell=False with a list of arguments instead."},
    {"pattern": r"verify\s*=\s*False", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "TLS certificate validation disabled", "phase": 1,
     "explanation": "Setting verify=False disables SSL certificate checking. An attacker on the network can intercept and modify all traffic. Always validate certificates in production."},
    {"pattern": r"\bTODO\b", "rule": "R14", "severity": "LOW", "category": "build",
     "description": "TODO marker in production code", "phase": 0,
     "explanation": "TODO comments indicate incomplete implementation that should be tracked as tickets."},
    {"pattern": r"\bFIXME\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "FIXME marker indicates known bug", "phase": 0,
     "explanation": "FIXME marks known bugs that should be fixed before release."},
    {"pattern": r"localhost:\d+", "rule": "R12", "severity": "HIGH", "category": "data-integrity",
     "description": "Hardcoded localhost URL", "phase": 7,
     "explanation": "Hardcoded localhost URLs will fail in deployed environments. Use environment variables."},
]

JAVA_PATTERNS: list[PatternDef] = [
    {"pattern": r"System\.out\.println\(", "rule": "R14", "severity": "MEDIUM", "category": "clean-code",
     "description": "System.out.println in production code", "phase": 5, "removable": True,
     "explanation": "System.out.println writes directly to stdout and cannot be filtered, routed, or disabled in production. Use a logging framework (SLF4J, Log4j2) with appropriate log levels so output can be configured per environment."},
    {"pattern": r"System\.err\.println\(", "rule": "R14", "severity": "MEDIUM", "category": "clean-code",
     "description": "System.err.println in production code", "phase": 5, "removable": True,
     "explanation": "System.err.println writes directly to stderr without structured formatting or log levels. Replace with a logging framework that supports error-level logging with stack traces and contextual metadata."},
    {"pattern": r"catch\s*\([^)]*\)\s*\{\s*\}", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "Empty catch block silently swallows exceptions", "phase": 0,
     "explanation": "Empty catch blocks hide errors completely, making bugs invisible. Exceptions that should crash the program or trigger alerts are silently ignored. At minimum, log the exception; ideally, handle or rethrow it."},
    {"pattern": r"@SuppressWarnings", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "@SuppressWarnings annotation hides compiler warnings", "phase": 0,
     "explanation": "SuppressWarnings disables compiler checks that exist to catch bugs. Each suppression should have a justification comment. Blanket suppressions (e.g., \"unchecked\", \"rawtypes\") indicate code that should be fixed, not silenced."},
    {"pattern": r"throws\s+Exception\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "throws Exception is too broad", "phase": 2,
     "explanation": "Declaring 'throws Exception' forces callers to catch the broadest possible exception type, preventing specific error handling. Declare specific checked exceptions (IOException, SQLException) so callers can handle each failure mode appropriately."},
    {"pattern": r"instanceof\s+\w+.*instanceof\s+\w+.*instanceof\s+\w+", "rule": "R01", "severity": "MEDIUM", "category": "ssot-dry",
     "description": "instanceof chain suggests missing polymorphism", "phase": 3,
     "explanation": "Multiple instanceof checks in sequence indicate type-switching logic that should be replaced with polymorphism. Each new subtype requires modifying the chain, violating the open-closed principle. Use method overriding or the visitor pattern."},
    {"pattern": r"new\s+ArrayList<>\(\)", "rule": "R04", "severity": "LOW", "category": "performance",
     "description": "new ArrayList<>() where List.of() may suffice for immutable lists", "phase": 5,
     "explanation": "If the list is never modified after creation, use List.of() or Collections.unmodifiableList() instead. Immutable collections are safer in concurrent code, communicate intent clearly, and avoid accidental modification bugs."},
    {"pattern": r"\bList\b[^<]", "rule": "R07", "severity": "MEDIUM", "category": "typing",
     "description": "Raw type without generics bypasses compile-time type safety", "phase": 2,
     "explanation": "Raw types (List instead of List<String>) disable generic type checking. The compiler cannot verify element types, and ClassCastExceptions will occur at runtime instead of being caught at compile time. Always specify the type parameter."},
    {"pattern": r"\bpublic\s+(?:int|long|String|boolean|double|float)\s+\w+\s*;", "rule": "R02", "severity": "MEDIUM", "category": "architecture",
     "description": "Public field should be private with accessor methods", "phase": 3,
     "explanation": "Public fields expose internal state and prevent adding validation, lazy initialization, or change notification later without breaking all callers. Use private fields with getter/setter methods to maintain encapsulation."},
    {"pattern": r"\bTODO\b", "rule": "R14", "severity": "LOW", "category": "build",
     "description": "TODO marker in production code", "phase": 0,
     "explanation": "TODO comments indicate incomplete implementation that should be tracked as tickets and completed before release."},
    {"pattern": r"\bFIXME\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "FIXME marker indicates known bug", "phase": 0,
     "explanation": "FIXME marks known bugs that should be fixed before release or tracked as high-priority tickets."},
    {"pattern": r"\bHACK\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "HACK marker indicates technical debt", "phase": 0,
     "explanation": "HACK comments mark intentional shortcuts that should be properly implemented to avoid long-term maintenance issues."},
    {"pattern": r"https?://[^\s\"']+:\d{2,5}", "rule": "R13", "severity": "HIGH", "category": "clean-code",
     "description": "Hardcoded URL with port number", "phase": 7,
     "explanation": "Hardcoded URLs with ports will fail when services move or ports change across environments. Use configuration properties or environment variables for all service endpoints."},
    {"pattern": r"==\s*null\b", "rule": "R07", "severity": "LOW", "category": "typing",
     "description": "== null check instead of Objects.isNull or Optional", "phase": 5,
     "explanation": "Direct null comparisons are error-prone and verbose. Use Objects.isNull() for predicate references or Optional<T> to represent nullable values explicitly, making null-safety part of the type system."},
]

GO_PATTERNS: list[PatternDef] = [
    {"pattern": r"fmt\.Println\(", "rule": "R14", "severity": "MEDIUM", "category": "clean-code",
     "description": "fmt.Println in production code", "phase": 5, "removable": True,
     "explanation": "fmt.Println writes to stdout without structure or log levels. Use a structured logging library (zerolog, zap, slog) that supports JSON output, log levels, and contextual fields for production observability."},
    {"pattern": r"fmt\.Printf\(", "rule": "R14", "severity": "MEDIUM", "category": "clean-code",
     "description": "fmt.Printf in production code", "phase": 5, "removable": True,
     "explanation": "fmt.Printf writes formatted output to stdout without log levels or structure. Replace with a structured logger that can be filtered and routed in production environments."},
    {"pattern": r"if\s+err\s*!=\s*nil\s*\{\s*\}", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "Empty error check silently swallows errors", "phase": 0,
     "explanation": "Checking err != nil but doing nothing in the block silently ignores errors. This hides bugs and makes failures invisible. At minimum return the error; ideally, wrap it with context using fmt.Errorf or errors.Wrap."},
    {"pattern": r"\binterface\{\}", "rule": "R07", "severity": "MEDIUM", "category": "typing",
     "description": "interface{} should be 'any' in Go 1.18+", "phase": 2,
     "explanation": "Since Go 1.18, the 'any' type alias replaces interface{} for readability. Using interface{} in new code is outdated. Replace with 'any' for clarity, and consider whether a more specific type or generic constraint would be better."},
    {"pattern": r"\bpanic\(", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "panic() crashes the entire program", "phase": 1,
     "explanation": "panic() terminates the goroutine and unwinds the stack, potentially crashing the entire program. Outside of init() or truly unrecoverable situations, return errors instead so callers can handle failures gracefully."},
    {"pattern": r"\bTODO\b", "rule": "R14", "severity": "LOW", "category": "build",
     "description": "TODO marker in production code", "phase": 0,
     "explanation": "TODO comments indicate incomplete implementation that should be tracked as tickets and completed before release."},
    {"pattern": r"\bFIXME\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "FIXME marker indicates known bug", "phase": 0,
     "explanation": "FIXME marks known bugs that should be fixed before release or tracked as high-priority tickets."},
    {"pattern": r"\bHACK\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "HACK marker indicates technical debt", "phase": 0,
     "explanation": "HACK comments mark intentional shortcuts that should be properly implemented to avoid long-term maintenance issues."},
    {"pattern": r"https?://[^\s\"'`]+:\d{2,5}", "rule": "R13", "severity": "HIGH", "category": "clean-code",
     "description": "Hardcoded URL with port number", "phase": 7,
     "explanation": "Hardcoded URLs with ports break across environments. Use configuration or environment variables for all service endpoints."},
    {"pattern": r"_\s*=\s*err\b", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "Silenced error with _ = err", "phase": 0,
     "explanation": "Assigning an error to the blank identifier explicitly discards it. This hides failures that could cause data corruption or silent misbehavior. Handle the error, return it, or log it with context."},
    {"pattern": r"\blog\.Fatal", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "log.Fatal in library code calls os.Exit(1)", "phase": 1,
     "explanation": "log.Fatal calls os.Exit(1) immediately, bypassing deferred functions and preventing graceful shutdown. In library code this is especially dangerous as it removes control from the caller. Return errors instead and let main() decide exit behavior."},
    {"pattern": r"\b\d{3,}\b", "rule": "R13", "severity": "LOW", "category": "clean-code",
     "description": "Magic number in code", "phase": 5,
     "explanation": "Hardcoded numeric literals make code harder to understand and maintain. Extract magic numbers into named constants that convey intent and can be updated in one place."},
]

RUST_PATTERNS: list[PatternDef] = [
    {"pattern": r"\.unwrap\(\)", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "unwrap() panics on None/Err in production code", "phase": 1,
     "explanation": "unwrap() causes a panic if the value is None or Err, crashing the thread. In library code this is especially dangerous. Use pattern matching, unwrap_or, unwrap_or_else, or the ? operator for proper error propagation."},
    {"pattern": r"\.expect\(", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "expect() panics with a message on None/Err", "phase": 1,
     "explanation": "expect() is marginally better than unwrap() as it provides a message, but still panics. In library and application code, prefer the ? operator or match/if-let for recoverable error handling."},
    {"pattern": r"\bunsafe\b", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "unsafe block bypasses Rust's safety guarantees", "phase": 1,
     "explanation": "unsafe blocks disable borrow checking, allowing memory corruption, use-after-free, and data races. Each unsafe block must have a SAFETY comment explaining why the invariants are upheld. Minimize unsafe surface area."},
    {"pattern": r"\bprintln!\(", "rule": "R14", "severity": "MEDIUM", "category": "clean-code",
     "description": "println! in production code", "phase": 5, "removable": True,
     "explanation": "println! writes to stdout without log levels or structure. Use a logging crate (tracing, log, env_logger) that supports structured output, log levels, and can be configured per environment."},
    {"pattern": r"\beprintln!\(", "rule": "R14", "severity": "MEDIUM", "category": "clean-code",
     "description": "eprintln! in production code", "phase": 5, "removable": True,
     "explanation": "eprintln! writes to stderr without structure or log levels. Replace with a logging crate that supports error-level logging with structured context."},
    {"pattern": r"\bTODO\b", "rule": "R14", "severity": "LOW", "category": "build",
     "description": "TODO marker in production code", "phase": 0,
     "explanation": "TODO comments indicate incomplete implementation that should be tracked as tickets and completed before release."},
    {"pattern": r"\bFIXME\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "FIXME marker indicates known bug", "phase": 0,
     "explanation": "FIXME marks known bugs that should be fixed before release or tracked as high-priority tickets."},
    {"pattern": r"\bHACK\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "HACK marker indicates technical debt", "phase": 0,
     "explanation": "HACK comments mark intentional shortcuts that should be properly implemented to avoid long-term maintenance issues."},
    {"pattern": r"\bpub\s+\w+\s*:", "rule": "R02", "severity": "LOW", "category": "architecture",
     "description": "pub struct field may expose internal state", "phase": 3,
     "explanation": "Public struct fields expose implementation details and prevent adding validation or computed values later. Consider using private fields with accessor methods, or builder patterns for construction."},
    {"pattern": r"\.clone\(\)", "rule": "R04", "severity": "LOW", "category": "performance",
     "description": "clone() where borrowing may suffice", "phase": 5,
     "explanation": "Cloning allocates new memory and copies data. If the value is only read, borrow it instead (&T or &mut T). Unnecessary clones hurt performance and obscure ownership semantics."},
    {"pattern": r"#\[allow\(", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "#[allow(...)] suppresses compiler lint warnings", "phase": 0,
     "explanation": "Lint suppressions hide potential issues the compiler would otherwise catch. Each #[allow] should have a justification comment. Fix the underlying issue instead of silencing the warning."},
    {"pattern": r"\bas\s+[a-z]", "rule": "R07", "severity": "MEDIUM", "category": "typing",
     "description": "'as' type cast may silently truncate or wrap values", "phase": 2,
     "explanation": "Rust's 'as' casts can silently truncate integers, lose precision on floats, or wrap around. Use TryFrom/TryInto for fallible conversions, or From/Into for infallible ones, to get compile-time or runtime safety."},
]

# ---- Skip / filter lists -----------------------------------------------------

SKIP_SUBSTRINGS = ("node_modules", ".next", "__tests__", ".test.", ".spec.", "test/")

COMMENT_FILTER_RULES = ("R09", "R07")


# ---- Core logic --------------------------------------------------------------

def get_patterns_for_stack(stack: str) -> list[PatternDef]:
    """Return the pattern list for a given stack identifier."""
    if stack == "typescript":
        return TYPESCRIPT_PATTERNS
    if stack == "python":
        return PYTHON_PATTERNS
    if stack in ("java", "kotlin"):
        return JAVA_PATTERNS
    if stack == "go":
        return GO_PATTERNS
    if stack == "rust":
        return RUST_PATTERNS
    return []


def load_inventory(audit_dir: str) -> tuple[list[str], str, dict[str, str]]:
    """Load inventory.json and return (source_files, stack, file_to_layer)."""
    inv_path = os.path.join(audit_dir, "data/inventory.json")
    with open(inv_path) as fh:
        inv = json.load(fh)
    source_files = [f["path"] for f in inv["files"] if f.get("tag", "SOURCE") in ("SOURCE",)]
    stack = inv.get("stack", "unknown")
    file_to_layer = {f["path"]: f.get("layer", "misc") for f in inv["files"]}
    return source_files, stack, file_to_layer


def _should_skip(rel_path: str) -> bool:
    """Return True if *rel_path* matches a skip substring."""
    return any(skip in rel_path for skip in SKIP_SUBSTRINGS)


def _is_comment(code_stripped: str) -> bool:
    """Return True if the line looks like a comment."""
    return (
        code_stripped.startswith("//")
        or code_stripped.startswith("*")
        or code_stripped.startswith("/*")
        or code_stripped.startswith("#")
    )


def _run_grep(pattern: str, absolute_paths: list[str]) -> str:
    """Run grep -rnE for *pattern* across *absolute_paths*; return stdout."""
    try:
        result = subprocess.run(
            ["grep", "-rnE", pattern] + absolute_paths,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return ""
    return result.stdout


def _build_finding(
    pat_def: PatternDef,
    rel_path: str,
    linenum: int,
    code_stripped: str,
    file_to_layer: dict[str, str],
) -> Finding:
    """Construct a single Finding dict from a grep match."""
    pattern = pat_def["pattern"]
    target_code = pat_def.get("target_code", None)
    if target_code is None and pat_def.get("removable", False):
        target_code = ""

    match = re.search(pattern, code_stripped)
    search_pattern = match.group(0) if match else pattern

    return {
        "rule": pat_def["rule"],
        "severity": pat_def["severity"],
        "category": pat_def["category"],
        "file": rel_path,
        "line": linenum,
        "end_line": linenum,
        "snippet": code_stripped[:200],
        "current_code": code_stripped[:200],
        "description": pat_def["description"],
        "explanation": pat_def["explanation"],
        "search_pattern": search_pattern,
        "target_code": target_code,
        "target_import": None,
        "fix_plan": None,
        "phase": pat_def["phase"],
        "effort": "low",
        "layer": file_to_layer.get(rel_path, "misc"),
        "scanner": "grep-scanner",
    }


def scan_project(
    project_dir: str,
    source_files: list[str],
    stack: str,
    file_to_layer: dict[str, str],
) -> tuple[list[Finding], dict[str, int]]:
    """Run all grep patterns against *source_files* and return (findings, counters).

    Parameters
    ----------
    project_dir:
        Absolute path to the project root.
    source_files:
        Relative paths (from project_dir) of files to scan.
    stack:
        Stack identifier (``"typescript"`` or ``"python"``).
    file_to_layer:
        Mapping from relative path to architectural layer.

    Returns
    -------
    tuple
        ``(findings, counters)`` where *findings* is a list of Finding dicts
        and *counters* maps category-prefix to hit count.
    """
    patterns = get_patterns_for_stack(stack)
    findings: list[Finding] = []
    counters: dict[str, int] = {}

    for pat_def in patterns:
        pattern = pat_def["pattern"]
        abs_paths = [os.path.join(project_dir, f) for f in source_files]
        stdout = _run_grep(pattern, abs_paths)

        for line in stdout.strip().split("\n"):
            if not line.strip():
                continue
            parts = line.split(":", 2)
            if len(parts) < 3:
                continue

            filepath, linenum_str, code = parts[0], parts[1], parts[2]
            rel_path = os.path.relpath(filepath, project_dir)

            if _should_skip(rel_path):
                continue

            code_stripped = code.strip()
            if pat_def["rule"] in COMMENT_FILTER_RULES and _is_comment(code_stripped):
                continue

            category = pat_def["category"]
            prefix = CATEGORY_PREFIX.get(category, "GEN")
            counters[prefix] = counters.get(prefix, 0) + 1

            finding = _build_finding(
                pat_def, rel_path, int(linenum_str), code_stripped, file_to_layer,
            )
            findings.append(finding)

    return findings, counters


def write_results(
    audit_dir: str,
    findings: list[Finding],
    source_files: list[str],
) -> str:
    """Write scanner output files and return the output file path.

    Writes:
    - ``data/scanner-output/grep-scanner.jsonl``
    - ``data/scanner-output/scope-map.json`` (updated)
    - ``data/scanner-output/grep-scanner.status``
    """
    output_file = os.path.join(audit_dir, "data/scanner-output/grep-scanner.jsonl")
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    with open(output_file, "w") as fh:
        for finding in findings:
            fh.write(json.dumps(finding) + "\n")

    scope_map_path = os.path.join(audit_dir, "data/scanner-output/scope-map.json")
    scope_map: dict[str, list[str]] = {}
    if os.path.exists(scope_map_path):
        with open(scope_map_path) as fh:
            scope_map = json.load(fh)
    scope_map["grep-scanner"] = source_files
    with open(scope_map_path, "w") as fh:
        json.dump(scope_map, fh, indent=2)

    status_path = os.path.join(audit_dir, "data/scanner-output/grep-scanner.status")
    with open(status_path, "w") as fh:
        fh.write(f"COMPLETE {len(findings)}\n")

    return output_file


def format_summary(
    findings: list[Finding],
    patterns_count: int,
    files_count: int,
    counters: dict[str, int],
) -> str:
    """Return the human-readable summary printed by the CLI."""
    lines = [
        f"GREP_SCAN_COMPLETE: {len(findings)} findings from {patterns_count} patterns across {files_count} files",
    ]
    removable_count = sum(1 for f in findings if f.get("target_code") is not None)
    lines.append(f"  With target_code (removable): {removable_count}")
    lines.append(f"  Needing enrichment: {len(findings) - removable_count}")
    for prefix, count in sorted(counters.items(), key=lambda x: -x[1]):
        lines.append(f"  {prefix}: {count}")
    return "\n".join(lines)
