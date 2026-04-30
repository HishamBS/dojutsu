"""Shared logic for grep-scanner.

Extracted from grep-scanner.py so tests can import directly
and pytest-cov can measure coverage.
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import subprocess
import sys
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
    confidence: str  # "high" | "medium" | "low"
    confidence_reason: str
    skip_import_lines: bool
    skip_string_literals: bool
    file_glob_excludes: tuple[str, ...]


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
    confidence: str
    confidence_reason: str


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

# ---- Meta-file allowlist constants ------------------------------------------

_META_FILE_DIRECTORY_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^scripts/ci/"),
    re.compile(r"^scripts/ce/"),
    re.compile(r"^scripts/audit/"),
    re.compile(r"^scripts/lint/"),
    re.compile(r"^scripts/policy/"),
)

_META_FILE_NAME_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"/enforce-[^/]+\.(ts|js|py|mjs)$"),
    re.compile(r"/verify-[^/]+\.(ts|js|py|mjs)$"),
    re.compile(r"-rule-[^/]+\.(ts|js|py|mjs)$"),
)

_META_FILE_CONTENT_MARKERS: tuple[str, ...] = (
    "RULE_PATTERNS",
    "PatternDef",
    "RULE_DEFS",
)

_META_FILE_SKIP_RULES: frozenset[str] = frozenset({"R09", "R13", "R14"})

_META_CONTENT_HEAD_LINES: int = 100


def _is_meta_file(rel_path: str, project_dir: str) -> bool:
    """Return True only if all three signals coincide.

    Three signals required:
      1. Directory: file lives under a known meta-file directory.
      2. Filename: name starts with enforce-/verify- or contains -rule-.
      3. Content: first 100 lines contain RULE_PATTERNS, PatternDef, or RULE_DEFS.

    Production files matching directory + filename but lacking a meta-marker
    (e.g., release-publish.ts in scripts/ci/) are NOT allowlisted.
    """
    if not any(p.search(rel_path) for p in _META_FILE_DIRECTORY_PATTERNS):
        return False
    if not any(p.search(rel_path) for p in _META_FILE_NAME_PATTERNS):
        return False
    abs_path = os.path.join(project_dir, rel_path)
    try:
        with open(abs_path, encoding="utf-8") as f:
            head = "".join(f.readline() for _ in range(_META_CONTENT_HEAD_LINES))
    except (OSError, UnicodeDecodeError):
        return False
    return any(marker in head for marker in _META_FILE_CONTENT_MARKERS)


# ---- String-literal stripping (for skip_string_literals patterns) -----------

_TS_LITERAL_RE: re.Pattern[str] = re.compile(
    r"""(?P<sq>'(?:[^'\\\n]|\\.)*')"""          # single-quoted strings
    r"""|(?P<dq>"(?:[^"\\\n]|\\.)*")"""         # double-quoted strings
    r"""|(?P<bt>`(?:[^`\\]|\\.)*`)"""           # backtick template literals (single-line only)
    r"""|(?P<rx>/(?:[^/\\\n]|\\.)+/[gimsuy]*)"""  # regex literals
)


def _strip_string_literals(line: str) -> str:
    """Replace string and regex literals with spaces to prevent false positives.

    Preserves line length so column offsets remain accurate.

    Limitation: per-line only. Multi-line template literal continuation lines
    are not stripped (the opening backtick line is stripped but continuation
    lines appear as bare text). See test_ts_nocheck_inside_multiline_template_is_not_flagged.

    Note: the regex literal arm may match division expressions (a / b / c).
    This is an accepted limitation for the patterns that use skip_string_literals.
    """
    def _replace(m: re.Match[str]) -> str:
        return " " * (m.end() - m.start())
    return _TS_LITERAL_RE.sub(_replace, line)


# ---- Stack-specific patterns -------------------------------------------------

