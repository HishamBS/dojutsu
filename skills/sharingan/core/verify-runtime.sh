#!/usr/bin/env bash
# Sharingan Gate 4: Runtime Verification
# Framework-agnostic — detects modified pages/routes/API endpoints
# across ANY language/framework and produces a runtime check template.
#
# Supported frameworks (auto-detected):
#   Next.js, Express, Koa, Fastify, Hono, NestJS,
#   FastAPI, Django, Flask, Tornado,
#   Spring Boot (Java/Kotlin), Quarkus, Micronaut,
#   Go (net/http, Gin, Echo, Chi, Fiber),
#   Rust (Actix, Axum, Rocket, Warp),
#   Smithy (model-only — runtime checks skipped),
#   Static sites, Docker services
#
# Usage: verify-runtime.sh [--plan <plan-file>] [--base <commit>] [--port <port>]
# Output: runtime-check-{PROJECT_HASH}.json (template for agent to fill)
#
# Exit codes:
#   0 = template written (or no runtime checks needed)
#   1 = error

set -euo pipefail

# ── Shared library ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib-project-types.sh"

# ── Parse args ──
PLAN_FILE=""
SHARINGAN_BASE="${SHARINGAN_BASE:-HEAD~1}"
PORT="${PORT:-auto}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --plan) PLAN_FILE="$2"; shift 2 ;;
    --base) SHARINGAN_BASE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

CACHE_DIR="${SHARINGAN_CACHE_DIR:-$HOME/.cache/sharingan}"
PROJECT_HASH=$(sharingan_project_hash)
RUNTIME_FILE="${CACHE_DIR}/runtime-check-${PROJECT_HASH}.json"
mkdir -p "$CACHE_DIR"

echo "Gate 4: Runtime Verification"
echo "Base: $SHARINGAN_BASE"
echo ""

# ── Detect project frameworks (via shared library) ──
FRAMEWORKS=$(sharingan_detect_frameworks)
echo "Detected frameworks: ${FRAMEWORKS:-none}"

if [[ "$PORT" == "auto" ]]; then
  PORT=$(sharingan_detect_port "$FRAMEWORKS")
fi
echo "Port: $PORT"
echo ""

# ── Collect modified files ──
ALL_MODIFIED=$(git diff --name-only "$SHARINGAN_BASE" 2>/dev/null || true)
ALL_MODIFIED=$( { echo "$ALL_MODIFIED"; git diff --cached --name-only 2>/dev/null; git diff --name-only 2>/dev/null; } | sort -u )

# ── Classify modified files as pages or API endpoints (via shared library) ──
MODIFIED_PAGES=""
MODIFIED_API=""

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  result=$(sharingan_classify_runtime_file "$f")
  [[ -z "$result" ]] && continue
  case "$result" in
    page:*) MODIFIED_PAGES="${MODIFIED_PAGES}${MODIFIED_PAGES:+$'\n'}${result#page:}" ;;
    api:*) MODIFIED_API="${MODIFIED_API}${MODIFIED_API:+$'\n'}${result#api:}" ;;
  esac
done <<< "$ALL_MODIFIED"

# ── Count and display ──
PAGE_COUNT=0
API_COUNT=0
[[ -n "$MODIFIED_PAGES" ]] && PAGE_COUNT=$(echo "$MODIFIED_PAGES" | wc -l | tr -d ' ')
[[ -n "$MODIFIED_API" ]] && API_COUNT=$(echo "$MODIFIED_API" | wc -l | tr -d ' ')

echo "Modified pages/views: $PAGE_COUNT"
if [[ -n "$MODIFIED_PAGES" ]]; then
  while IFS= read -r entry; do
    local_framework="${entry%%:*}"
    local_file="${entry#*:}"
    echo "  - [$local_framework] $local_file"
  done <<< "$MODIFIED_PAGES"
fi

echo "Modified API endpoints: $API_COUNT"
if [[ -n "$MODIFIED_API" ]]; then
  while IFS= read -r entry; do
    local_framework="${entry%%:*}"
    local_file="${entry#*:}"
    echo "  - [$local_framework] $local_file"
  done <<< "$MODIFIED_API"
fi

# ── Generate runtime check template ──
PAGES_RAW="$MODIFIED_PAGES" \
APIS_RAW="$MODIFIED_API" \
CHECK_PORT="$PORT" \
CHECK_FRAMEWORKS="$FRAMEWORKS" \
RUNTIME_FILE="$RUNTIME_FILE" \
SHARINGAN_BASE="$SHARINGAN_BASE" \
python3 << 'PYEOF2'
import json, os
from datetime import datetime, timezone

