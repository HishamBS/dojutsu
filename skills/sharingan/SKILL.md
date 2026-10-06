---
name: sharingan
description: Use when running the Sharingan QA verification pipeline over the push range before a push — the deterministic build gate, claim-provenance gate, and independent cross-engine review. Trigger on "run sharingan", "/sharingan", "verify before push", or a pre-push QA request. Cross-harness invocation surface for every engine; the implementation SSOT is run.sh.
---

# Sharingan — QA verification pipeline

Runs the Sharingan QA pipeline against the push range (`base..HEAD`). Deterministic gates block and run inline; the cross-engine review is advisory and runs detached, so a full run costs about a second. Works from any harness — the pipeline is a single script, not a harness-specific skill.

## How It Works

1. **Invoke the pipeline script** with any flags the request implies:

   ```bash
   ~/.coding-agent/sharingan/run.sh [--deep] [--runtime] [--gate0-only] [--force] [--base <ref>]
   ```

   The script resolves the base ref, orchestrates the gates, and writes the verdict. No flags = the 3 default gates over `base..HEAD`.

2. **Report the result** after it finishes:
   - The verdict — `CLEAR` / `PARTIAL` / `BLOCKED` / `INFRA_DEGRADED` / `INFRA_BLOCKED`.
   - The per-gate pass/fail breakdown.
   - The full absolute path to the verdict JSON (`.sharingan/<sha>.verdict.json`), on its own line.
   - When the verdict carries `advisories`, render the glance banner from `~/.coding-agent/sharingan/review-banner-template.md` and give the bare clickable path to `.sharingan/<sha>.review.md`. Advisories NEVER block — surface and move on; never loop chasing `CLEAR` on an INFRA verdict.

## Base ref, verdict, cache

- **Base ref:** defaults to the upstream tracking branch (`git @{u}`, e.g. `origin/main`), falling back to `HEAD~1` when no upstream exists. Verification is range-based — the cumulative diff that will be pushed. `--base <ref>` overrides.
- **Verdict file:** `.sharingan/<commit-sha>.verdict.json` per project (plain JSON, no HMAC). The pre-push gate reads only a full-run `.verdict.json` covering `base..HEAD`: `CLEAR` allows the push, `INFRA_DEGRADED` / `INFRA_BLOCKED` allow it with a logged advisory, and `BLOCKED` / `PARTIAL` / no verdict block it.
- **Cache:** an unchanged commit + base whose last verdict was `CLEAR` is a no-op cache hit; `--force` re-runs.

## Gates

- **Gate 0 — Deterministic build** (always): typecheck + lint + stub grep. Unfakeable.
- **Gate 1 — Claim provenance** (always, incl. `--gate0-only`): blocks the one unfakeable case — a `✓path:line[#symbol]` citation in a commit message that does not resolve. Untagged completion claims and `~inferred`/`?assumed` tags are advisory.
- **Gate 3 — Independent cross-engine review** (always, ADVISORY and DETACHED): fresh-context review by the OTHER engine, pinned to its personal profile (Claude drives → `cxp` reviews; Codex drives → `ccp` reviews). Before dispatch, `jev-admission.sh` asks Jev whether a review of that diff would change anything; a no skips the premium call and records Gate 3 as ADVISORY (Jev off or unanswering: the review runs). Dispatched in the background — the run returns in about a second without waiting for it, and the review appears at `.sharingan/<sha>.review.md` afterwards. Beside it, `jev-rule-scan.sh` has Jev read the range against the rules once per range (cached by a hash of the diff); those readings land in the same file, also when no review is dispatched. Findings surface, they do not gate, and they are never a reason to re-run.
- **Gate 5 — Reconciliation** (always): aggregates into the final verdict.
- **Gate 2 — LLM correctness** (opt-in `--deep`) · **Gate 4 — Runtime** (opt-in `--runtime`, only if the project declares `verification_e2e_command`).

## Flags

- `--gate0-only`: Gates 0 and 1 + reconciliation; writes `.sharingan/<sha>.gate0.json` (informational, never satisfies the push gate). The fast check the post-commit hook queues.
- `--force`: bypass the verdict cache.

The full gate policy and pre-push behavior live in `~/.coding-agent/CODING_RULES.md` (§Sharingan QA pipeline); the implementation SSOT is `~/.coding-agent/sharingan/run.sh`.