TYPESCRIPT_PATTERNS: list[PatternDef] = [
    # --- Existing patterns (R09, R05, R07, R14, R12) ---
    {"pattern": r"console\.log\(", "rule": "R09", "severity": "MEDIUM", "category": "clean-code",
     "description": "console.log in production code", "phase": 5, "removable": True,
     "explanation": "Console.log statements leak debug information to browser devtools in production. They clutter the console, may expose sensitive data, and indicate incomplete cleanup after development. Remove or replace with a proper logging service.",
     "confidence": "medium", "confidence_reason": "Debug logging left in code (R09-M1)"},
    {"pattern": r"console\.error\(", "rule": "R09", "severity": "LOW", "category": "clean-code",
     "description": "console.error in production code", "phase": 5, "removable": True,
     "explanation": "Console.error should be replaced with structured error reporting in UI components. In server-side routes, console.error may be intentional logging.",
     "confidence": "low", "confidence_reason": "Error logging may be intentional (R09-L1)",
     "layer_exclude": ["api-routes", "routes", "services", "handlers"]},
    {"pattern": r"console\.warn\(", "rule": "R09", "severity": "MEDIUM", "category": "clean-code",
     "description": "console.warn in production code", "phase": 5, "removable": True,
     "explanation": "Console.warn clutters production output. Replace with a structured logging service that can be monitored and filtered.",
     "confidence": "medium", "confidence_reason": "Debug logging left in code (R09-M1)"},
    {"pattern": r"eslint-disable", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "ESLint rule suppressed with eslint-disable", "phase": 0, "removable": True,
     "explanation": "eslint-disable comments bypass lint rules that exist to catch bugs. Each suppression should have a justification comment. Blanket disables indicate code that should be fixed, not silenced.",
     "confidence": "high", "confidence_reason": "Lint suppression detected (R14)",
     "skip_string_literals": True},
    {"pattern": r"dangerouslySetInnerHTML", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "dangerouslySetInnerHTML without sanitization (XSS risk)", "phase": 1,
     "explanation": "Setting innerHTML from untrusted data allows Cross-Site Scripting (XSS) attacks. An attacker can inject malicious scripts that steal session tokens or redirect users. Always sanitize with DOMPurify before rendering HTML.",
     "confidence": "high", "confidence_reason": "XSS-prone API usage (R05)"},
    {"pattern": r"\.innerHTML\s*=", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "Direct innerHTML assignment (XSS risk)", "phase": 1,
     "explanation": "Direct innerHTML assignment bypasses React's built-in XSS protection. Use dangerouslySetInnerHTML with DOMPurify sanitization, or better, parse and render content safely.",
     "confidence": "high", "confidence_reason": "XSS-prone API usage (R05)"},
    {"pattern": r"\beval\(", "rule": "R05", "severity": "CRITICAL", "category": "security",
     "description": "eval() usage (code injection risk)", "phase": 1,
     "explanation": "eval() executes arbitrary code strings. If any user input reaches eval, an attacker can execute arbitrary JavaScript in the user's browser, stealing data or performing actions as the user.",
     "confidence": "high", "confidence_reason": "Code injection vector (R05)"},
    {"pattern": r":\s*any\b", "rule": "R07", "severity": "HIGH", "category": "typing",
     "description": "Explicit 'any' type bypasses TypeScript safety", "phase": 2,
     "explanation": "Using 'any' disables TypeScript's type checking for that value. All downstream code loses type safety, and bugs that the compiler would normally catch become runtime errors. Use a specific type, generic, or 'unknown' instead.",
     "confidence": "high", "confidence_reason": "Unsafe any type usage (R07)"},
    {"pattern": r"as\s+any\b", "rule": "R07", "severity": "HIGH", "category": "typing",
     "description": "Type assertion to 'any' bypasses TypeScript safety", "phase": 2,
     "explanation": "Casting to 'any' silences the type checker but doesn't fix the underlying type mismatch. The code will fail at runtime when the actual type doesn't match expectations. Fix the type properly instead of casting.",
     "confidence": "high", "confidence_reason": "Unsafe any type assertion (R07)",
     "skip_string_literals": True},
    {"pattern": r"=\s*any\b", "rule": "R07", "severity": "HIGH", "category": "typing",
     "description": "Type alias assigned to 'any' bypasses TypeScript safety", "phase": 2,
     "explanation": "Assigning a type alias to 'any' (e.g., type Foo = any) propagates unsafe typing to every usage site. All code using this alias loses type checking. Define a proper type structure or use 'unknown' instead.",
     "confidence": "high", "confidence_reason": "Unsafe any type alias (R07)"},
    {"pattern": r"[<,]\s*any\b", "rule": "R07", "severity": "HIGH", "category": "typing",
     "description": "Generic type parameter 'any' bypasses TypeScript safety", "phase": 2,
     "explanation": "Using 'any' as a generic parameter (e.g., Record<string, any>, Array<any>) defeats the purpose of the generic type. The contained values lose all type safety. Use a specific type, 'unknown', or a type parameter instead.",
     "confidence": "high", "confidence_reason": "Unsafe any type in generic (R07)"},
    {"pattern": r"\bTODO\b", "rule": "R14", "severity": "LOW", "category": "build",
     "description": "TODO marker in production code", "phase": 0,
     "explanation": "TODO comments indicate incomplete implementation. In production code, every TODO should either be completed or tracked as a ticket. Stale TODOs accumulate and signal neglected code paths.",
     "confidence": "high", "confidence_reason": "Incomplete implementation marker (R14)"},
    {"pattern": r"\bFIXME\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "FIXME marker indicates known bug", "phase": 0,
     "explanation": "FIXME comments mark known bugs or broken behavior. These should be fixed before release or tracked as high-priority tickets. Shipping code with FIXME markers means shipping known defects.",
     "confidence": "high", "confidence_reason": "Known bug marker (R14)"},
    {"pattern": r"\bHACK\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "HACK marker indicates technical debt", "phase": 0,
     "explanation": "HACK comments mark intentional shortcuts that should be properly implemented. They indicate technical debt that will cause maintenance issues if not addressed.",
     "confidence": "high", "confidence_reason": "Technical debt marker (R14)"},
    {"pattern": r"localhost:\d+", "rule": "R12", "severity": "HIGH", "category": "data-integrity",
     "description": "Hardcoded localhost URL in production code", "phase": 7,
     "explanation": "Hardcoded localhost URLs will fail in any deployed environment. Use environment variables for all service URLs so the application works across development, staging, and production.",
     "confidence": "high", "confidence_reason": "Hardcoded localhost URL (R12)"},
    {"pattern": r"NEXT_PUBLIC_.*SECRET", "rule": "R05", "severity": "CRITICAL", "category": "security",
     "description": "Secret exposed via NEXT_PUBLIC_ prefix (visible in browser)", "phase": 1,
     "explanation": "Environment variables prefixed with NEXT_PUBLIC_ are bundled into client-side JavaScript and visible to all users. Secrets (API keys, client secrets) must NEVER use this prefix. Move to server-side only variables.",
     "confidence": "high", "confidence_reason": "Secret exposed to client bundle (R05)"},
    {"pattern": r"document\.cookie", "rule": "R05", "severity": "MEDIUM", "category": "security",
     "description": "Direct cookie manipulation without Secure/SameSite flags", "phase": 1,
     "explanation": "Direct document.cookie access bypasses security best practices. Cookies should be set with Secure (HTTPS only), SameSite (CSRF protection), and HttpOnly (no JavaScript access) flags via a proper cookie library.",
     "confidence": "high", "confidence_reason": "Unsafe cookie access (R05)"},
    {"pattern": r"throw\s+new\s+Error\(\s*\)", "rule": "R09", "severity": "MEDIUM", "category": "clean-code",
     "description": "Empty throw Error() with no message", "phase": 5,
     "explanation": "Throwing errors without messages makes debugging impossible. When this error appears in production logs, no one can determine what went wrong or where. Always include a descriptive error message.",
     "confidence": "medium", "confidence_reason": "Empty error message in throw (R09-M1)"},
    {"pattern": r"rejectUnauthorized:\s*false", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "TLS certificate validation disabled", "phase": 1,
     "explanation": "Disabling certificate validation allows man-in-the-middle attacks. An attacker on the network can intercept and modify all traffic between the application and the API server. Never disable in production.",
     "confidence": "high", "confidence_reason": "TLS validation disabled (R05)"},
    {"pattern": r"verify:\s*False", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "TLS certificate validation disabled (Python)", "phase": 1,
     "explanation": "Setting verify=False disables SSL certificate checking. An attacker can intercept all data between your application and the server. Always validate certificates in production.",
     "confidence": "high", "confidence_reason": "TLS validation disabled (R05)"},
    # --- NEW: R13 patterns (magic numbers, inline styles) ---
    {"pattern": r"style=\{\{", "rule": "R13", "severity": "LOW", "category": "clean-code",
     "description": "Inline style object in JSX creates new object each render", "phase": 5,
     "explanation": "Inline style objects like style={{color: 'red'}} create a new object on every render, defeating React.memo and causing unnecessary re-renders. Extract to a constant, useMemo, or CSS/styled-components.",
     "confidence": "medium", "confidence_reason": "Inline style object literal (R13-M1)"},
    {"pattern": r"['\"][0-9]+(?:px|rem|em)['\"]", "rule": "R13", "severity": "LOW", "category": "clean-code",
     "description": "Hardcoded CSS unit value should be a design token", "phase": 5,
     "explanation": "Hardcoded pixel/rem/em values scattered across components make theming and responsive design difficult. Use CSS variables, design tokens, or a spacing scale constant to ensure consistency.",
     "confidence": "medium", "confidence_reason": "Hardcoded CSS unit value (R13-M1)"},
    {"pattern": r"setTimeout\([^,]+,\s*\d{2,}", "rule": "R13", "severity": "MEDIUM", "category": "clean-code",
     "description": "setTimeout with hardcoded delay value", "phase": 5,
     "explanation": "Hardcoded timeout values are magic numbers that obscure intent. Extract to a named constant (e.g., DEBOUNCE_MS, ANIMATION_DELAY) so the purpose is clear and the value can be tuned in one place.",
     "confidence": "medium", "confidence_reason": "Hardcoded timeout delay (R13-M1)"},
    {"pattern": r"setInterval\([^,]+,\s*\d{2,}", "rule": "R13", "severity": "MEDIUM", "category": "clean-code",
     "description": "setInterval with hardcoded interval value", "phase": 5,
     "explanation": "Hardcoded interval values are magic numbers. Extract to a named constant (e.g., POLL_INTERVAL_MS) so the purpose is clear and the value can be changed in one place.",
     "confidence": "medium", "confidence_reason": "Hardcoded interval value (R13-M1)"},
    {"pattern": r"=\{[0-9]{2,}\}", "rule": "R13", "severity": "LOW", "category": "clean-code",
     "description": "Numeric literal in JSX prop should be a named constant", "phase": 5,
     "explanation": "Hardcoded numbers in JSX props (e.g., maxLength={50}, timeout={3000}) are magic numbers. Extract to named constants that explain the intent and can be tuned from one location.",
     "confidence": "medium", "confidence_reason": "Magic number in JSX prop (R13-M1)"},
    # --- NEW: R04 patterns (performance) ---
    # useEffect deps and inline handlers REMOVED — ESLint react-hooks/exhaustive-deps catches these
    # with 0% false positives. Grep regex cannot distinguish missing deps from present deps.
    {"pattern": r"JSON\.parse\(JSON\.stringify\(", "rule": "R04", "severity": "MEDIUM", "category": "performance",
     "description": "JSON.parse(JSON.stringify()) deep clone loses types and is slow", "phase": 4,
     "explanation": "JSON round-tripping for deep clone silently drops undefined values, functions, Dates, RegExps, Maps, Sets, and circular references. Use structuredClone() (modern JS) or a library like lodash.cloneDeep for correct deep copying.",
     "confidence": "medium", "confidence_reason": "Lossy deep clone pattern (R04-M1)"},
    {"pattern": r"new\s+Array\(\d+\)", "rule": "R04", "severity": "LOW", "category": "performance",
     "description": "new Array(n) creates sparse array; prefer Array.from or fill", "phase": 5,
     "explanation": "new Array(n) creates a sparse (holey) array that V8 cannot optimize. Use Array.from({length: n}, fn) or new Array(n).fill(value) to create a dense array with proper values.",
     "confidence": "medium", "confidence_reason": "Sparse array allocation (R04-M1)"},
    {"pattern": r"\.(?:map|filter|reduce)\([^)]*\.\.\.", "rule": "R04", "severity": "LOW", "category": "performance",
     "description": "Spread operator inside map/filter/reduce may cause O(n^2) copies", "phase": 5,
     "explanation": "Using [...spread] inside .map(), .filter(), or .reduce() creates a new array copy on every iteration, leading to O(n^2) memory allocation. Restructure to avoid repeated spreading in hot loops.",
     "confidence": "medium", "confidence_reason": "Quadratic spread in loop (R04-M1)"},
    # --- NEW: R01 patterns (DRY) ---
    {"pattern": r"catch\s*\(\w+\)\s*\{\s*throw\s+\w+\s*;?\s*\}", "rule": "R01", "severity": "LOW", "category": "ssot-dry",
     "description": "Catch block that only rethrows is redundant", "phase": 5,
     "explanation": "A catch block that immediately rethrows the error adds no value. Remove the try-catch entirely and let the error propagate naturally, unless you need to add context or transform the error.",
     "confidence": "high", "confidence_reason": "Redundant catch-rethrow (R01)"},
    {"pattern": r"['\"](?:application/json|Content-Type|Authorization|Bearer )['\"]", "rule": "R01", "severity": "LOW", "category": "ssot-dry",
     "description": "Common string literal that should be a shared constant", "phase": 5,
     "explanation": "Frequently repeated string literals like HTTP headers and content types should be defined once as named constants. This prevents typos and makes updates trivial.",
     "confidence": "high", "confidence_reason": "Duplicated string literal (R01)"},
    # --- NEW: R14 patterns (build/lint suppressions) ---
    {"pattern": r"@ts-ignore", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "@ts-ignore suppresses TypeScript error without explanation", "phase": 0,
     "explanation": "@ts-ignore silences TypeScript errors on the next line. Unlike @ts-expect-error, it does not fail when the error is fixed, leaving stale suppressions. Fix the type error properly or use @ts-expect-error with a description.",
     "confidence": "high", "confidence_reason": "TypeScript error suppression (R14)"},
    {"pattern": r"@ts-expect-error", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "@ts-expect-error suppresses TypeScript error", "phase": 0,
     "explanation": "@ts-expect-error suppresses a known type error. While better than @ts-ignore (it fails when no longer needed), it still hides a type mismatch. Fix the underlying type issue when possible.",
     "confidence": "high", "confidence_reason": "TypeScript error suppression (R14)"},
    {"pattern": r"@ts-nocheck", "rule": "R14", "severity": "CRITICAL", "category": "build",
     "description": "@ts-nocheck disables TypeScript checking for entire file", "phase": 0,
     "explanation": "@ts-nocheck disables all type checking for the entire file. This is almost never acceptable in production code. Fix the type errors individually instead of disabling the type checker wholesale.",
     "confidence": "high", "confidence_reason": "Entire-file type check disabled (R14)",
     "skip_string_literals": True},
    {"pattern": r"as\s+unknown\s+as\b", "rule": "R14", "severity": "HIGH", "category": "typing",
     "description": "Double type assertion (as unknown as) bypasses all type safety", "phase": 2,
     "explanation": "The pattern 'as unknown as T' is a double assertion that bypasses TypeScript's type safety entirely. It forces any value to any type without checking. This almost always indicates a design flaw. Fix the types properly.",
     "confidence": "high", "confidence_reason": "Double type assertion bypass (R14)"},
    {"pattern": r"\w+!\.", "rule": "R14", "severity": "MEDIUM", "category": "typing",
     "description": "Non-null assertion operator (!) bypasses null checking", "phase": 2,
     "explanation": "The non-null assertion operator (!) tells TypeScript a value is not null/undefined without actually checking. If wrong, it causes runtime errors. Use optional chaining (?.), nullish coalescing (??), or proper null checks instead.",
     "confidence": "high", "confidence_reason": "Non-null assertion bypass (R14)"},
    # --- NEW: R05 patterns (security) ---
    {"pattern": r"new\s+Function\(", "rule": "R05", "severity": "CRITICAL", "category": "security",
     "description": "new Function() is equivalent to eval (code injection risk)", "phase": 1,
     "explanation": "new Function() creates a function from a string, equivalent to eval(). If any user input is involved, an attacker can execute arbitrary code. Use regular function definitions or closures instead.",
     "confidence": "high", "confidence_reason": "Code injection vector (R05)"},
    {"pattern": r"window\.location\.href\s*=", "rule": "R05", "severity": "MEDIUM", "category": "security",
     "description": "Direct window.location.href assignment (open redirect risk)", "phase": 1,
     "explanation": "Setting window.location.href with user-controlled input enables open redirect attacks. Validate the URL against an allowlist of domains before redirecting, or use relative paths only.",
     "confidence": "high", "confidence_reason": "Open redirect risk (R05)"},
    {"pattern": r"document\.write\(", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "document.write() can enable XSS and breaks streaming rendering", "phase": 1,
     "explanation": "document.write() can execute injected scripts if called with user input, and it blocks HTML parsing. Use DOM manipulation (createElement, textContent) or React rendering instead.",
     "confidence": "high", "confidence_reason": "XSS and rendering risk (R05)"},
    # --- NEW: R07 pattern (typing) ---
    {"pattern": r"<any>", "rule": "R07", "severity": "HIGH", "category": "typing",
     "description": "Angle-bracket type assertion to any", "phase": 2,
     "explanation": "The angle-bracket assertion <any>value is equivalent to 'value as any' and bypasses all type checking. Fix the underlying type mismatch instead of casting to any.",
     "confidence": "high", "confidence_reason": "Unsafe any type assertion (R07)"},
    # --- Task 6: literal R12 sub-cases (additive; LLM scanner unchanged) ---
    {"pattern": r"['\"]0['\"]\.repeat\(\s*(40|64)\s*\)",
     "rule": "R12", "severity": "MEDIUM", "category": "data-integrity",
     "description": "Placeholder hash literal — 40-zero or 64-zero string used as fake commit/SHA.",
     "phase": 7,
     "explanation": "Synthetic zero-length hashes mask missing data. Downstream consumers comparing hashes silently match the placeholder.",
     "confidence": "high", "confidence_reason": "Placeholder hash literal (R12)"},
    {"pattern": r"['\"`]https?://localhost[:/]",
     "rule": "R12", "severity": "MEDIUM", "category": "data-integrity",
     "description": "Hardcoded localhost URL.",
     "phase": 7,
     "explanation": "Localhost URLs in non-test code break in any environment that is not the developer's machine.",
     "confidence": "high", "confidence_reason": "Hardcoded localhost URL (R12)",
     "file_glob_excludes": ("**/*.test.ts", "**/*.test.tsx", "**/test/**", "**/tests/**", "**/__tests__/**", "**/*.spec.ts")},
    # --- Task 6: literal R13 sub-cases (additive; LLM scanner unchanged) ---
    {"pattern": r"['\"`]@humain/sdk['\"`]|['\"`]humain-sdk['\"`]|['\"`]com\.humain\.sdk['\"`]",
     "rule": "R13", "severity": "MEDIUM", "category": "ssot-dry",
     "description": "SDK package-name literal — should come from @humain/shared-constants.",
     "phase": 5,
     "explanation": "Hardcoded package identifiers across multiple files cause drift when packages are renamed.",
     "confidence": "high", "confidence_reason": "SDK package-name literal (R13)"},
    {"pattern": r"['\"`]\.h1-(routes|manifest)\.json['\"`]",
     "rule": "R13", "severity": "MEDIUM", "category": "ssot-dry",
     "description": "h1 manifest filename literal — should come from MANIFEST_FILE_NAME / ROUTE_MANIFEST_FILE_NAME SSOT.",
     "phase": 5,
     "explanation": "Manifest filenames are emitted by the h1 build and consumed in many places. The SSOT export already exists.",
     "confidence": "high", "confidence_reason": "h1 manifest filename literal (R13)"},
]

