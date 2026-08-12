---
name: subagent-delegation
description: Delegate coding tasks to user-configured DevSpace subagents.
---

# Subagent Delegation

Use this skill when the user explicitly asks to delegate work to another coding
agent, use a named subagent, get a second opinion, compare approaches, or run
a subagent-like workflow. Also use it proactively when an authorized objective
contains at least two independent ready lanes, material security/regression
risk, conflicting evidence, or a useful falsification lane.

Do not use subagents silently. Tell the user which profiles are being used and
why. The host remains the orchestrator and owns decomposition, barriers,
integration, verification, and the final answer.

## Core commands

Use only these commands for normal delegation:

```bash
devspace agents ls
devspace agents run <profile-or-provider-or-id> "<prompt>"
devspace agents show <id>
```

`ls` shows existing subagent sessions for the current workspace. DevSpace scopes
it automatically from the shell environment injected by the workspace tool.

`run <profile> "<prompt>"` starts a new configured profile and prints a
DevSpace agent id.

Managed execution is currently Codex-only. Other built-in providers may appear
in the catalog as availability candidates, but their sandbox and runtime
identity are not certified and the managed CLI rejects them. A raw `codex` run
is read-only by default.

`run <id> "<prompt>"` sends a follow-up to an existing agent.

`show <id>` prints status and the latest response. If the agent is still
running, `show` waits briefly. If there is still no final response, call `show`
again later.

Read-only runs heartbeat while active. A read-only run left stale by a crash is
reclaimable after 90 seconds; database fencing prevents its old worker from
overwriting the new result. A running writer fails closed instead of being
auto-reclaimed. Keep its managed worktree isolated until the old process is
confirmed stopped, then use a fresh worktree.

Do not run provider CLIs such as `codex`, `claude`, `opencode`, `pi`,
`cursor-agent`, or `copilot` directly unless you are explicitly debugging
DevSpace agent integration.

## Choosing a profile

Choose profiles from the compact subagent profile catalog returned by
`open_workspace`. Use the profile name with `devspace agents run`. If no
profile fits and delegation is still appropriate, use a built-in provider name
from `open_workspace`.

Profiles may declare a model and optional thinking level. To override the
configured/default provider model or thinking level for a run, pass `--model`
or `--thinking`:

```bash
devspace agents run <profile-or-provider> --model <model> "<prompt>"
devspace agents run <profile-or-provider> --thinking <level> "<prompt>"
```

Use `--thinking` only when the user asks for a specific reasoning depth or when
the task clearly needs a different effort than the configured profile default.
Thinking values are provider-specific passthrough values. Use names supported by
the selected local agent harness; DevSpace does not translate values between
providers.

Profiles also declare `writeMode`:

- `read_only` maps to the Codex read-only sandbox;
- `allowed` maps to workspace-write and is accepted only in a managed DevSpace
  worktree;
- any missing mode defaults to `read_only`; `full_access` is rejected.

Catalog model/thinking/mode values are requests, not runtime proof. Treat a run
receipt as `requested_unverified` unless the adapter returns native observed
identity evidence.
The native runtime may enforce a stricter sandbox than requested. If an
`allowed` worktree canary remains read-only, keep the lane read-only and let the
parent integrate the proposed patch; never bypass the sandbox to force a pass.

Good delegation targets:

- `reviewer`: second opinion, bug risk, security risk, test gaps.
- `explorer`: read-only codebase investigation.
- `implementer`: focused implementation when the user asked for delegation.

Do not delegate deterministic, tightly coupled work just because a profile
exists. When several lanes are independent, launch every ready lane in the same
wave. There is no fixed agent/call/token/cost cap: live concurrency is bounded
by independent useful work and runtime capacity. Stop when acceptance criteria
are proved or marginal value is exhausted and documented.

Use a parent-owned barrier between waves:

1. record each agent id, role, requested provider/model/thinking/mode, task, and
   owned paths;
2. poll every id until `idle`, `error`, or `stopped`;
3. reproduce important file/command evidence and reconcile contradictions;
4. launch another wave only for a remaining acceptance gap.

Never run two writers in one workspace. Give each writable lane its own managed
worktree, then integrate one reviewed candidate. A textual ownership statement
does not replace worktree isolation.

## Worker prompts

Agents start with only the prompt you send plus their configured profile
instructions. Make prompts self-contained.

Implementation prompt shape:

```text
Goal:
<clear goal>

Context:
<repo/module/user constraints>

Relevant files:
<paths and why they matter>

Acceptance criteria:
- <criterion>

Rules:
- Keep changes focused.
- Do not perform unrelated refactors.
- Report blockers clearly.
```

Read-only investigation prompt shape:

```text
Question:
<specific question>

Scope:
<files/directories/modules to inspect>

Rules:
- Do not modify files.
- Cite relevant file paths and symbols.
- Separate facts from guesses.
```

## After the worker responds

Always review the result before presenting it as verified.

For write-capable tasks, inspect changed files and run or explain relevant
tests. For read-only tasks, verify that important claims are supported by repo
evidence.

Be transparent in the final response:

```text
I used <profile>. It reported <summary>. I verified <checks>. Remaining risk:
<risk or none>.
```

Never hide that a subagent was used.
