# Engineering Rules Reference — Rinnegan Audit Skill

Cross-language detection patterns for 15 auditable rules.
Each rule includes a definition, grep patterns, per-language red flags,
severity guidelines, and the remediation phase it maps to.

---

## Table of Contents

| Rule | Name | Phase |
|------|------|-------|
| R14 | Clean Build | 0 — Foundation |
| R05 | Security | 1 — Security |
| R07 | Strict Typing | 2 — Typing |
| R01 | SSOT & DRY | 3 — SSOT/DRY |
| R02 | Separation of Concerns | 4 — Architecture |
| R03 | Mirror Architecture | 4 — Architecture |
| R04 | Performance First | 6 — Performance |
| R08 | Build/Test Gate | 9 — Verification |
| R09 | Clean Code | 5 — Clean Code |
| R10 | Whole-System Refactors | 8 — Refactoring |
| R11 | Documentation | 10 — Documentation |
| R12 | Real Data | 7 — Data Integrity |
| R13 | No Magic Numbers | 5 — Clean Code |
| R16 | Full Stack Verification | 9 — Verification |

---

## R01 — SSOT & DRY

**Definition.** Every value, constant, or piece of logic must live in exactly one place; all consumers import from that single source of truth.

### Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| Python | `rg -n 'def (extract_text\|create_result\|build_auth_headers\|get_db_url)' --type py` | Duplicate utility function definitions |
| Python | `rg -n 'DATABASE_URL\s*=' --type py` | DB URL defined in multiple files |
| Python | `rg -n 'TIMEOUT\s*=\|timeout\s*=' --type py` | Timeout constants scattered |
| Python | `rg -c 'class.*BaseModel' --type py` | Pydantic models that may duplicate fields |
| TypeScript | `rg -n 'interface (User\|Config\|Response)' --type ts` | Duplicate interface definitions |
| TypeScript | `rg -n 'const API_URL\|const BASE_URL\|baseURL' --type ts` | Hardcoded URLs in multiple files |
| TypeScript | `rg -n 'styled\.' --type ts` | Repeated styled components |
| Java | `rg -n 'class.*DTO\|class.*Dto' --type java` | Duplicate DTO definitions |
| Java | `rg -n '@Value\("\$\{' --type java` | Config values that may also be hardcoded elsewhere |
| All | `rg -n 'def \|function \|public.*\(' -g '*.{py,ts,tsx,java}' \| sort -t: -k3 \| uniq -d -f2` | Functions with identical names across files |

### Per-Language Red Flags

**Python**
- Same Pydantic field name and type appearing in multiple model classes across files.
- Constants like `MAX_RETRIES`, `DEFAULT_TIMEOUT`, `API_VERSION` defined in more than one module.
- Repeated patterns: `extract_text`, `create_result`, `build_auth_headers`, `get_db_url` in separate files.
- Copy-pasted exception handling blocks (identical try/except structure in 3+ places).

**TypeScript**
- Identical interface shapes declared in separate files instead of a shared `types.ts`.
- Utility function clones (`formatDate`, `debounce`, `parseQuery`) in multiple directories.
- Styled component definitions with identical CSS repeated across components.

**Java**
- DTO classes with identical fields that should share a base class or composition.
- Repository methods with identical query logic across multiple repositories.
- Configuration values present both in `application.properties` and as inline constants.

### Severity Guidelines

| Condition | Severity |
|-----------|----------|
| Same constant defined in 4+ files | CRITICAL |
| Duplicate function with diverging implementations | CRITICAL |
| Same interface/model in 2-3 files | HIGH |
| Repeated inline value that should be a constant | MEDIUM |
| Minor copy-paste in test code | LOW |

**Duplication threshold:** A code block counts as duplication if: (1) 3+ contiguous lines are structurally identical, (2) appears in 2+ files or 2+ non-adjacent locations in same file, (3) is in production code (not test fixtures).

**Phase:** 3 — SSOT/DRY

---

## R02 — Separation of Concerns

**Definition.** UI, domain logic, data access, and infrastructure must be in separate layers; no layer reaches into another's responsibility.

### Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| Python | `rg -n 'from.*models import\|from.*db import' -g '**/routes/*.py' -g '**/routers/*.py' -g '**/api/*.py'` | Route handlers importing DB models directly |
| Python | `rg -n 'html\|render\|template\|format.*response' -g '**/services/*.py'` | Service layer doing UI formatting |
| Python | `rg -n 'session\.\|query\(' -g '**/routes/*.py' -g '**/routers/*.py'` | Raw DB queries in route handlers |
| TypeScript | `rg -n 'fetch\(\|axios\.\|\.get\(\|\.post\(' -g '*.tsx' -g '!**/hooks/**' -g '!**/services/**'` | API calls directly in components |
| TypeScript | `rg -n 'localStorage\|sessionStorage\|cookie' -g '*.tsx'` | Storage access in component layer |
| TypeScript | `rg -n 'if.*&&.*return\|switch.*case' -g '*.tsx' -C2` | Business logic in render components |
| Java | `rg -n 'Repository\|EntityManager\|JdbcTemplate' -g '**/*Controller*.java'` | Data access in controllers |
| Java | `rg -n '@Controller\|@RestController' -g '**/*Service*.java'` | Controller annotations in services |
| Java | `rg -n 'JsonProperty\|JsonFormat\|@Column' -g '**/*Controller*.java' -g '**/*Service*.java'` | Presentation/persistence annotations leaking across layers |