PYTHON_PATTERNS: list[PatternDef] = [
    # --- Existing patterns ---
    {"pattern": r"console\.log\(|print\(", "rule": "R09", "severity": "MEDIUM", "category": "clean-code",
     "description": "print() in production code", "phase": 5,
     "explanation": "Print statements in production code clutter stdout and may leak sensitive information. Use a proper logging framework (logging module) with appropriate log levels.",
     "confidence": "medium", "confidence_reason": "Debug print left in code (R09-M1)"},
    {"pattern": r"\bAny\b", "rule": "R07", "severity": "HIGH", "category": "typing",
     "description": "Any type usage bypasses mypy safety", "phase": 2,
     "explanation": "Using Any disables type checking for that value and all code that touches it. Use specific types, generics, or Protocol types instead. Any spreads through the codebase and undermines the type system.",
     "confidence": "high", "confidence_reason": "Unsafe Any type usage (R07)"},
    {"pattern": r"except\s*:", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "Bare except catches all exceptions including SystemExit", "phase": 1,
     "explanation": "A bare except catches everything including KeyboardInterrupt and SystemExit, making it impossible to stop the program. Catch specific exceptions (e.g., except ValueError, except IOError) to handle only expected failures.",
     "confidence": "high", "confidence_reason": "Bare except catches all exceptions (R05)"},
    {"pattern": r"eval\(", "rule": "R05", "severity": "CRITICAL", "category": "security",
     "description": "eval() usage (code injection risk)", "phase": 1,
     "explanation": "eval() executes arbitrary Python code. If any user input reaches eval, an attacker can execute system commands, read files, or take over the server. Use ast.literal_eval for safe parsing of data structures.",
     "confidence": "high", "confidence_reason": "Code injection vector (R05)"},
    {"pattern": r"exec\(", "rule": "R05", "severity": "CRITICAL", "category": "security",
     "description": "exec() usage (code injection risk)", "phase": 1,
     "explanation": "exec() executes arbitrary Python code strings. Like eval(), it's a critical security risk if any user input is involved. Use specific functions or importlib for dynamic behavior instead.",
     "confidence": "high", "confidence_reason": "Code injection vector (R05)"},
    {"pattern": r"shell\s*=\s*True", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "subprocess with shell=True (command injection risk)", "phase": 1,
     "explanation": "shell=True passes the command through the system shell, enabling command injection if any part of the command comes from user input. Use shell=False with a list of arguments instead.",
     "confidence": "high", "confidence_reason": "Shell injection vector (R05)"},
    {"pattern": r"verify\s*=\s*False", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "TLS certificate validation disabled", "phase": 1,
     "explanation": "Setting verify=False disables SSL certificate checking. An attacker on the network can intercept and modify all traffic. Always validate certificates in production.",
     "confidence": "high", "confidence_reason": "TLS validation disabled (R05)"},
    {"pattern": r"\bTODO\b", "rule": "R14", "severity": "LOW", "category": "build",
     "description": "TODO marker in production code", "phase": 0,
     "explanation": "TODO comments indicate incomplete implementation that should be tracked as tickets.",
     "confidence": "high", "confidence_reason": "Incomplete implementation marker (R14)"},
    {"pattern": r"\bFIXME\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "FIXME marker indicates known bug", "phase": 0,
     "explanation": "FIXME marks known bugs that should be fixed before release.",
     "confidence": "high", "confidence_reason": "Known bug marker (R14)"},
    {"pattern": r"localhost:\d+", "rule": "R12", "severity": "HIGH", "category": "data-integrity",
     "description": "Hardcoded localhost URL", "phase": 7,
     "explanation": "Hardcoded localhost URLs will fail in deployed environments. Use environment variables.",
     "confidence": "high", "confidence_reason": "Hardcoded localhost URL (R12)"},
    # --- NEW: R13 patterns (magic numbers) ---
    {"pattern": r"\b\d{4,}\b", "rule": "R13", "severity": "LOW", "category": "clean-code",
     "description": "Numeric literal in function body should be a named constant", "phase": 5,
     "explanation": "Hardcoded numeric literals make code harder to understand and maintain. Extract magic numbers into named constants that convey intent and can be updated in one place.",
     "confidence": "medium", "confidence_reason": "Hardcoded numeric literal (R13-M1)"},
    {"pattern": r"time\.sleep\(\s*\d+", "rule": "R13", "severity": "MEDIUM", "category": "clean-code",
     "description": "time.sleep with hardcoded duration", "phase": 5,
     "explanation": "Hardcoded sleep durations are magic numbers. Extract to a named constant (e.g., RETRY_DELAY_SECONDS) so the purpose is clear and the value can be tuned without searching for literals.",
     "confidence": "medium", "confidence_reason": "Hardcoded sleep duration (R13-M1)"},
    {"pattern": r"https?://(?!localhost)[^\s\"']+", "rule": "R13", "severity": "MEDIUM", "category": "clean-code",
     "description": "Hardcoded URL should be in configuration", "phase": 7,
     "explanation": "Hardcoded URLs break when services move or environments change. Use environment variables or configuration files for all external service endpoints.",
     "confidence": "medium", "confidence_reason": "Hardcoded URL literal (R13-M1)"},
    # --- NEW: R04 patterns (performance) ---
    {"pattern": r"for\s+\w+\s+in\s+.*:\s*$", "rule": "R04", "severity": "LOW", "category": "performance",
     "description": "for...append pattern may be a list comprehension candidate", "phase": 5,
     "explanation": "A for loop that only appends to a list is better expressed as a list comprehension. List comprehensions are faster (optimized C loop internally) and more idiomatic Python.",
     "confidence": "medium", "confidence_reason": "Possible list comprehension candidate (R04-M1)"},
    {"pattern": r"len\(\w+\)\s*==\s*0", "rule": "R04", "severity": "LOW", "category": "performance",
     "description": "len(x)==0 should be 'not x' for truthiness check", "phase": 5,
     "explanation": "In Python, empty collections are falsy. Use 'if not x' instead of 'if len(x) == 0' for cleaner, more Pythonic code. The truthiness check is also marginally faster.",
     "confidence": "medium", "confidence_reason": "Non-idiomatic length check (R04-M1)"},
    {"pattern": r"len\(\w+\)\s*>\s*0", "rule": "R04", "severity": "LOW", "category": "performance",
     "description": "len(x)>0 should be just 'x' for truthiness check", "phase": 5,
     "explanation": "In Python, non-empty collections are truthy. Use 'if x' instead of 'if len(x) > 0' for cleaner, more Pythonic code.",
     "confidence": "medium", "confidence_reason": "Non-idiomatic length check (R04-M1)"},
    # --- NEW: R01 patterns (DRY) ---
    {"pattern": r"isinstance\(\w+,\s*\w+\).*isinstance\(\w+,\s*\w+\)", "rule": "R01", "severity": "MEDIUM", "category": "ssot-dry",
     "description": "Repeated isinstance checks suggest missing polymorphism", "phase": 3,
     "explanation": "Multiple isinstance checks indicate type-switching logic that should use polymorphism, a dispatch table, or functools.singledispatch. Each new type requires modifying the chain.",
     "confidence": "high", "confidence_reason": "Type-switching instead of polymorphism (R01)"},
    # --- NEW: R14 patterns (suppressions) ---
    {"pattern": r"#\s*type:\s*ignore", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "type: ignore suppresses mypy error", "phase": 0,
     "explanation": "type: ignore comments suppress mypy type checking errors. Each suppression should have a specific error code (e.g., type: ignore[attr-defined]) and justification. Fix the type error when possible.",
     "confidence": "high", "confidence_reason": "Type checker suppression (R14)"},
    {"pattern": r"except\s+\w+.*:\s*\n?\s*pass\b", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "pass in except block silently swallows exception", "phase": 0,
     "explanation": "Using pass in an except block silently discards the error. This hides bugs and makes debugging impossible. At minimum, log the exception; ideally, handle it properly or let it propagate.",
     "confidence": "high", "confidence_reason": "Silently swallowed exception (R14)"},
    {"pattern": r"#\s*noqa", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "noqa suppresses linter warning", "phase": 0,
     "explanation": "noqa comments suppress linter warnings. Each suppression should specify the exact rule (e.g., # noqa: E501) and have a justification. Fix the underlying issue instead of silencing warnings.",
     "confidence": "high", "confidence_reason": "Linter suppression (R14)"},
    # --- NEW: R05 patterns (security) ---
    {"pattern": r"os\.system\(", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "os.system() executes shell commands (command injection risk)", "phase": 1,
     "explanation": "os.system() runs commands through the shell, enabling command injection if any user input is involved. Use subprocess.run with shell=False and a list of arguments instead.",
     "confidence": "high", "confidence_reason": "Shell command injection vector (R05)"},
    {"pattern": r"pickle\.loads?\(", "rule": "R05", "severity": "CRITICAL", "category": "security",
     "description": "pickle.load/loads can execute arbitrary code on deserialization", "phase": 1,
     "explanation": "Pickle deserialization can execute arbitrary Python code embedded in the data. An attacker who controls the pickled data can take over the server. Use JSON, msgpack, or other safe formats for untrusted data.",
     "confidence": "high", "confidence_reason": "Arbitrary code execution via pickle (R05)"},
    {"pattern": r"yaml\.load\([^)]*$", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "yaml.load without explicit Loader allows code execution", "phase": 1,
     "explanation": "yaml.load without a safe Loader (e.g., yaml.safe_load or Loader=yaml.SafeLoader) can execute arbitrary Python code. Always use yaml.safe_load() or specify Loader=yaml.SafeLoader.",
     "confidence": "high", "confidence_reason": "Unsafe YAML deserialization (R05)"},
    {"pattern": r"\bHACK\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "HACK marker indicates technical debt", "phase": 0,
     "explanation": "HACK comments mark intentional shortcuts that should be properly implemented to avoid long-term maintenance issues.",
     "confidence": "high", "confidence_reason": "Technical debt marker (R14)"},
    {"pattern": r"except\s+Exception\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "Broad except Exception may hide unexpected errors", "phase": 1,
     "explanation": "Catching the broad Exception type catches almost all errors, including programming bugs like AttributeError and TypeError that indicate real problems. Catch specific exception types to handle only expected failures.",
     "confidence": "high", "confidence_reason": "Overly broad exception handler (R14)"},
    {"pattern": r"subprocess\.call\(", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "subprocess.call is less safe than subprocess.run", "phase": 1,
     "explanation": "subprocess.call does not capture output and has less control than subprocess.run. Use subprocess.run with explicit arguments, capture_output=True, and shell=False for safer process execution.",
     "confidence": "high", "confidence_reason": "Less safe subprocess API (R05)"},
    # --- Task 6: literal R12/R13 sub-cases (additive; LLM scanner unchanged) ---
    {"pattern": r"['\"]0['\"] \* (40|64)\b|b['\"]0['\"] \* (40|64)\b",
     "rule": "R12", "severity": "MEDIUM", "category": "data-integrity",
     "description": "Placeholder hash literal — 40-zero or 64-zero bytes/string used as fake commit/SHA.",
     "phase": 7,
     "explanation": "Synthetic zero-length hashes mask missing data. Downstream consumers comparing hashes silently match the placeholder.",
     "confidence": "high", "confidence_reason": "Placeholder hash literal (R12)"},
    {"pattern": r"['\"]https?://localhost[:/]",
     "rule": "R12", "severity": "MEDIUM", "category": "data-integrity",
     "description": "Hardcoded localhost URL.",
     "phase": 7,
     "explanation": "Localhost URLs in non-test code break in any environment that is not the developer's machine.",
     "confidence": "high", "confidence_reason": "Hardcoded localhost URL (R12)",
     "file_glob_excludes": ("**/test_*.py", "**/*_test.py", "**/test/**", "**/tests/**", "**/*_tests.py")},
    {"pattern": r"['\"]\.h1-(routes|manifest)\.json['\"]",
     "rule": "R13", "severity": "MEDIUM", "category": "ssot-dry",
     "description": "h1 manifest filename literal — should come from MANIFEST_FILE_NAME / ROUTE_MANIFEST_FILE_NAME SSOT.",
     "phase": 5,
     "explanation": "Manifest filenames are emitted by the h1 build and consumed in many places. The SSOT export already exists.",
     "confidence": "high", "confidence_reason": "h1 manifest filename literal (R13)"},
]

