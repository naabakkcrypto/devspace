# Adaptive Tool Efficiency Implementation Plan

Specification: `docs/superpowers/specs/2026-08-14-adaptive-tool-efficiency-design.md`

## Task graph

### ATE-1 - Public RED instruction contract

- Owner: `src/server.test.ts`.
- Prerequisite: approved specification.
- Invariant: verification and evidence are never sacrificed for call count.
- RED: the Codex server instructions still encourage unlimited calls and do not
  define objective scope, a soft checkpoint, or a diminishing-return stop.
- GREEN target: assertions cover the selected model-visible policy without
  coupling to private implementation state.
- Verification: `npx tsx src/server.test.ts` fails for the intended missing
  contract before production changes.
- Rollback: revert the focused assertions.

### ATE-2 - Minimal adaptive instruction policy

- Owner: `src/server.ts`.
- Prerequisite: ATE-1 is RED.
- Invariant: all existing tools and necessary verification remain available.
- GREEN: replace unlimited-call encouragement in the Codex server instructions
  and `exec_command`/`read` descriptions with the approved adaptive policy.
- Verification: focused server test passes, then full suite, typecheck, build,
  package dry run, and `git diff --check`.
- Rollback: revert `src/server.ts`; no migration or stored state exists.

### ATE-3 - Installed-path and project truth closure

- Owner: wrapper release gate and its five canonical context files only where a
  material verified delta belongs.
- Prerequisite: ATE-2 green.
- Invariant: source-checkout proof is not represented as live ChatGPT behavior.
- GREEN: promote through the existing release gate, restart owned STONKS, verify
  `/healthz`, and record the exact local proof plus the remaining human canary.
- Verification: existing release-gate receipt and live watchdog status.
- Rollback: restore the previously verified DevSpace commit and restart only
  watchdog-owned processes.

## Completion signal

The running Codex-compatible DevSpace server exposes the adaptive policy,
retains the full tool and evidence surface, passes the existing release gate,
and clearly leaves ChatGPT Web behavior as a separate human canary.
