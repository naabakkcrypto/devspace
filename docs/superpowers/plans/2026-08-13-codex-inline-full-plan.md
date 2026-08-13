# Codex Inline Full Context Implementation Plan

Specification: `docs/superpowers/specs/2026-08-13-codex-inline-full-design.md`

## Task graph

### CIF-1 - Observable inline-full posture

- Owner: `src/config.ts`, `src/server.ts`, their focused tests.
- Prerequisite: none.
- Invariant: diagnostics contain no path or secret.
- RED: health response lacks the required context/delegation fields and uses a
  version inconsistent with `package.json`.
- GREEN: expose bounded posture derived from effective configuration and one
  package-owned version source.
- Verification: focused server/config tests and health request.
- Rollback: revert CIF-1 without changing persistent state.

### CIF-2 - Real filesystem containment

- Owner: `src/roots.ts`, `src/pi-tools.ts`, `src/roots.test.ts` and focused tool
  tests.
- Prerequisite: none.
- Invariant: lexical paths and real filesystem targets both remain inside the
  applicable root.
- RED: a junction inside a workspace reads a sentinel outside the workspace.
- GREEN: validate the real target or nearest existing parent before delegating
  to file tools.
- Verification: junction escape tests plus existing roots, patch, artifact and
  workspace tests.
- Rollback: revert CIF-2; no data migration exists.

### CIF-3 - STONKS profile and cross-shell ownership

- Owner: wrapper repository watchdog and watchdog tests only.
- Prerequisite: CIF-1 diagnostic contract known.
- Invariant: skills and shared agentDir stay enabled while subagents remain
  disabled.
- RED: PowerShell 7 reports owned listeners as unowned and the contract does
  not require the explicit shared agentDir/profile.
- GREEN: compare normalized instants and project the complete inline profile.
- Verification: contract and live status in Windows PowerShell 5.1 and
  PowerShell 7.
- Rollback: revert wrapper commit and restart the owned watchdog.

### CIF-4 - Integrated release evidence

- Owner: documentation and canonical wrapper truth files after code is green.
- Prerequisites: CIF-1, CIF-2, CIF-3.
- Invariant: repository truth distinguishes full context from model delegation.
- RED: stale docs describe only the previous subagent policy.
- GREEN: update the smallest canonical sections and record exact proofs.
- Verification: both worktrees clean except declared pre-existing artifacts,
  full test/build/package gates pass, live runtime reports delegation disabled.
- Rollback: revert documentation with its owning code change.

## Completion signal

ChatGPT Web receives the complete shared Codex instruction and skill environment,
DevSpace reports `codex-inline-full` with zero loaded providers and delegation
disabled, all agent commands remain blocked, junction escapes fail, and both
PowerShell editions agree that the live STONKS runtime is owned and ready.