JAVA_PATTERNS: list[PatternDef] = [
    # --- Existing patterns ---
    {"pattern": r"System\.out\.println\(", "rule": "R14", "severity": "MEDIUM", "category": "clean-code",
     "description": "System.out.println in production code", "phase": 5, "removable": True,
     "explanation": "System.out.println writes directly to stdout and cannot be filtered, routed, or disabled in production. Use a logging framework (SLF4J, Log4j2) with appropriate log levels so output can be configured per environment.",
     "confidence": "medium", "confidence_reason": "Debug println left in code (R09-M1)"},
    {"pattern": r"System\.err\.println\(", "rule": "R14", "severity": "MEDIUM", "category": "clean-code",
     "description": "System.err.println in production code", "phase": 5, "removable": True,
     "explanation": "System.err.println writes directly to stderr without structured formatting or log levels. Replace with a logging framework that supports error-level logging with stack traces and contextual metadata.",
     "confidence": "low", "confidence_reason": "Error logging may be intentional (R09-L1)"},
    {"pattern": r"catch\s*\([^)]*\)\s*\{\s*\}", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "Empty catch block silently swallows exceptions", "phase": 0,
     "explanation": "Empty catch blocks hide errors completely, making bugs invisible. Exceptions that should crash the program or trigger alerts are silently ignored. At minimum, log the exception; ideally, handle or rethrow it.",
     "confidence": "high", "confidence_reason": "Silently swallowed exception (R14)"},
    {"pattern": r"@SuppressWarnings", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "@SuppressWarnings annotation hides compiler warnings", "phase": 0,
     "explanation": "SuppressWarnings disables compiler checks that exist to catch bugs. Each suppression should have a justification comment. Blanket suppressions indicate code that should be fixed, not silenced.",
     "confidence": "high", "confidence_reason": "Compiler warning suppression (R14)"},
    {"pattern": r"throws\s+Exception\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "throws Exception is too broad", "phase": 2,
     "explanation": "Declaring 'throws Exception' forces callers to catch the broadest possible exception type, preventing specific error handling. Declare specific checked exceptions so callers can handle each failure mode appropriately.",
     "confidence": "high", "confidence_reason": "Overly broad exception declaration (R14)"},
    {"pattern": r"instanceof\s+\w+.*instanceof\s+\w+.*instanceof\s+\w+", "rule": "R01", "severity": "MEDIUM", "category": "ssot-dry",
     "description": "instanceof chain suggests missing polymorphism", "phase": 3,
     "explanation": "Multiple instanceof checks in sequence indicate type-switching logic that should be replaced with polymorphism. Each new subtype requires modifying the chain, violating the open-closed principle.",
     "confidence": "high", "confidence_reason": "Type-switching instead of polymorphism (R01)"},
    {"pattern": r"new\s+ArrayList<>\(\)", "rule": "R04", "severity": "LOW", "category": "performance",
     "description": "new ArrayList<>() where List.of() may suffice for immutable lists", "phase": 5,
     "explanation": "If the list is never modified after creation, use List.of() or Collections.unmodifiableList() instead. Immutable collections are safer in concurrent code, communicate intent clearly, and avoid accidental modification bugs.",
     "confidence": "medium", "confidence_reason": "Mutable list where immutable may suffice (R04-M1)"},
    {"pattern": r"\bList\b[^<]", "rule": "R07", "severity": "MEDIUM", "category": "typing",
     "description": "Raw type without generics bypasses compile-time type safety", "phase": 2,
     "explanation": "Raw types (List instead of List<String>) disable generic type checking. The compiler cannot verify element types, and ClassCastExceptions will occur at runtime instead of being caught at compile time.",
     "confidence": "high", "confidence_reason": "Raw type without generics (R07)",
     "skip_import_lines": True},
    {"pattern": r"\bpublic\s+(?:int|long|String|boolean|double|float)\s+\w+\s*;", "rule": "R02", "severity": "MEDIUM", "category": "architecture",
     "description": "Public field should be private with accessor methods", "phase": 3,
     "explanation": "Public fields expose internal state and prevent adding validation, lazy initialization, or change notification later without breaking all callers. Use private fields with getter/setter methods.",
     "confidence": "medium", "confidence_reason": "Public field exposing internal state (R04-M1)"},
    {"pattern": r"\bTODO\b", "rule": "R14", "severity": "LOW", "category": "build",
     "description": "TODO marker in production code", "phase": 0,
     "explanation": "TODO comments indicate incomplete implementation that should be tracked as tickets and completed before release.",
     "confidence": "high", "confidence_reason": "Incomplete implementation marker (R14)"},
    {"pattern": r"\bFIXME\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "FIXME marker indicates known bug", "phase": 0,
     "explanation": "FIXME marks known bugs that should be fixed before release or tracked as high-priority tickets.",
     "confidence": "high", "confidence_reason": "Known bug marker (R14)"},
    {"pattern": r"\bHACK\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "HACK marker indicates technical debt", "phase": 0,
     "explanation": "HACK comments mark intentional shortcuts that should be properly implemented to avoid long-term maintenance issues.",
     "confidence": "high", "confidence_reason": "Technical debt marker (R14)"},
    {"pattern": r"https?://[^\s\"']+:\d{2,5}", "rule": "R13", "severity": "HIGH", "category": "clean-code",
     "description": "Hardcoded URL with port number", "phase": 7,
     "explanation": "Hardcoded URLs with ports will fail when services move or ports change across environments. Use configuration properties or environment variables.",
     "confidence": "medium", "confidence_reason": "Hardcoded URL with port (R13-M1)"},
    # == null REMOVED — idiomatic Java; Objects.isNull() is not more correct, just style preference
    # --- NEW: R13 patterns (magic numbers) ---
    {"pattern": r"\b\d{6,}\b", "rule": "R13", "severity": "LOW", "category": "clean-code",
     "description": "Large magic number in code (6+ digits)", "phase": 5,
     "explanation": "Large hardcoded numeric literals make code harder to understand. Extract into named constants that convey intent.",
     "confidence": "medium", "confidence_reason": "Large hardcoded numeric literal (R13-M1)"},
    {"pattern": r"Thread\.sleep\(\s*\d+", "rule": "R13", "severity": "MEDIUM", "category": "clean-code",
     "description": "Thread.sleep with hardcoded duration", "phase": 5,
     "explanation": "Hardcoded sleep durations are magic numbers. Extract to a named constant (e.g., RETRY_DELAY_MS) so the purpose is clear and the value can be tuned in one place.",
     "confidence": "medium", "confidence_reason": "Hardcoded sleep duration (R13-M1)"},
    {"pattern": r"new\s+ServerSocket\(\s*\d+", "rule": "R13", "severity": "MEDIUM", "category": "clean-code",
     "description": "Hardcoded port number should be a configuration constant", "phase": 7,
     "explanation": "Hardcoded port numbers break across environments. Use configuration properties or environment variables for all port assignments.",
     "confidence": "medium", "confidence_reason": "Hardcoded port number (R13-M1)"},
    # --- NEW: R04 patterns (performance) ---
    {"pattern": r"\+=\s*\"", "rule": "R04", "severity": "MEDIUM", "category": "performance",
     "description": "String concatenation with += creates O(n^2) copies in a loop", "phase": 4,
     "explanation": "String += in Java creates a new String object each time, copying all previous characters. This is O(n^2) for n iterations. Use StringBuilder for efficient string building in loops.",
     "confidence": "medium", "confidence_reason": "Quadratic string concatenation (R04-M1)"},
    {"pattern": r"new\s+HashMap<>\(\).*\bfor\b", "rule": "R04", "severity": "LOW", "category": "performance",
     "description": "new HashMap inside loop causes repeated allocation", "phase": 4,
     "explanation": "Creating HashMap instances inside a loop causes repeated heap allocation and GC pressure. Pre-allocate outside the loop or use a single Map with appropriate keys.",
     "confidence": "medium", "confidence_reason": "Allocation inside loop (R04-M1)"},
    # --- NEW: R01 patterns (DRY) ---
    {"pattern": r"catch\s*\(\w+\s+\w+\)\s*\{\s*throw\s+\w+\s*;?\s*\}", "rule": "R01", "severity": "LOW", "category": "ssot-dry",
     "description": "Catch block that only rethrows is redundant", "phase": 5,
     "explanation": "A catch block that immediately rethrows the exception adds no value. Remove the try-catch and let the exception propagate naturally, or add context before rethrowing.",
     "confidence": "high", "confidence_reason": "Redundant catch-rethrow (R01)"},
    # --- NEW: R05 patterns (security) ---
    {"pattern": r"Runtime\.getRuntime\(\)\.exec\(", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "Runtime.exec() can enable command injection", "phase": 1,
     "explanation": "Runtime.exec() executes system commands. If any user input is included, an attacker can inject additional commands. Use ProcessBuilder with explicit argument arrays instead.",
     "confidence": "high", "confidence_reason": "Command injection vector (R05)"},
    {"pattern": r"\"\s*\+\s*\w+\s*\+\s*\".*(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)", "rule": "R05", "severity": "CRITICAL", "category": "security",
     "description": "SQL string concatenation (SQL injection risk)", "phase": 1,
     "explanation": "Building SQL queries by concatenating strings with user input enables SQL injection attacks. Use PreparedStatement with parameterized queries to safely bind values.",
     "confidence": "high", "confidence_reason": "SQL injection vector (R05)"},
    {"pattern": r"@RequestParam\b(?!.*@Valid)", "rule": "R05", "severity": "MEDIUM", "category": "security",
     "description": "@RequestParam without validation", "phase": 2,
     "explanation": "Request parameters without validation (@Valid, @Size, @Pattern) accept any input. Apply Bean Validation annotations to constrain input and prevent injection attacks.",
     "confidence": "high", "confidence_reason": "Unvalidated request parameter (R05)"},
    # --- NEW: R14 patterns ---
    {"pattern": r"@SuppressWarnings\s*\(\s*\"unchecked\"\s*\)", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "@SuppressWarnings(\"unchecked\") hides unsafe generic cast", "phase": 0,
     "explanation": "Suppressing unchecked warnings hides unsafe generic type casts that can cause ClassCastException at runtime. Fix the generic types properly or add a documented justification.",
     "confidence": "high", "confidence_reason": "Unsafe generic cast suppression (R14)"},
    {"pattern": r"e\.printStackTrace\(\)", "rule": "R14", "severity": "MEDIUM", "category": "clean-code",
     "description": "printStackTrace() in production code", "phase": 5, "removable": True,
     "explanation": "printStackTrace() writes to stderr without structure or log levels. Replace with a logging framework call that captures the exception with proper context and can be monitored.",
     "confidence": "medium", "confidence_reason": "Debug println left in code (R09-M1)"},
    # --- Task 6: literal R13 sub-cases (additive; LLM scanner unchanged) ---
    {"pattern": r'"\.h1-(routes|manifest)\.json"',
     "rule": "R13", "severity": "MEDIUM", "category": "ssot-dry",
     "description": "h1 manifest filename literal — should come from a SSOT constant.",
     "phase": 5,
     "explanation": "Manifest filenames are emitted by the h1 build and consumed in many places. Define a shared constant and import it.",
     "confidence": "high", "confidence_reason": "h1 manifest filename literal (R13)"},
    {"pattern": r'"com\.humain\.sdk"',
     "rule": "R13", "severity": "MEDIUM", "category": "ssot-dry",
     "description": "SDK package-name literal — should come from a shared constants class.",
     "phase": 5,
     "explanation": "Hardcoded package identifiers across multiple files cause drift when packages are renamed.",
     "confidence": "high", "confidence_reason": "SDK package-name literal (R13)"},
]