### Per-Language Red Flags

**Python**
- FastAPI/Flask route function directly instantiating SQLAlchemy sessions.
- Service module importing Jinja2 or returning HTML strings.
- Domain model containing `to_json()` or `to_response()` methods that know about HTTP.

**TypeScript**
- React component file longer than 300 lines containing fetch calls, state management, and JSX.
- Business validation logic (price calculations, permission checks) inside component files.
- Direct DOM manipulation or `window` access in service/utility files.

**Java**
- `@Service` class that takes `HttpServletRequest` as a parameter.
- Entity class annotated with both `@Entity` and `@JsonProperty`.
- Controller method containing more than 5 lines of non-delegation logic.

### Severity Guidelines

| Condition | Severity |
|-----------|----------|
| DB queries in route handlers / controllers | CRITICAL |
| Business logic in UI components | HIGH |
| Service layer aware of HTTP / presentation | HIGH |
| Minor formatting in service return values | MEDIUM |
| Test helpers mixing concerns | LOW |

**Phase:** 4 — Architecture

---

## R03 — Mirror Architecture

**Definition.** New code must match the established patterns in naming, folder layout, import style, and conventions already present in the codebase.

### Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| All | `ls -1 src/ \| sort` then inspect | Mixed naming conventions (kebab vs camel vs snake) |
| Python | `rg -n 'from \.\|from \.\.\|from app\.' --type py \| head -40` | Inconsistent import styles (relative vs absolute) |
| Python | `rg -l 'class.*Router\|class.*Blueprint' --type py` | Mixed router patterns |
| TypeScript | `rg -n "import.*from '\.\|import.*from \"\./" --type ts \| head -40` | Mixed quote styles in imports |
| TypeScript | `rg -l 'export default\|export \{' --type ts` | Mixed export styles (default vs named) |
| Java | `rg -n 'package ' --type java \| cut -d: -f2 \| sort -u` | Inconsistent package naming |
| All | `find . -name '*.py' -o -name '*.ts' -o -name '*.java' \| xargs basename -a \| sort` | Files that break the naming convention |

### Per-Language Red Flags

**Python**
- Some modules use `__init__.py` re-exports, others do not.
- Mixed async/sync handlers in the same router module.
- Some services use dependency injection, others instantiate clients inline.

**TypeScript**
- Some components use `.tsx`, others use `.jsx` in the same project.
- Mixed state management patterns (some Context, some Redux, some Zustand).
- Inconsistent barrel file (`index.ts`) usage across directories.

**Java**
- Some packages use `service/impl` pattern, others put implementation in the service package directly.
- Mixed annotation styles (`@Autowired` field injection vs constructor injection).
- Inconsistent naming: `UserService` vs `UserSvc` vs `UserManager`.

### Severity Guidelines

| Condition | Severity |
|-----------|----------|
| Fundamentally different architectural pattern in new code | HIGH |
| Mixed import/export conventions across the project | MEDIUM |
| Inconsistent file naming (camel vs kebab vs snake) | MEDIUM |
| Minor style differences in new files | LOW |

**Phase:** 4 — Architecture

---

## R04 — Performance First

**Definition.** Use vectorized operations, memoization, connection pooling, and pagination; avoid N+1 queries, hot loops, and unnecessary re-renders.

### Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| Python | `rg -n 'for.*in.*for.*in' --type py` | Nested loops (potential O(n^2)) |
| Python | `rg -n 'asyncio\.sleep\|time\.sleep' --type py` | Blocking sleep in async context |
| Python | `rg -n 'create_engine\|connect\(' --type py` | DB connections without pooling |
| Python | `rg -n '\.all\(\)' --type py` | Unbounded query results |
| TypeScript | `rg -n 'useEffect\(' --type ts -A5 \| rg -v 'useCallback\|useMemo'` | Effects without memoized deps |
| TypeScript | `rg -n 'useState\|useEffect' --type ts -c` | Components with excessive hook count |
| TypeScript | `rg -n '\.map\(.*\.map\(' --type ts` | Nested array iterations |
| Java | `rg -n 'findAll\(\)\|\.getResultList\(\)' --type java` | Unbounded query fetches |
| Java | `rg -n '@OneToMany\|@ManyToOne' --type java -A3 \| rg -v 'fetch.*LAZY'` | Eager-loaded relationships |
| Java | `rg -n 'for.*repository\.\|for.*findBy' --type java` | N+1 query patterns |

### Per-Language Red Flags

**Python**
- Synchronous HTTP calls inside `async def` functions without `await`.
- `for row in query.all()` on tables with 100k+ rows without LIMIT.
- Missing `async` on IO-bound service methods (file reads, HTTP calls, DB queries).
- No connection pool configuration on SQLAlchemy engine.

**TypeScript**
- Components re-rendering on every parent render due to missing `React.memo` or `useMemo`.
- Large lists rendered without virtualization (`react-window`, `react-virtualized`).
- Event handlers defined inline without `useCallback`, causing child re-renders.
- Missing `key` prop or using array index as `key` in dynamic lists.

**Java**
- Missing `@Transactional` on methods that execute multiple queries.
- No pagination (`Pageable`) on endpoints returning collections.
- Eager fetch on `@OneToMany` relationships causing cartesian products.
- Connection pool not configured (missing HikariCP settings).

