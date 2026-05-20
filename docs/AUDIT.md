# Security & Code-Quality Audit — GNS + Giftcard + CLI

- **Date:** 2026-05-20
- **Branch:** `feat/gns-giftcard-foundation`
- **Scope:** `git diff main..HEAD` — PRs #1–#4 (foundation, giftcard plugin, GNS plugin, CLI). ~6,100 LOC across ~64 files: 15 GNS actions, 8 giftcard actions, 1 core `print-secret` action, 10 CLI lib files, 2 bin shims, adapters/config, ~15 test files.
- **Prior review:** this code already passed 6 dual-engine review rounds (Claude + real Codex CLI). This document is the consolidated independent final-audit record.

## Executive summary

Zero P0 and zero P1 findings. Two P2 findings were raised by the audit; one (F-01) was a genuine secret-redaction gap and has been **fixed + regression-tested**; the other (F-02) was investigated and determined to be a **false positive** (the ESC byte is present in the source — the auditor's terminal could not render it). The codebase is sound: idempotency double-spend is closed, on-chain owner preflights and commit-binding checks are in place, auth and secret handling are correct, all 24 actions carry input + output Zod schemas, and there are no secrets committed to the repo.

## Findings

| ID | Severity | Area | Status | Description |
|----|----------|------|--------|-------------|
| F-01 | P2 (security-relevant) | Secret handling | **FIXED** (`x402-create-order.ts`) | `goat.gns.x402.createOrder` accepted `secret` (32-byte ENS commit pre-image) in input but did not declare `sensitiveInputFields: ['secret']`, so the value reached `onActionStart` hook payloads in plaintext. An observer with mempool visibility could derive the commitment hash and front-run the registration. Fixed by adding the declaration; regression test added (`gns-actions.test.ts`, "audit F-01"). |
| F-02 | P2 (cosmetic) | CLI output | **NOT A DEFECT** (false positive) | Audit reported the `ANSI` constants in `bin/_lib/output.ts` were missing the `\x1b` ESC byte (emitting literal `[32m`). Verified with `od -c`: the ESC byte (`033`) IS present in all 7 constants (`grep -c $'\x1b'` → 7). The Read/terminal view renders ESC invisibly, which misled the audit. No change made (adding `\x1b` would have doubled the byte). |

No P0 or P1 findings.

## Area-by-area verdicts

| Area | Verdict | Notes |
|------|---------|-------|
| Secret handling | PASS (after F-01 fix) | `commit` (sensitiveOutputFields), `register` (sensitiveInputFields), `print-secret` (sensitiveInputFields), and now `x402.createOrder` all redact `secret`. `revealedFields` opt-out is output-only. print-secret stdout limitation documented. |
| Idempotency / double-spend | PASS | `createOrder` asserts `ctx.idempotencyKey === input.idempotency_key`; atomic acquire/complete/release in both stores; cache-key isolation per action. |
| On-chain safety | PASS | Owner preflights on renew / setPrimaryName / setProfileRecords / setAddress; commit hash re-derivation in `register`; chainId match + 30s expiry margin + `pay_amount_wei` regex in both `payOrder` paths. |
| Auth (giftcard EIP-712) | PASS | Domain chainId fixed at 2345 (off-chain HMAC); per-address single-flight; seconds→ms expiry conversion centralized; 401 retry is single-shot (non-looping). |
| Input validation | PASS | All 24 actions carry `zodInputSchema` + `zodOutputSchema`; Wei regex before `BigInt`; `evmAddress` on address fields; name normalization. (Note: the `socialLinks` output-schema bug found by E2E — see E2E-TEST-REPORT.md — was fixed separately in commit `54d51cb`.) |
| HTTP adapter robustness | PASS | `fetchWithTimeout` + `parseBodySafe` + `assertOk` → `AgentkitRuntimeError(ADAPTER_REQUEST_FAILED)` consistent across both adapters; no unhandled-rejection paths. |
| CLI security | PASS | Exit-code mapping complete (no commander exit-2 collision); no `--private-key` flag; `child_process.spawn` with arg arrays (no shell injection); SIGINT handled (exit 130); DEMO_MOCK guard; `--reveal-secrets` wired through `revealedFields`. |
| Dependency / supply chain | PASS-with-notes | `commander@^12`, `tsx` (intentional, for the published bin shims). Vendored GNS ABI fragments have no automated drift check against goat-ens upstream — acceptable (fragments are minimal and stable) but worth a periodic manual diff. |
| Secrets in repo | PASS | No raw private keys / mnemonics / tokens. Only localhost references are the pre-existing Redis default + tests/examples. All hardcoded URLs are documented public production/testnet endpoints. `.env`, `.docs/`, `dist-manifests/` gitignored. |
| Conventions | PASS | Zero `any` in new plugin code; pre-existing infrastructure `any` count unchanged (68 lint warnings, all pre-existing); ESM + Prettier consistent; 0 lint errors. |

## Documented limitation (not a finding)

`goat.giftcard.getOrder` / `listOrders` flatten `order.card.card_code` to the top level so shallow `sensitiveOutputFields` redaction reaches them in hook payloads. The nested `card` sub-object is preserved alongside, so `output.card.card_code` remains plaintext in hooks while `output.card_code` is `[REDACTED]`. Already documented in `plugins/giftcard/actions/get-order.ts` with a test asserting both paths. Consumers relying on hook redaction should read the top-level keys. No action required.

## Verification performed

- `npx tsc --noEmit` → clean.
- `npx eslint .` → 0 errors, 68 pre-existing warnings (unchanged).
- `npx vitest run` → 340 passed / 12 skipped (Redis), 47 files.
- Risk greps for committed keys / localhost in SDK config → none.

## Disposition

Both P2 findings resolved (F-01 fixed, F-02 dismissed as false positive). No outstanding P0/P1/P2. The branch is audit-clean.