GO_PATTERNS: list[PatternDef] = [
    # --- Existing patterns ---
    {"pattern": r"fmt\.Println\(", "rule": "R14", "severity": "MEDIUM", "category": "clean-code",
     "description": "fmt.Println in production code", "phase": 5, "removable": True,
     "explanation": "fmt.Println writes to stdout without structure or log levels. Use a structured logging library (zerolog, zap, slog) that supports JSON output, log levels, and contextual fields for production observability.",
     "confidence": "medium", "confidence_reason": "Debug println left in code (R09-M1)"},
    {"pattern": r"fmt\.Printf\(", "rule": "R14", "severity": "MEDIUM", "category": "clean-code",
     "description": "fmt.Printf in production code", "phase": 5, "removable": True,
     "explanation": "fmt.Printf writes formatted output to stdout without log levels or structure. Replace with a structured logger that can be filtered and routed in production environments.",
     "confidence": "medium", "confidence_reason": "Debug printf left in code (R09-M1)"},
    {"pattern": r"if\s+err\s*!=\s*nil\s*\{\s*\}", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "Empty error check silently swallows errors", "phase": 0,
     "explanation": "Checking err != nil but doing nothing in the block silently ignores errors. This hides bugs and makes failures invisible. At minimum return the error; ideally, wrap it with context using fmt.Errorf or errors.Wrap.",
     "confidence": "high", "confidence_reason": "Silently swallowed error (R14)"},
    {"pattern": r"\binterface\{\}", "rule": "R07", "severity": "MEDIUM", "category": "typing",
     "description": "interface{} should be 'any' in Go 1.18+", "phase": 2,
     "explanation": "Since Go 1.18, the 'any' type alias replaces interface{} for readability. Using interface{} in new code is outdated. Replace with 'any' for clarity.",
     "confidence": "high", "confidence_reason": "Outdated interface{} usage (R07)"},
    {"pattern": r"\bpanic\(", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "panic() crashes the entire program", "phase": 1,
     "explanation": "panic() terminates the goroutine and unwinds the stack, potentially crashing the entire program. Outside of init() or truly unrecoverable situations, return errors instead.",
     "confidence": "high", "confidence_reason": "Program-crashing panic call (R14)"},
    {"pattern": r"\bTODO\b", "rule": "R14", "severity": "LOW", "category": "build",
     "description": "TODO marker in production code", "phase": 0,
     "explanation": "TODO comments indicate incomplete implementation that should be tracked as tickets and completed before release.",
     "confidence": "high", "confidence_reason": "Incomplete implementation marker (R14)"},
    {"pattern": r"\bFIXME\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "FIXME marker indicates known bug", "phase": 0,
     "explanation": "FIXME marks known bugs that should be fixed before release or tracked as high-priority tickets.",
     "confidence": "high", "confidence_reason": "Known bug marker (R14)"},
    {"pattern": r"\bHACK\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "HACK marker indicates technical debt", "phase": 0,
     "explanation": "HACK comments mark intentional shortcuts that should be properly implemented to avoid long-term maintenance issues.",
     "confidence": "high", "confidence_reason": "Technical debt marker (R14)"},
    {"pattern": r"https?://[^\s\"'`]+:\d{2,5}", "rule": "R13", "severity": "HIGH", "category": "clean-code",
     "description": "Hardcoded URL with port number", "phase": 7,
     "explanation": "Hardcoded URLs with ports break across environments. Use configuration or environment variables for all service endpoints.",
     "confidence": "medium", "confidence_reason": "Hardcoded URL with port (R13-M1)"},
    {"pattern": r"_\s*=\s*err\b", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "Silenced error with _ = err", "phase": 0,
     "explanation": "Assigning an error to the blank identifier explicitly discards it. This hides failures that could cause data corruption or silent misbehavior. Handle the error, return it, or log it with context.",
     "confidence": "high", "confidence_reason": "Explicitly discarded error (R14)"},
    {"pattern": r"\blog\.Fatal", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "log.Fatal in library code calls os.Exit(1)", "phase": 1,
     "explanation": "log.Fatal calls os.Exit(1) immediately, bypassing deferred functions and preventing graceful shutdown. Return errors instead and let main() decide exit behavior.",
     "confidence": "high", "confidence_reason": "Fatal exit in library code (R14)"},
    {"pattern": r"\b\d{3,}\b", "rule": "R13", "severity": "LOW", "category": "clean-code",
     "description": "Magic number in code", "phase": 5,
     "explanation": "Hardcoded numeric literals make code harder to understand and maintain. Extract magic numbers into named constants that convey intent and can be updated in one place.",
     "confidence": "medium", "confidence_reason": "Hardcoded numeric literal (R13-M1)"},
    # --- NEW: R04 patterns (performance) ---
    {"pattern": r"append\(\w+,\s*\w+\)", "rule": "R04", "severity": "LOW", "category": "performance",
     "description": "append without pre-allocation; consider make([]T, 0, cap)", "phase": 5,
     "explanation": "Repeatedly appending to a slice without pre-allocation causes multiple re-allocations as the slice grows. If the final size is known or estimable, use make([]T, 0, expectedCap) to pre-allocate.",
     "confidence": "medium", "confidence_reason": "Slice append without pre-allocation (R04-M1)"},
    {"pattern": r"string\(\[\]byte\(", "rule": "R04", "severity": "LOW", "category": "performance",
     "description": "string([]byte) conversion in loop copies data each iteration", "phase": 5,
     "explanation": "Converting between string and []byte copies the data each time. In a loop, this creates significant garbage. Consider using bytes.Buffer or strings.Builder to accumulate results.",
     "confidence": "medium", "confidence_reason": "Repeated string/byte conversion (R04-M1)"},
    # --- NEW: R01 patterns (DRY) ---
    {"pattern": r"errors\.New\(\"[^\"]+\"\)", "rule": "R01", "severity": "LOW", "category": "ssot-dry",
     "description": "Inline error string should be a package-level sentinel variable", "phase": 5,
     "explanation": "Inline error messages created with errors.New should be defined as package-level sentinel errors (var ErrFoo = errors.New(...)). This enables error comparison with errors.Is and prevents message drift.",
     "confidence": "high", "confidence_reason": "Inline error instead of sentinel (R01)"},
    # --- NEW: R05 patterns (security) ---
    {"pattern": r"http\.ListenAndServe\(", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "ListenAndServe without TLS serves unencrypted HTTP", "phase": 1,
     "explanation": "http.ListenAndServe serves unencrypted HTTP traffic. In production, use http.ListenAndServeTLS or terminate TLS at a reverse proxy. Unencrypted traffic exposes all data to network attackers.",
     "confidence": "high", "confidence_reason": "Unencrypted HTTP server (R05)"},
    {"pattern": r"fmt\.Sprintf\(.*(?:SELECT|INSERT|UPDATE|DELETE)", "rule": "R05", "severity": "CRITICAL", "category": "security",
     "description": "fmt.Sprintf with SQL keywords suggests SQL injection risk", "phase": 1,
     "explanation": "Building SQL queries with fmt.Sprintf allows SQL injection if any parameter comes from user input. Use parameterized queries with database/sql placeholder syntax instead.",
     "confidence": "high", "confidence_reason": "SQL injection vector (R05)"},
    # --- NEW: R14 patterns (suppressions) ---
    {"pattern": r"//nolint", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "//nolint suppresses linter warning", "phase": 0,
     "explanation": "//nolint comments suppress golangci-lint warnings. Each suppression should specify the exact linter (e.g., //nolint:errcheck) and include a justification. Fix the underlying issue when possible.",
     "confidence": "high", "confidence_reason": "Linter suppression (R14)"},
    {"pattern": r"_\s*=\s*\w+\.\w+\(", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "Discarded return value from function call", "phase": 0,
     "explanation": "Assigning a function return value to _ discards important information like errors or status. Check the return value and handle failures, or document why the result is intentionally ignored.",
     "confidence": "high", "confidence_reason": "Discarded return value (R14)"},
    {"pattern": r"time\.Sleep\(\s*\d+", "rule": "R13", "severity": "MEDIUM", "category": "clean-code",
     "description": "time.Sleep with hardcoded duration", "phase": 5,
     "explanation": "Hardcoded sleep durations are magic numbers. Extract to a named constant so the purpose is clear and the value can be tuned in one place.",
     "confidence": "medium", "confidence_reason": "Hardcoded sleep duration (R13-M1)"},
]