### Severity Guidelines

| Condition | Severity |
|-----------|----------|
| N+1 queries on production endpoints | CRITICAL |
| Unbounded `.all()` / `findAll()` without pagination | CRITICAL |
| Missing connection pooling | HIGH |
| Blocking calls in async context | HIGH |
| Missing memoization in frequently rendered components | MEDIUM |
| Inline event handlers in leaf components | LOW |

**Phase:** 6 — Performance

---

## R05 — Security

**Definition.** Validate all inputs, enforce least privilege, never store secrets in code, and guard against SSRF, XSS, SQLi, and CSRF.

### Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| Python | `rg -n 'verify\s*=\s*False' --type py` | Disabled TLS verification |
| Python | `rg -n 'str\(exc\)\|str\(e\)\|str\(error\)' --type py` | Exception details leaked to clients |
| Python | `rg -n 'allow_origins.*\*\|CORS.*\*' --type py` | Wildcard CORS |
| Python | `rg -n 'password\s*=\s*["\x27]\|secret\s*=\s*["\x27]\|api_key\s*=\s*["\x27]' --type py` | Hardcoded credentials |
| Python | `rg -n 'f".*SELECT\|f".*INSERT\|f".*UPDATE\|f".*DELETE\|\.format\(.*SELECT' --type py` | SQL injection via f-strings |
| Python | `rg -n 'eval\(\|exec\(' --type py` | Arbitrary code execution |
| TypeScript | `rg -n 'dangerouslySetInnerHTML' --type ts` | XSS via raw HTML injection |
| TypeScript | `rg -n 'innerHTML\s*=' --type ts` | Direct DOM HTML insertion |
| TypeScript | `rg -n 'api_key\|apiKey\|secret\|password' -g '*.ts' -g '*.tsx' -g '!*.d.ts' -g '!*.test.*'` | Exposed secrets in client code |
| TypeScript | `rg -n 'document\.cookie' --type ts` | Direct cookie manipulation |
| Java | `rg -n 'SuppressWarnings.*squid:S2068\|SuppressWarnings.*java:S2068' --type java` | Password warning suppression |
| Java | `rg -n '".*"\s*\+\s*.*\+\s*".*SELECT\|".*"\s*\+\s*.*\+\s*".*INSERT' --type java` | SQL injection via string concatenation |
| Java | `rg -n 'new.*Password\|password\s*=\s*"' --type java` | Hardcoded passwords |
| Java | `rg -n '@PermitAll\|permitAll\(\)' --type java` | Overly permissive endpoint access |
| All | `rg -rn 'BEGIN.*PRIVATE KEY\|AKIA[0-9A-Z]\|sk-[a-zA-Z0-9]' -g '*.{py,ts,tsx,java,yml,yaml,json}'` | Leaked private keys and AWS/API keys |

### Per-Language Red Flags

**Python**
- `requests.get(..., verify=False)` disabling certificate verification.
- `except Exception as e: return {"error": str(e)}` leaking stack details.
- CORS middleware with `allow_origins=["*"]` on authenticated endpoints.
- Raw SQL built with f-strings or `.format()` instead of parameterized queries.
- Missing `Depends(get_current_user)` on protected FastAPI routes.

**TypeScript**
- `dangerouslySetInnerHTML={{ __html: userInput }}` without sanitization.
- API keys or secrets in client-side `.ts`/`.tsx` files (not just `.env`).
- Missing CSRF token on form submissions to mutating endpoints.
- `eval()` or `new Function()` with user-controlled input.

**Java**
- `@SuppressWarnings("squid:S2068")` suppressing password detection rules.
- `Statement.execute(sql)` with string-concatenated SQL instead of `PreparedStatement`.
- No `@Valid` annotation on `@RequestBody` parameters.
- Hardcoded credentials in `application.properties` committed to VCS.

### Severity Guidelines

| Condition | Severity |
|-----------|----------|
| Hardcoded secrets, leaked private keys | CRITICAL |
| SQL injection vectors | CRITICAL |
| Disabled TLS verification in production code | CRITICAL |
| XSS via `dangerouslySetInnerHTML` with user input | CRITICAL |
| Wildcard CORS on authenticated endpoints | HIGH |
| Missing input validation on public endpoints | HIGH |
| Exception details leaked to API responses | MEDIUM |
| Missing CSRF on non-critical forms | MEDIUM |
| Overly broad `@PermitAll` on read-only endpoints | LOW |

### Additional OWASP Detection Patterns

| OWASP | Grep Pattern | What It Finds |
|-------|-------------|---------------|
| A05 Security Misconfiguration | `rg -n 'DEBUG\s*=\s*True\|app\.debug\s*=\s*True' -g '*.{py,ts,java,yml,yaml}'` | Debug mode enabled in production configs |
| A05 Security Misconfiguration | `rg -n 'traceback\|stacktrace\|stack_trace' -g '*.{py,ts,java}' -g '!*.test.*'` | Verbose error pages leaking internals |
| A08 Insecure Deserialization | `rg -n 'pickle\.load\|pickle\.loads\|shelve\.open' --type py` | Unsafe pickle deserialization (arbitrary code execution) |
| A08 Insecure Deserialization | `rg -n 'yaml\.load\(' --type py` | yaml.load without SafeLoader (code execution via YAML) |
| A10 SSRF | `rg -n 'requests\.(get\|post\|put\|delete\|patch\|head)\(.*\bf["\x27]' --type py` | User-controlled URLs in requests calls |
| A10 SSRF | `rg -n 'fetch\(\s*\w' --type ts -g '!*.test.*'` | User-controlled URLs in fetch() calls |
| A10 SSRF | `rg -n 'RestTemplate\|WebClient\.create\(' --type java` | User-controlled URLs in Java HTTP clients |