pages_raw = os.environ.get("PAGES_RAW", "").strip()
apis_raw = os.environ.get("APIS_RAW", "").strip()
port = os.environ.get("CHECK_PORT", "3000")
frameworks = os.environ.get("CHECK_FRAMEWORKS", "")
runtime_file = os.environ.get("RUNTIME_FILE", "")
sharingan_base = os.environ.get("SHARINGAN_BASE", "")

pages = [p for p in pages_raw.split('\n') if p.strip()] if pages_raw else []
apis = [a for a in apis_raw.split('\n') if a.strip()] if apis_raw else []

checks = []

def file_to_url(framework, filepath):
    if framework == "nextjs":
        route = filepath
        for prefix in ('src/app', 'app'):
            if route.startswith(prefix):
                route = route[len(prefix):]
        for suffix in ('/page.tsx', '/page.ts', '/page.jsx', '/page.js'):
            route = route.replace(suffix, '')
        return route or '/'
    elif framework == "pages-router":
        route = filepath
        for prefix in ('src/pages', 'pages'):
            if route.startswith(prefix):
                route = route[len(prefix):]
        for suffix in ('/index.tsx', '/index.ts', '/index.jsx', '/index.js', '/index.vue',
                       '.tsx', '.ts', '.jsx', '.js', '.vue'):
            if route.endswith(suffix):
                route = route[:-len(suffix)]
        return route or '/'
    elif framework == "sveltekit":
        route = filepath
        if '/src/routes' in route:
            route = route[route.index('/src/routes') + len('/src/routes'):]
        for suffix in ('/+page.svelte', '/+page.ts'):
            route = route.replace(suffix, '')
        return route or '/'
    elif framework == "django-template":
        return None
    return None

for entry in pages:
    framework, filepath = entry.split(':', 1) if ':' in entry else ('unknown', entry)
    url = file_to_url(framework, filepath)
    checks.append({
        "component": filepath,
        "type": "page",
        "framework": framework,
        "url": f"http://localhost:{port}{url}" if url else "",
        "url_note": "URL auto-detected" if url else "Inspect routing config for URL",
        "status": "PENDING",
        "reason": "",
        "snapshot_elements": 0,
        "interactive_elements": 0,
        "has_data": False
    })

for entry in apis:
    framework, filepath = entry.split(':', 1) if ':' in entry else ('unknown', entry)
    endpoint_type = "trpc" if framework == "trpc" else "api"
    url_hint = ""
    if framework == "nextjs-api":
        route = filepath
        for prefix in ('src/app', 'app'):
            if route.startswith(prefix):
                route = route[len(prefix):]
        for suffix in ('/route.tsx', '/route.ts', '/route.jsx', '/route.js'):
            route = route.replace(suffix, '')
        url_hint = f"http://localhost:{port}{route}"

    checks.append({
        "component": filepath,
        "type": endpoint_type,
        "framework": framework,
        "url": url_hint if url_hint.startswith("http") else "",
        "url_note": url_hint if not url_hint.startswith("http") else "URL auto-detected",
        "status": "PENDING",
        "reason": "",
        "response_shape": None,
        "has_real_data": False
    })

template = {
    "timestamp": datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    "port": int(port),
    "frameworks": frameworks.split() if frameworks else [],
    "sharingan_base": sharingan_base,
    "checks": checks,
    "summary": {
        "total": len(checks),
        "pass": 0,
        "fail": 0,
        "skip": 0,
        "pending": len(checks)
    },
    "notes": {
        "smithy": "Smithy models define API contracts — test generated code instead",
        "url_detection": "URLs are best-effort. For decorator/programmatic routing, inspect source.",
        "dev_server": "Start your framework dev server before runtime checks."
    }
}

with open(runtime_file, 'w') as f:
    json.dump(template, f, indent=2)

print(f"\nRuntime check template written to: {runtime_file}")
print(f"  Frameworks: {frameworks}")
print(f"  Pages to test: {len(pages)}")
print(f"  APIs to test: {len(apis)}")
print(f"  Total checks: {len(checks)}")

if not checks:
    print("\n  No pages or API endpoints modified -- runtime verification is optional.")
PYEOF2