RUST_PATTERNS: list[PatternDef] = [
    # --- Existing patterns ---
    {"pattern": r"\.unwrap\(\)", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "unwrap() panics on None/Err in production code", "phase": 1,
     "explanation": "unwrap() causes a panic if the value is None or Err, crashing the thread. In library code this is especially dangerous. Use pattern matching, unwrap_or, unwrap_or_else, or the ? operator for proper error propagation.",
     "confidence": "high", "confidence_reason": "Panic-prone unwrap call (R14)"},
    {"pattern": r"\.expect\(", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "expect() panics with a message on None/Err", "phase": 1,
     "explanation": "expect() is marginally better than unwrap() as it provides a message, but still panics. In library and application code, prefer the ? operator or match/if-let for recoverable error handling.",
     "confidence": "high", "confidence_reason": "Panic-prone expect call (R14)"},
    {"pattern": r"\bunsafe\b", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "unsafe block bypasses Rust's safety guarantees", "phase": 1,
     "explanation": "unsafe blocks disable borrow checking, allowing memory corruption, use-after-free, and data races. Each unsafe block must have a SAFETY comment explaining why the invariants are upheld.",
     "confidence": "high", "confidence_reason": "Unsafe block bypasses safety (R05)"},
    {"pattern": r"\bprintln!\(", "rule": "R14", "severity": "MEDIUM", "category": "clean-code",
     "description": "println! in production code", "phase": 5, "removable": True,
     "explanation": "println! writes to stdout without log levels or structure. Use a logging crate (tracing, log, env_logger) that supports structured output, log levels, and can be configured per environment.",
     "confidence": "medium", "confidence_reason": "Debug println left in code (R09-M1)"},
    {"pattern": r"\beprintln!\(", "rule": "R14", "severity": "MEDIUM", "category": "clean-code",
     "description": "eprintln! in production code", "phase": 5, "removable": True,
     "explanation": "eprintln! writes to stderr without structure or log levels. Replace with a logging crate that supports error-level logging with structured context.",
     "confidence": "low", "confidence_reason": "Error logging may be intentional (R09-L1)"},
    {"pattern": r"\bTODO\b", "rule": "R14", "severity": "LOW", "category": "build",
     "description": "TODO marker in production code", "phase": 0,
     "explanation": "TODO comments indicate incomplete implementation that should be tracked as tickets and completed before release.",
     "confidence": "high", "confidence_reason": "Incomplete implementation marker (R14)"},
    {"pattern": r"\bFIXME\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "FIXME marker indicates known bug", "phase": 0,
     "explanation": "FIXME marks known bugs that should be fixed before release or tracked as high-priority tickets.",
     "confidence": "high", "confidence_reason": "Known bug marker (R14)"},
    {"pattern": r"\bHACK\b", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "HACK marker indicates technical debt", "phase": 0,
     "explanation": "HACK comments mark intentional shortcuts that should be properly implemented to avoid long-term maintenance issues.",
     "confidence": "high", "confidence_reason": "Technical debt marker (R14)"},
    {"pattern": r"\bpub\s+\w+\s*:", "rule": "R02", "severity": "LOW", "category": "architecture",
     "description": "pub struct field may expose internal state", "phase": 3,
     "explanation": "Public struct fields expose implementation details and prevent adding validation or computed values later. Consider using private fields with accessor methods, or builder patterns for construction.",
     "confidence": "medium", "confidence_reason": "Public field exposing internal state (R04-M1)"},
    {"pattern": r"\.clone\(\)", "rule": "R04", "severity": "LOW", "category": "performance",
     "description": "clone() where borrowing may suffice", "phase": 5,
     "explanation": "Cloning allocates new memory and copies data. If the value is only read, borrow it instead (&T or &mut T). Unnecessary clones hurt performance and obscure ownership semantics.",
     "confidence": "medium", "confidence_reason": "Possible unnecessary clone (R04-M1)"},
    {"pattern": r"#\[allow\(", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "#[allow(...)] suppresses compiler lint warnings", "phase": 0,
     "explanation": "Lint suppressions hide potential issues the compiler would otherwise catch. Each #[allow] should have a justification comment. Fix the underlying issue instead of silencing the warning.",
     "confidence": "high", "confidence_reason": "Lint suppression (R14)"},
    {"pattern": r"\bas\s+[a-z]", "rule": "R07", "severity": "MEDIUM", "category": "typing",
     "description": "'as' type cast may silently truncate or wrap values", "phase": 2,
     "explanation": "Rust's 'as' casts can silently truncate integers, lose precision on floats, or wrap around. Use TryFrom/TryInto for fallible conversions, or From/Into for infallible ones.",
     "confidence": "high", "confidence_reason": "Unsafe type cast (R07)"},
    # --- NEW: R04 patterns (performance) ---
    {"pattern": r"\.to_string\(\)", "rule": "R04", "severity": "LOW", "category": "performance",
     "description": "to_string() on &str allocates unnecessarily when borrowing suffices", "phase": 5,
     "explanation": "Calling .to_string() on a &str allocates a new String on the heap. If the value is only read, pass a &str reference instead. Use .to_owned() when you explicitly need ownership for clarity.",
     "confidence": "medium", "confidence_reason": "Possible unnecessary allocation (R04-M1)"},
    {"pattern": r"\.collect::<Vec<", "rule": "R04", "severity": "LOW", "category": "performance",
     "description": "collect::<Vec> without size hint may cause re-allocations", "phase": 5,
     "explanation": "Collecting an iterator into a Vec without a size hint can cause multiple re-allocations. If the size is known, use Vec::with_capacity followed by extend.",
     "confidence": "medium", "confidence_reason": "Vec collect without size hint (R04-M1)"},
    # --- NEW: R05 patterns (security) ---
    {"pattern": r"\btransmute\b", "rule": "R05", "severity": "CRITICAL", "category": "security",
     "description": "std::mem::transmute bypasses all type safety", "phase": 1,
     "explanation": "transmute reinterprets bits from one type to another without any checks. It can cause undefined behavior, memory corruption, and security vulnerabilities. Use safe alternatives like From/Into or TryFrom/TryInto.",
     "confidence": "high", "confidence_reason": "Unsafe transmute bypasses type system (R05)"},
    {"pattern": r"unsafe\b(?!.*//\s*SAFETY)", "rule": "R05", "severity": "HIGH", "category": "security",
     "description": "unsafe block without SAFETY comment", "phase": 1,
     "explanation": "Every unsafe block must have a SAFETY comment explaining why the invariants are upheld. Without this documentation, reviewers cannot verify correctness and future maintainers may introduce unsoundness.",
     "confidence": "high", "confidence_reason": "Undocumented unsafe block (R05)"},
    # --- NEW: R14 patterns (suppressions and incomplete code) ---
    {"pattern": r"#\[allow\(unused", "rule": "R14", "severity": "MEDIUM", "category": "build",
     "description": "#[allow(unused)] hides dead code that should be removed", "phase": 0,
     "explanation": "Suppressing unused warnings hides dead code. Remove unused items or prefix with underscore if intentionally unused. Dead code increases maintenance burden and may indicate incomplete refactoring.",
     "confidence": "high", "confidence_reason": "Dead code suppression (R14)"},
    {"pattern": r"\btodo!\(\)", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "todo!() macro panics at runtime (incomplete implementation)", "phase": 0,
     "explanation": "todo!() panics at runtime with a 'not yet implemented' message. This must be replaced with actual implementation before production. Track with a ticket if deferring.",
     "confidence": "high", "confidence_reason": "Incomplete implementation stub (R14)"},
    {"pattern": r"\bunimplemented!\(\)", "rule": "R14", "severity": "HIGH", "category": "build",
     "description": "unimplemented!() macro panics at runtime", "phase": 0,
     "explanation": "unimplemented!() panics at runtime, indicating intentionally missing functionality. Replace with a proper implementation, return an error, or document why the branch is unreachable.",
     "confidence": "high", "confidence_reason": "Unimplemented code stub (R14)"},
]