**Phase:** 1 — Security

---

## R07 — Strict Typing

**Definition.** No `any`, `Any`, `Object`, or raw types in public APIs; all functions must have explicit parameter and return type annotations.

### Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| Python | `rg -n '\bAny\b' --type py` | Use of `Any` type |
| Python | `rg -n 'from typing import.*\b(Dict\|List\|Optional\|Tuple\|Set)\b' --type py` | Old-style typing imports (use `dict`, `list`, `\| None`) |
| Python | `rg -n 'def .*\):\s*$' --type py` | Functions missing return type annotation |
| Python | `rg -n 'def .*\(self\):\|def .*\(cls\):' --type py` | Methods without parameter types |
| Python | `rg -n ':\s*list\s*=\s*\[\]\|:\s*dict\s*=\s*\{\}' --type py` | Mutable default arguments |
| TypeScript | `rg -n '\bany\b' --type ts -g '!*.d.ts' -g '!*.test.*'` | Explicit `any` type |
| TypeScript | `rg -n 'as any' --type ts` | Unsafe type assertion to `any` |
| TypeScript | `rg -n '@ts-ignore\|@ts-expect-error' --type ts` | Type-check suppression |
| TypeScript | `rg -n ':\s*Function\b' --type ts` | Generic `Function` type instead of specific signature |
| Java | `rg -n 'List\s\|Map\s\|Set\s\|Collection\s' --type java \| rg -v '<'` | Raw generic types |
| Java | `rg -n '\(Object\s' --type java` | `Object` params where generics apply |
| Java | `rg -n '@SuppressWarnings.*unchecked' --type java` | Suppressed unchecked cast warnings |
| Java | `rg -n '\(.*\)\s*\w+\.\w+' --type java \| rg 'Object\)'` | Unsafe casts from Object |

### Per-Language Red Flags

**Python**
- `from typing import Dict, List, Optional` instead of `dict`, `list`, `X | None` (Python 3.10+).
- `Any` used in Pydantic model fields or FastAPI endpoint signatures.
- Missing type annotations on public functions in service/domain layers.
- Mutable defaults: `def f(items: list = [])` instead of `def f(items: list[str] | None = None)`.

**TypeScript**
- Explicit `any` in function parameters, return types, or generic arguments.
- `as any` used to silence type errors instead of fixing the underlying issue.
- `@ts-ignore` without an accompanying `@ts-expect-error` and explanation.
- Missing return type on exported functions.

**Java**
- Raw `List`, `Map`, `Set` without generic parameters.
- `Object` used as method parameter type where a generic `<T>` or specific type applies.
- `@SuppressWarnings("unchecked")` hiding unsafe casts.
- Missing `@NonNull` / `@Nullable` annotations on public API boundaries.

### Severity Guidelines

| Condition | Severity |
|-----------|----------|
| `any` / `Any` in public API signatures (endpoints, schemas) | CRITICAL |
| `@ts-ignore` / `@ts-expect-error` without justification | HIGH |
| Raw generic types in Java public methods | HIGH |
| Old-style typing imports in Python 3.10+ projects | MEDIUM |
| Missing return type on internal utility functions | MEDIUM |
| Mutable default arguments | MEDIUM |
| Missing annotations on private helper methods | LOW |

**Phase:** 2 — Typing

---

## R08 — Build/Test Gate

**Definition.** Every change must pass type-checking, linting, and tests before it is considered complete; tooling configs must exist and be enforced.

### Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| Python | `rg -l 'mypy\|pyright' pyproject.toml setup.cfg .pre-commit-config.yaml 2>/dev/null` | Type checker configuration |
| Python | `rg -l 'ruff\|flake8\|pylint' pyproject.toml setup.cfg .pre-commit-config.yaml 2>/dev/null` | Linter configuration |
| Python | `rg -l 'pytest\|unittest' pyproject.toml setup.cfg 2>/dev/null` | Test framework configuration |
| TypeScript | `rg -l 'eslint\|@typescript-eslint' package.json .eslintrc* 2>/dev/null` | ESLint configuration |
| TypeScript | `rg -n '"test"\|"lint"\|"typecheck"\|"type-check"' package.json` | NPM script gates |
| Java | `rg -l 'checkstyle\|spotbugs\|pmd' pom.xml build.gradle 2>/dev/null` | Static analysis plugins |
| Java | `rg -n 'surefire\|failsafe' pom.xml build.gradle 2>/dev/null` | Test runner configuration |
| All | `ls .pre-commit-config.yaml .github/workflows/ .gitlab-ci.yml 2>/dev/null` | CI/pre-commit presence |
| All | `rg -rn 'skip.*test\|pytest.*--no\|skipTest\|@Disabled\|@Ignore' -g '*.{py,ts,java}'` | Skipped tests |

### Per-Language Red Flags

