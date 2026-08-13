# Codex Inline Full Context Design

## Objective

Provide ChatGPT Web with the same applicable Codex project context used on this
machine while making DevSpace incapable of launching delegated model sessions
when the inline profile is active.

## Required invariants

- `DEVSPACE_AGENT_DIR` remains `C:\Users\hugop\.codex`.
- Global, project, and nested instruction files remain discoverable.
- All normal Codex skills remain discoverable and readable.
- `DEVSPACE_SUBAGENTS=0` hides agent profiles and delegation skills and makes
  every `devspace agents ...` command fail closed.
- The host ChatGPT conversation is the only model execution path.
- Existing workspace, file, patch, process, Git, and verification behavior is
  preserved.
- Diagnostics never expose paths, tokens, environment values, or credentials.

## Architecture

The existing `codex` tool mode remains the execution surface. STONKS explicitly
projects a `codex-inline-full` operating profile by enabling skills, pointing
`agentDir` at the shared Codex directory, disabling subagents and widgets, and
keeping compact logs.

DevSpace reports a bounded runtime posture on `/healthz`: context profile,
skills state, subagent state, number of loaded agent providers, delegation
availability, tool mode, widget mode, and package version. These fields are
configuration facts only and contain no local paths.

Instruction and skill loading remain unchanged in this delivery. A later lazy
loading optimization is admissible only after an equivalence test proves that
the same applicable rules and skills remain reachable. Initial-context size is
not reduced by deleting or summarizing authoritative context.

Filesystem tools must resolve existing targets and their nearest existing
parents through the filesystem before trusting lexical containment. Junctions
and symbolic links may not escape an approved read or write root.

## STONKS runtime behavior

The watchdog owns the effective inline profile and exposes it in its status
result. Ownership timestamps are normalized as instants rather than compared as
PowerShell-dependent strings, so Windows PowerShell 5.1 and PowerShell 7 return
the same status.

## Non-goals

- No subagent implementation, provider activation, or agent profile migration.
- No removal or summarization of Codex rules or skills.
- No narrowing of `C:\A - PROJETS` in this delivery.
- No change to shell authority or project environment inheritance.
- No widget or visual diff activation.

## Verification

- RED/GREEN tests for the inline profile contract and cross-shell ownership.
- RED/GREEN junction escape tests for file reads and writes.
- DevSpace focused tests, full test suite, typecheck, build, package dry run,
  and `git diff --check`.
- STONKS contract and live status under Windows PowerShell 5.1 and PowerShell 7.
- Runtime health output proves full context enabled and delegation disabled.

## Rollback

Revert the DevSpace and wrapper commits independently. The SQLite schema and
user configuration are unchanged. Restart only watchdog-owned processes after
restoring the previous verified build.