# ---- Skip / filter lists -----------------------------------------------------

# Paths containing these substrings are skipped entirely.
# Note: "test/" also matches "tests/" since substring matching is used.
SKIP_SUBSTRINGS = (
    "node_modules", ".next",
    "__tests__", ".test.", ".spec.", "test/",
    "test_", "evaluation/",
)

COMMENT_FILTER_RULES = ("R09", "R07")

# ---- Flagged-files defaults (overridden by dojutsu.toml when available) ------

DEFAULT_ALWAYS_SCAN_LAYERS: list[str] = [
    "services", "middleware", "auth", "security",
    "api-routes", "handlers", "routes",
]

DEFAULT_ALWAYS_SCAN_PATTERNS: list[str] = [
    "main.ts", "main.py", "main.go", "main.rs",
    "app.ts", "app.py",
    "server.ts", "server.py", "server.go",
    "index.ts",
]

DEFAULT_MIN_IMPORTS: int = 5

DEFAULT_STRUCTURAL_SKIP_EXTENSIONS: list[str] = [
    ".json", ".yaml", ".yml", ".toml", ".css", ".scss", ".less", ".env.example",
]


def _load_dojutsu_flagged_config() -> tuple[list[str], list[str], int, list[str]]:
    """Load flagged-files config from dojutsu.toml if available, else use defaults.

    Returns (always_scan_layers, always_scan_patterns, min_imports, skip_extensions).
    """
    try:
        sys.path.insert(
            0,
            os.path.join(os.path.dirname(__file__), '..', '..', 'dojutsu', 'scripts'),
        )
        from dojutsu_config import get as dojutsu_get
        layers = dojutsu_get("always_scan_layers.layers", DEFAULT_ALWAYS_SCAN_LAYERS)
        patterns = dojutsu_get("always_scan_files.patterns", DEFAULT_ALWAYS_SCAN_PATTERNS)
        min_imports = dojutsu_get("always_scan_files.min_imports", DEFAULT_MIN_IMPORTS)
        skip_exts = dojutsu_get(
            "structural_skip.extensions_always_skip", DEFAULT_STRUCTURAL_SKIP_EXTENSIONS,
        )
        return layers, patterns, min_imports, skip_exts
    except (ImportError, FileNotFoundError):
        return (
            DEFAULT_ALWAYS_SCAN_LAYERS,
            DEFAULT_ALWAYS_SCAN_PATTERNS,
            DEFAULT_MIN_IMPORTS,
            DEFAULT_STRUCTURAL_SKIP_EXTENSIONS,
        )


