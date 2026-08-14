# Adaptive Tool Efficiency Design

## Objective

Make every Codex-compatible DevSpace connection instruct its MCP host to finish
one user objective with the fewest tool calls that preserve correctness,
evidence, and recovery safety.

## Current facts

- `serverInstructions()` currently tells the host to use as many `read` or
  `exec_command` calls as needed and never omit evidence to reduce call count.
- ChatGPT can therefore interpret broad authorization as permission to continue
  through later TODOs after the requested deliverable is already verified.
- DevSpace receives an opaque OpenAI conversation scope, but no verified
  per-user-turn boundary on which a correct server-side call budget can reset.
- DevSpace's project contract keeps the MCP host as orchestrator and favors
  composable primitives over hidden workflow state.

## Selected design

Change the model-facing Codex tool-mode instructions and affected tool
descriptions. The policy will:

- keep completeness, correctness, and verification as the quality floor;
- prefer one grouped inspection over equivalent micro-calls when provenance and
  output clarity are preserved;
- keep one active user objective per turn;
- state that broad authorization removes repeated confirmations but does not
  authorize opening later backlog items;
- require a soft efficiency checkpoint after roughly 30 direct tool calls for
  the same objective;
- continue past that checkpoint only for a bounded reason: near completion,
  safe-state recovery, or one still-missing causal proof;
- treat repeated calls without new evidence as diminishing returns;
- stop and report after a material deliverable satisfies its acceptance
  criteria instead of automatically starting the next TODO.

The checkpoint is advisory and model-visible. It is not a server-side hard cap.

## Rejected alternatives

### Hard server-side call cap

Rejected because DevSpace cannot currently identify a reliable user-turn
boundary or determine whether a call is required for verification, cleanup, or
process recovery. A hard cap could strand a running process or suppress the
proof required before completion.

### Stateful conversation governor

Rejected for this delivery because the available OpenAI scope is
conversation-level. Resetting by inactivity would be heuristic and could merge
or split objectives incorrectly. Injecting a warning into every response would
also increase output and token usage.

### New checkpoint tool

Rejected because it enlarges the public tool surface, adds another call, and
still relies on host compliance. The same behavior can be expressed through the
existing server and tool instructions with a smaller regression surface.

## Invariants and non-goals

- No tool is blocked solely because a numerical threshold was crossed.
- Required evidence, safe cleanup, and process polling remain available.
- Tool schemas, handlers, persistence, OAuth, workspace lifecycle, and
  subagent policy remain unchanged.
- No prompts, commands, paths, or tool payloads are persisted for efficiency
  scoring.
- This delivery does not claim that model instructions can force ChatGPT to end
  a response; it only removes the current opposing instruction and provides a
  stronger default policy.

## Acceptance signals

- A focused public server test fails against the previous unlimited-call
  wording and passes only when the adaptive policy is present.
- The Codex `exec_command` and `read` descriptions preserve evidence while
  preferring efficient grouping and explicit diminishing-return checks.
- Existing server tests, the full test suite, typecheck, build, package dry run,
  and the wrapper release gate remain green.
- A later human ChatGPT Web canary is the only proof of host behavior; local
  tests prove only the MCP instructions exposed by DevSpace.

## Rollback

Revert the instruction and test changes, rebuild DevSpace, and restart the
watchdog-owned STONKS runtime. No persistent state or schema migration exists.