**Python**
- No `mypy.ini`, `pyproject.toml [tool.mypy]`, or `pyrightconfig.json` present.
- No `ruff` or `flake8` configuration.
- Missing `.pre-commit-config.yaml` or no Python hooks in it.
- `# type: ignore` without a specific error code.

**TypeScript**
- No `tsconfig.json` with `"strict": true`.
- Missing `eslint` configuration or `eslint` not in devDependencies.
- No `"test"` script in `package.json`.
- `"skipLibCheck": true` hiding type errors from dependencies.

**Java**
- No `checkstyle.xml` or equivalent static analysis configuration.
- Missing `surefire-plugin` (unit tests) or `failsafe-plugin` (integration tests).
- `@Disabled` or `@Ignore` on tests without a ticket reference.

### Severity Guidelines

| Condition | Severity |
|-----------|----------|
| No type checker configured for the project | CRITICAL |
| No linter configured | HIGH |
| No CI pipeline running checks | HIGH |
| No pre-commit hooks | MEDIUM |
| Individual tests skipped with justification | LOW |

**Phase:** 9 — Verification

---

## R09 — Clean Code

**Definition.** No emojis, ASCII art, banner comments, noise comments, or commented-out code blocks; identifiers and API fields must be spelled correctly.

### Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| All | `rg -n '# [=]{4,}\|// [=]{4,}\|/\* [=]{4,}' -g '*.{py,ts,tsx,java}'` | Banner comments |
| All | `rg -n '# -{4,}\|// -{4,}' -g '*.{py,ts,tsx,java}'` | Separator line comments |
| All | `rg -n '#.*TODO\|//.*TODO\|#.*FIXME\|//.*FIXME\|#.*HACK\|//.*HACK' -g '*.{py,ts,tsx,java}'` | TODO/FIXME/HACK markers |
| All | `rg -Pn '[\x{1F300}-\x{1F9FF}]' -g '*.{py,ts,tsx,java}'` | Emojis in source code |
| Python | `rg -Un '^\s*#.*\n\s*#.*\n\s*#.*\n\s*#.*\n\s*#' --type py --multiline` | Commented-out code blocks (5+ lines) |
| TypeScript | `rg -Un '^\s*//.*\n\s*//.*\n\s*//.*\n\s*//.*\n\s*//' --type ts --multiline` | Commented-out code blocks (5+ lines) |
| Java | `rg -Un '^\s*//.*\n\s*//.*\n\s*//.*\n\s*//.*\n\s*//' --type java --multiline` | Commented-out code blocks (5+ lines) |
| Python | `rg -n 'logger\.\|logging\.' --type py \| head -20` | Logger inconsistencies (mixed logger names) |
| All | `rg -Pn '[^\x00-\x7F]' -g '*.{py,ts,tsx,java}' -g '!*.test.*'` | Non-ASCII characters in source |

### Per-Language Red Flags

**Python**
- `# ========== SECTION NAME ==========` banner comments.
- `# print(debug_value)` — commented-out debug statements.
- Mixed logger references: `logger`, `log`, `logging.getLogger()` with different names.
- Typos in dictionary keys or API field names that become part of the contract.

**TypeScript**
- `// TODO: fix this later` without a ticket reference.
- Large JSX blocks wrapped in `{/* ... */}` comment syntax.
- Console.log statements left in production code.

**Java**
- `/* *** IMPORTANT *** */` style noise comments.
- Javadoc that merely restates the method name (`/** Gets the user. */ getUser()`).
- Commented-out `@Test` methods or entire test classes.

### Severity Guidelines

| Condition | Severity |
|-----------|----------|
| Typos in public API field names / endpoints | HIGH |
| Commented-out code blocks > 10 lines in production code | MEDIUM |
| Banner/separator comments | MEDIUM |
| TODO without ticket reference | MEDIUM |
| Emojis in source code | LOW |
| Minor noise comments | LOW |

### Additional Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| TypeScript | `rg -n 'console\.(log\|warn\|error\|debug\|info)' --type ts -g '!*.test.*' -g '!*.spec.*'` | Console statements in production TypeScript code |

**Phase:** 5 — Clean Code

---

## R10 — Whole-System Refactors

**Definition.** When upgrading or refactoring, update all dependents and remove deprecated patterns; no mixed old/new states.

### Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| Python | `rg -n 'asyncio\.get_event_loop\(\)' --type py` | Deprecated event loop access (use `asyncio.get_running_loop()`) |
| Python | `rg -n 'class Config:' --type py -B2 \| rg 'BaseModel'` | Deprecated Pydantic v1 `class Config` (use `model_config`) |
| Python | `rg -n '@app\.on_event\|@app\.on_startup\|@app\.on_shutdown' --type py` | Deprecated FastAPI lifecycle hooks (use `lifespan`) |
| Python | `rg -n 'from __future__ import' --type py` | Future imports that may be unnecessary in modern Python |
| Python | `rg -n '\.dict\(\)\|\.json\(\)' --type py` | Pydantic v1 methods (use `.model_dump()`, `.model_json()`) |
| TypeScript | `rg -n 'componentDidMount\|componentWillUnmount\|componentDidUpdate' --type ts` | Class component lifecycle (should be hooks) |
| TypeScript | `rg -n 'React\.FC\|React\.FunctionComponent' --type ts` | Deprecated `React.FC` pattern |
| Java | `rg -n '@Deprecated' --type java -A2` | Deprecated APIs still in use |
| Java | `rg -n 'Date\(\)\|Calendar\.' --type java` | Legacy date API (use `java.time`) |
| Java | `rg -n 'javax\.' --type java` | javax namespace (should be `jakarta` in Spring Boot 3+) |

