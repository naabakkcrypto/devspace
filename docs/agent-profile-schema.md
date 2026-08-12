# Subagent profile schema

DevSpace agent profiles are user-owned markdown files with YAML
frontmatter. They describe roles such as reviewer, explorer, or implementer.
DevSpace owns provider invocation.

Profiles are discovered from:

- `~/.devspace/agents/*.md`
- `.devspace/agents/*.md`

Packaged files under `examples/agents/` are starter templates only.

## Minimal shape

```md
---
schema: devspace-agent/v1
name: reviewer
description: Read-only reviewer for bugs, security risks, and missing tests.
provider: codex
model: gpt-5.4
thinking: high
writeMode: read_only
disabled: false
---

You are a read-only reviewer. Do not edit files.
Focus on correctness, security, test gaps, and maintainability.
Cite files and return concise findings.
```

## Frontmatter fields

### `schema`

Optional schema identifier:

```yaml
schema: devspace-agent/v1
```

### `name`

Stable profile identifier shown to the model and accepted by:

```bash
devspace agents run <name> "<prompt>"
```

Use lowercase kebab-case names. If omitted, DevSpace uses the filename without
`.md`.

### `description`

Required short purpose. This is exposed by `open_workspace` so the supervising
model can choose the right profile.

### `provider`

Required built-in provider id:

```yaml
provider: codex
provider: claude
provider: opencode
provider: pi
provider: cursor
provider: copilot
```

Unsupported or custom provider ids are rejected. DevSpace retains native
adapter candidates for the following catalog ids:

- `codex`: Codex SDK
- `claude`: Claude Code SDK
- `opencode`: OpenCode SDK
- `pi`: Pi RPC mode
- `cursor`: ACP
- `copilot`: ACP

The managed subagent runner is deliberately stricter than this catalog: only
Codex is currently certified for managed execution. Non-Codex profiles are
reported as catalog-only/unavailable by `open_workspace` even when the local
adapter package or command exists.

### `model`

Optional provider model id or alias.

```yaml
model: gpt-5.4
model: sonnet
```

### `thinking`

Optional provider reasoning effort, thinking level, or model variant. If omitted,
DevSpace lets the provider default apply. Values are provider-specific
passthrough strings; DevSpace does not translate names between harnesses.

```yaml
thinking: low
thinking: high
thinking: xhigh
```

DevSpace passes this through to providers that expose a matching control:

- `claude`: SDK effort with adaptive thinking.
- `codex`: SDK model reasoning effort.
- `pi`: `--thinking`.
- `opencode`: model variant.
- `cursor` and `copilot`: ACP thought-level config when supported.

### `writeMode`

Optional profile write policy. When omitted, the profile is treated as
`read_only`.

```yaml
writeMode: read_only
writeMode: allowed
```

`write_mode` is accepted as a compatibility alias. Values must be strings and
must be exactly `read_only` or `allowed`; invalid values reject the profile.
There is no profile-level `full_access` mode.

Managed execution currently accepts Codex profiles only. Non-Codex examples
remain useful catalog templates, but the CLI fails closed until an adapter has
executable sandbox evidence. An `allowed` Codex profile is accepted only in a
managed DevSpace worktree; requested model, thinking, and write mode remain
unverified runtime metadata unless a provider supplies native evidence.

### `disabled`

Optional boolean. Disabled profiles are not exposed.

```yaml
disabled: true
```

## Markdown body

The body is the profile prompt prefix DevSpace prepends when launching that
profile. It is not included in `open_workspace` by default.

Recommended body content:

- When to use this profile.
- Whether the worker should act read-only or may make changes.
- Output format.
- Review or testing expectations.

## Model-facing workflow

The Subagent skill teaches only:

```bash
devspace agents ls
devspace agents run <profile-or-id> "<prompt>"
devspace agents show <id>
```

`open_workspace` exposes compact profile metadata:

```json
{
  "name": "reviewer",
  "description": "Read-only reviewer for bugs, security risks, and missing tests.",
  "provider": "codex",
  "model": "gpt-5.4",
  "thinking": "high",
  "writeMode": "read_only",
  "profileHash": "<sha256>"
}
```

`devspace agents ls` lists existing subagent sessions for the current workspace;
it does not list profile definitions.

The full profile body stays out of the model context until DevSpace launches the
profile.

## Current non-goals

- Custom or arbitrary CLI-backed agents.
- Inferring changed files, tests, or diffs from worker output.
- Exposing raw provider transcripts by default.
- Teaching the model provider-specific CLIs.
- First-class MCP agent tools. Future tools should wrap the same provider
  adapter registry used by `devspace agents`.