def _count_imports(filepath: str) -> int:
    """Count import/require/use/include statements in a source file."""
    import_pattern = re.compile(
        r"^\s*(?:import\b|from\b|require\(|use\b|include\b|#include\b)",
    )
    count = 0
    try:
        with open(filepath, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if import_pattern.match(line):
                    count += 1
    except OSError:
        pass
    return count


def _is_structural_only(filepath: str) -> bool:
    """Return True if file content is purely type declarations or re-exports."""
    reexport_pattern = re.compile(
        r"^\s*(?:export\s+\{|export\s+\*|export\s+default\s|export\s+type\s|"
        r"type\s+\w+\s*=|interface\s+\w+|pub\s+type\s|pub\s+use\s)",
    )
    try:
        with open(filepath, encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError:
        return False
    if not lines:
        return True
    meaningful = 0
    structural = 0
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("//") or line.startswith("#") or line.startswith("/*") or line.startswith("*"):
            continue
        meaningful += 1
        if reexport_pattern.match(line):
            structural += 1
    if meaningful == 0:
        return True
    return structural / meaningful >= 0.9


def _matches_entry_point(rel_path: str, patterns: list[str]) -> bool:
    """Return True if rel_path basename matches any entry-point pattern."""
    basename = os.path.basename(rel_path)
    return basename in patterns


def generate_flagged_files(
    audit_dir: str,
    findings: list[Finding],
    project_dir: str | None = None,
) -> dict[str, list[dict[str, str]]]:
    """Classify every inventory file and write flagged-files.json.

    Categories:
    - flagged: grep found at least 1 finding in this file
    - always_scan: file is in an always-scan layer, has 5+ imports, or matches entry-point patterns
    - structural_only: extension is in skip list or content is pure type declarations/re-exports
    - llm_scan: everything else -- included in LLM scan

    Returns the classification dict.
    """
    inv_path = os.path.join(audit_dir, "data/inventory.json")
    with open(inv_path) as fh:
        inv = json.load(fh)

    always_layers, always_patterns, min_imports, skip_exts = _load_dojutsu_flagged_config()

    # Collect files that have findings
    flagged_set: set[str] = {f["file"] for f in findings}

    result: dict[str, list[dict[str, str]]] = {
        "flagged": [],
        "always_scan": [],
        "structural_only": [],
        "llm_scan": [],
    }

    for entry in inv["files"]:
        rel_path: str = entry["path"]
        layer: str = entry.get("layer", "misc")
        _, ext = os.path.splitext(rel_path)

        # 1. flagged: grep found findings
        if rel_path in flagged_set:
            result["flagged"].append({"path": rel_path, "layer": layer, "reason": "grep_finding"})
            continue

        # 2. structural_only: extension in skip list or pure re-exports/type decls
        if ext in skip_exts:
            result["structural_only"].append(
                {"path": rel_path, "layer": layer, "reason": f"skip_extension:{ext}"},
            )
            continue

        if project_dir and _is_structural_only(os.path.join(project_dir, rel_path)):
            result["structural_only"].append(
                {"path": rel_path, "layer": layer, "reason": "type_decl_or_reexport"},
            )
            continue

        # 3. always_scan: layer, high imports, or entry-point pattern
        if layer in always_layers:
            result["always_scan"].append(
                {"path": rel_path, "layer": layer, "reason": f"always_scan_layer:{layer}"},
            )
            continue

        if _matches_entry_point(rel_path, always_patterns):
            result["always_scan"].append(
                {"path": rel_path, "layer": layer, "reason": "entry_point_pattern"},
            )
            continue

        if project_dir and _count_imports(os.path.join(project_dir, rel_path)) >= min_imports:
            result["always_scan"].append(
                {"path": rel_path, "layer": layer, "reason": "high_import_count"},
            )
            continue

        # 4. Everything else goes to LLM scan
        result["llm_scan"].append({"path": rel_path, "layer": layer, "reason": "default"})

    # Write output
    output_path = os.path.join(audit_dir, "data/flagged-files.json")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as fh:
        json.dump(result, fh, indent=2)

    return result


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


_IMPORT_LINE_RE = re.compile(
    r"^\s*(?:import\b|from\b|require\(|use\b|include\b|#include\b)",
)


def _is_import_line(code_stripped: str) -> bool:
    """Return True if the line is an import/require/use statement."""
    return bool(_IMPORT_LINE_RE.match(code_stripped))


# innerHTML = "" / innerHTML = '' / innerHTML = `` (clearing DOM content is safe)
_INNERHTML_CLEAR_RE = re.compile(
    r'\.innerHTML\s*=\s*(?:""|' + r"''|``)" + r'\s*;?\s*$',
)


def _is_innerhtml_clear(code_stripped: str) -> bool:
    """Return True if the line is an innerHTML assignment to an empty string."""
    return bool(_INNERHTML_CLEAR_RE.search(code_stripped))


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
        "confidence": pat_def.get("confidence", "medium"),
        "confidence_reason": pat_def.get("confidence_reason", f"Deterministic grep match ({pat_def['rule']})"),
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

            # Meta-file exclusion: R09/R13/R14 are rule-detection rules; skip
            # them for files whose job is to detect those same patterns.
            if pat_def["rule"] in _META_FILE_SKIP_RULES and _is_meta_file(rel_path, project_dir):
                continue

            # Glob-based file exclusion (e.g., skip localhost pattern in test files)
            file_glob_excludes = pat_def.get("file_glob_excludes", ())
            if file_glob_excludes and any(
                fnmatch.fnmatch(rel_path, glob) for glob in file_glob_excludes
            ):
                continue

            # Layer-based exclusion (e.g., skip console.error in API routes)
            layer_exclude = pat_def.get("layer_exclude")
            if layer_exclude:
                file_layer = file_to_layer.get(rel_path, "misc")
                if file_layer in layer_exclude:
                    continue

            code_stripped = code.strip()
            if pat_def["rule"] in COMMENT_FILTER_RULES and _is_comment(code_stripped):
                continue

            # Skip import lines for patterns that flag declaration-site usage
            # (e.g., Java raw type `List` matched in `import java.util.List;`)
            if pat_def.get("skip_import_lines", False) and _is_import_line(code_stripped):
                continue

            # skip_string_literals: if the pattern only matches inside a string
            # or regex literal, it is not a real violation (e.g., @ts-nocheck
            # appearing in a docstring or JSDoc comment about the directive).
            if pat_def.get("skip_string_literals", False):
                stripped_line = _strip_string_literals(code_stripped)
                if not re.search(pattern, stripped_line):
                    continue

            # innerHTML = "" / '' / `` is safe clearing, not an XSS vector
            if "innerHTML" in pattern and _is_innerhtml_clear(code_stripped):
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
    project_dir: str | None = None,
) -> str:
    """Write scanner output files and return the output file path.

    Writes:
    - ``data/scanner-output/grep-scanner.jsonl``
    - ``data/scanner-output/scope-map.json`` (updated)
    - ``data/scanner-output/grep-scanner.status``
    - ``data/flagged-files.json`` (file classification for downstream consumers)
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

    # Generate flagged-files.json for downstream consumers
    generate_flagged_files(audit_dir, findings, project_dir)

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