### Per-Language Red Flags

**Python**
- Mix of Pydantic v1 (`class Config`, `.dict()`) and v2 (`model_config`, `.model_dump()`) in the same project.
- `@app.on_event("startup")` alongside `lifespan` context manager in FastAPI.
- `from __future__ import annotations` in a Python 3.10+ project.

**TypeScript**
- Class components and functional components coexisting in the same feature module.
- Mix of `getServerSideProps` and App Router patterns in Next.js.
- Old `createStore` from Redux alongside `configureStore` from Redux Toolkit.

**Java**
- `javax.persistence` alongside `jakarta.persistence` after Spring Boot 3 migration.
- `java.util.Date` and `java.time.LocalDate` used for the same purpose.
- Deprecated Spring Security config (`WebSecurityConfigurerAdapter`) alongside `SecurityFilterChain`.

### Severity Guidelines

| Condition | Severity |
|-----------|----------|
| Mixed framework versions (Pydantic v1/v2, javax/jakarta) | CRITICAL |
| Deprecated lifecycle hooks alongside modern replacements | HIGH |
| Legacy API usage with modern alternative available | MEDIUM |
| Unnecessary `from __future__` imports | LOW |

**Phase:** 8 — Refactoring

---

## R11 — Documentation

**Definition.** READMEs, ADRs, and API docs must be updated when behavior, configuration, or API surface changes.

### Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| All | `ls README.md docs/ ADR/ adr/ 2>/dev/null` | Presence of documentation files |
| All | `rg -l 'openapi\|swagger' -g '*.{yml,yaml,json}'` | API specification files |
| Python | `rg -n 'description=\|summary=' -g '**/routes/*.py' -g '**/routers/*.py'` | Endpoint documentation in FastAPI |
| TypeScript | `rg -l 'Storybook\|\.stories\.' -g '*.{ts,tsx}'` | Component documentation via Storybook |
| Java | `rg -n '@Api\|@Operation\|@Schema' --type java` | Swagger/OpenAPI annotations |
| All | `git log --oneline --diff-filter=M -- '*.py' '*.ts' '*.java' \| head -20` | Recent code changes (compare against doc changes) |
| All | `git log --oneline --diff-filter=M -- '*.md' 'docs/' \| head -10` | Recent documentation changes |

### Per-Language Red Flags

**Python**
- FastAPI routes with no `description`, `summary`, or `response_model` docstrings.
- Missing `pyproject.toml` project description or outdated version.
- Environment variables used but not documented in README or `.env.example`.

**TypeScript**
- No JSDoc on exported utility functions or hooks.
- Missing `.env.example` for required environment variables.
- Component props without descriptive comments.

**Java**
- Missing Javadoc on public service/controller methods.
- No `@Schema(description=...)` on DTO fields exposed in APIs.
- Missing `application.properties` documentation for custom config keys.

### Severity Guidelines

| Condition | Severity |
|-----------|----------|
| No README.md in the project root | HIGH |
| API endpoints with no documentation | HIGH |
| Env vars used but not documented | MEDIUM |
| Missing ADR for non-obvious architectural decisions | MEDIUM |
| Minor docstring gaps on internal methods | LOW |

**Phase:** 10 — Documentation

---

## R12 — Real Data

**Definition.** No hardcoded URLs, placeholder credentials, or mock data in production code paths; all external references must come from configuration.

### Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| All | `rg -n 'localhost\|127\.0\.0\.1\|0\.0\.0\.0' -g '*.{py,ts,tsx,java}' -g '!*.test.*' -g '!*spec*'` | Hardcoded localhost references |
| All | `rg -n 'example\.com\|test\.com\|placeholder' -g '*.{py,ts,tsx,java,yml,yaml}' -g '!*.test.*'` | Placeholder domains |
| All | `rg -n 'TODO.*replace\|FIXME.*hardcoded\|CHANGEME\|REPLACEME' -g '*.{py,ts,tsx,java,yml,yaml}'` | Marked placeholders |
| Python | `rg -n 'password.*=.*["'"'"']\|token.*=.*["'"'"']' --type py -g '!*.test.*' -g '!*fixture*'` | Hardcoded credentials in Python |
| All | `rg -n 'mock\|fake\|dummy\|stub' -g '*.{py,ts,java}' -g '!*.test.*' -g '!*test*' -g '!*mock*' -g '!*fixture*'` | Mock/fake data in production code |
| All | `rg -n 'image:.*:latest' -g 'docker-compose*.yml'` | Unpinned Docker image tags |
| All | `rg -n 'http://' -g '*.{py,ts,tsx,java}' -g '!*.test.*'` | Non-HTTPS URLs in production code |

### Per-Language Red Flags

**Python**
- `DATABASE_URL = "postgresql://user:pass@localhost/db"` as a fallback default.
- `requests.get("http://api.example.com/...")` hardcoded in service code.
- `if not config: config = {"timeout": 30, "retries": 3}` inline fallback.

**TypeScript**
- `const API_URL = "http://localhost:3000"` without environment variable.
- Mock data objects used as default state in production stores.
- Hardcoded feature flags instead of runtime configuration.

**Java**
- `@Value("${db.url:jdbc:mysql://localhost:3306/mydb}")` with production-looking defaults.
- Test fixtures or seed data loaded by production `@Configuration` classes.
- Hardcoded URLs in `RestTemplate` or `WebClient` calls.

### Severity Guidelines

| Condition | Severity |
|-----------|----------|
| Hardcoded credentials in production code | CRITICAL |
| Hardcoded API URLs without env-var override | HIGH |
| Unpinned Docker image tags in production compose | HIGH |
| Placeholder domains in non-test code | MEDIUM |
| Localhost fallbacks with env-var override available | LOW |

**Phase:** 7 — Data Integrity

---

## R13 — No Magic Numbers

**Definition.** All numeric literals, string constants, regex patterns, and array slices must be named constants, enums, or sourced from SSOT configuration.

### Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| Python | `rg -n 'timeout\s*=\s*\d+\|timeout=\d+' --type py` | Inline timeout values |
| Python | `rg -n 'pool_size\s*=\s*\d+\|max_connections\s*=\s*\d+' --type py` | Inline pool configuration |
| Python | `rg -n '\[:\d+\]\|\[-\d+:\]' --type py` | Array slices with magic numbers |
| Python | `rg -n "re\.compile\(r'" --type py` | Inline regex patterns (should be named constants) |
| Python | `rg -n 'sleep\(\d+\)' --type py` | Hardcoded sleep durations |
| TypeScript | `rg -n 'setTimeout.*\d{3,}\|setInterval.*\d{3,}' --type ts` | Inline timer values |
| TypeScript | `rg -n 'width:\s*\d+\|height:\s*\d+\|padding:\s*\d+\|margin:\s*\d+' --type ts` | Inline pixel values in styles |
| TypeScript | `rg -n '\.slice\(\d+\)\|\.slice\(\d+,\s*\d+\)' --type ts` | Array slices with magic numbers |
| Java | `rg -n 'Thread\.sleep\(\d+\)' --type java` | Hardcoded sleep durations |
| Java | `rg -n '"\w+".*==\|\.equals\("\w+"\)' --type java` | String constants compared inline |
| Java | `rg -Pn '(?<!\.)\b\d{2,}\b(?!\.\d)' --type java -g '!*.test.*'` | Numeric literals (2+ digits) in production code |

### Per-Language Red Flags

**Python**
- `timeout=30.0` in HTTP calls instead of `TIMEOUT_SECONDS` constant.
- `pool_size=10` on engine creation instead of `DB_POOL_SIZE` config.
- `results[:5]` instead of `results[:MAX_PREVIEW_ITEMS]`.
- Regex patterns inline instead of `PATTERN_EMAIL = re.compile(...)` at module level.

**TypeScript**
- `setTimeout(fn, 5000)` instead of `setTimeout(fn, DEBOUNCE_MS)`.
- `padding: 16px; margin: 24px;` instead of theme/design tokens.
- `data.slice(0, 10)` instead of `data.slice(0, PAGE_SIZE)`.

**Java**
- `Thread.sleep(1000)` instead of `Thread.sleep(POLL_INTERVAL_MS)`.
- `if (status.equals("active"))` instead of `if (status == Status.ACTIVE)`.
- `new ArrayList<>(16)` with unexplained initial capacity.

### Severity Guidelines

| Condition | Severity |
|-----------|----------|
| Magic numbers in business logic (pricing, thresholds) | HIGH |
| Inline timeouts/retry counts in production code | MEDIUM |
| Inline regex patterns used in 2+ places | MEDIUM |
| Array slices with magic numbers | MEDIUM |
| Pixel values instead of design tokens | LOW |
| Numeric literals in test setup | LOW |

**Phase:** 5 — Clean Code

---

## R14 — Clean Build

**Definition.** All code must compile, pass linting, pass type-checking, and pass tests without errors or warnings.

### Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| Python | `rg -n 'type:\s*ignore' --type py` | mypy suppression comments |
| Python | `rg -n 'noqa\|nosec\|pragma: no cover' --type py` | Linter/coverage suppression |
| Python | `rg -n 'import.*\bsqlite\b' --type py -g '!*.test.*'` | SQLite imports in PostgreSQL projects |
| Python | `rg -n 'mysql\|MySQL\|MYSQL' --type py` | MySQL references in PostgreSQL projects |
| TypeScript | `rg -n '@ts-ignore\|@ts-expect-error\|@ts-nocheck' --type ts` | TypeScript suppression directives |
| TypeScript | `rg -n 'eslint-disable' --type ts` | ESLint suppression comments |
| TypeScript | `rg -n '^import .* from' --type ts` then cross-check with actual usage | Potentially unused imports |
| Java | `rg -n '@SuppressWarnings' --type java` | Warning suppression annotations |
| Java | `rg -n 'System\.out\.print\|System\.err\.print' --type java -g '!*.test.*'` | Console output instead of logging |
| All | `rg -n 'FIXME\|XXX\|BUG\|BROKEN' -g '*.{py,ts,tsx,java}'` | Known-broken markers in code |

### Per-Language Red Flags

**Python**
- `# type: ignore` without a specific error code (should be `# type: ignore[attr-defined]`).
- Import of a module that does not exist (will fail at runtime).
- MySQL-specific SQL syntax (`LIMIT %s, %s`) in a PostgreSQL project.
- Missing method references in class hierarchies (abstract method not implemented).

**TypeScript**
- `@ts-ignore` on lines that could be properly typed.
- `eslint-disable-next-line` without specifying which rule.
- Unused imports that indicate dead code or incomplete refactors.
- `"strict": false` or missing from `tsconfig.json`.

**Java**
- `@SuppressWarnings("all")` blanket suppression.
- `System.out.println` in production code instead of proper logging.
- Compilation warnings about unchecked operations or raw types.
- Missing `@Override` on methods that override parent implementations.

### Severity Guidelines

| Condition | Severity |
|-----------|----------|
| Code that fails to compile / type-check | CRITICAL |
| Import of non-existent module | CRITICAL |
| Wrong SQL dialect for the target database | CRITICAL |
| Blanket `@SuppressWarnings("all")` | HIGH |
| `# type: ignore` without error code | MEDIUM |
| `eslint-disable` without rule specification | MEDIUM |
| Console output in production code | MEDIUM |
| Unused imports | LOW |

**Phase:** 0 — Foundation

---

## R16 — Full Stack Verification

**Definition.** Every endpoint must be verified across all layers: API route definition, handler logic, service delegation, type contracts, and response schemas must all agree.

### Detection Patterns

| Language | Grep Pattern | What It Finds |
|----------|-------------|---------------|
| Python | `rg -n '@(app\|router)\.(get\|post\|put\|patch\|delete)' --type py` | Route definitions |
| Python | `rg -n 'response_model\s*=' --type py` | Declared response types on routes |
| Python | `rg -n 'class.*Schema\|class.*Response\|class.*Request' --type py` | Schema/contract definitions |
| TypeScript | `rg -n 'fetch\(\|axios\.\|\.get\(\|\.post\(' --type ts` | Client-side API calls |
| TypeScript | `rg -n 'interface.*Request\|interface.*Response\|type.*Request\|type.*Response' --type ts` | Request/response type definitions |
| Java | `rg -n '@(Get\|Post\|Put\|Patch\|Delete)Mapping\|@RequestMapping' --type java` | Controller endpoint mappings |
| Java | `rg -n 'ResponseEntity<\|@ResponseBody' --type java` | Response type declarations |
| All | `rg -n 'status.*200\|status.*201\|status.*400\|status.*404\|status.*500' -g '*.{py,ts,tsx,java}'` | Status code usage across layers |

### Per-Language Red Flags

**Python**
- `response_model=UserResponse` on route but service returns a `dict`.
- Route declares `status_code=201` but raises on success path without matching.
- Schema field names differ between request schema and database model.
- Missing `Depends()` injection causing service to be instantiated differently.

**TypeScript**
- Frontend `interface UserResponse` has fields not present in backend response.
- API client function returns `Promise<any>` instead of typed response.
- Path parameters in fetch URL do not match route definition.
- Error response shape differs from what the error boundary expects.

**Java**
- Controller method returns `ResponseEntity<Object>` instead of typed DTO.
- Service method signature disagrees with repository method signature.
- `@PathVariable` name does not match URL template variable.
- Request DTO validation annotations do not match database constraints.

### Severity Guidelines

| Condition | Severity |
|-----------|----------|
| Response type mismatch between route declaration and implementation | CRITICAL |
| Schema field name mismatch between layers | CRITICAL |
| Missing validation at API boundary that exists at DB layer | HIGH |
| Status code inconsistency between docs and implementation | HIGH |
| Frontend type does not match backend response shape | HIGH |
| Minor field ordering differences | LOW |

**Phase:** 9 — Verification

---

## Quick Reference: Severity Decision Matrix

Use this matrix when a finding could fall into multiple severity levels.

| Factor | Raises Severity | Lowers Severity |
|--------|----------------|-----------------|
| In public API / endpoint | +1 level | |
| In production code path | +1 level | |
| In test code only | | -1 level |
| Causes runtime failure | +1 level | |
| Has compensating control | | -1 level |
| Affects security boundary | +2 levels | |
| In commented/dead code | | -2 levels |

**Severity floor:** No finding can be reduced below LOW. CRITICAL findings can drop at most 1 level (to HIGH). Compensating control claims MUST cite file:line of the actual control.

---

## Phase Summary

| Phase | Name | Rules | Focus |
|-------|------|-------|-------|
| Phase 0 | Foundation | R14 | Clean build, type-check, lint pass |
| Phase 1 | Security | R05 | Input validation, secrets, OWASP coverage |
| Phase 2 | Typing | R07 | Strict types, no `any`/`Any`, annotations |
| Phase 3 | SSOT/DRY | R01 | Single source of truth, no duplication |
| Phase 4 | Architecture | R02, R03 | Separation of concerns, mirror patterns |
| Phase 5 | Clean Code | R09, R13 | No noise, named constants, no magic numbers |
| Phase 6 | Performance | R04 | Pooling, memoization, pagination, no N+1 |
| Phase 7 | Data Integrity | R12 | No hardcoded URLs, real config, no placeholders |
| Phase 8 | Refactoring | R10 | Remove deprecated, no mixed old/new patterns |
| Phase 9 | Verification | R16, R08 | Full-stack type agreement, CI/CD gates |
| Phase 10 | Documentation | R11 | READMEs, ADRs, API docs current |
