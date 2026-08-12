import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ServerConfig } from "./config.js";

export type LocalAgentProvider = "codex" | "claude" | "opencode" | "pi" | "cursor" | "copilot";
export type LocalAgentWriteMode = "read_only" | "allowed";

export const LOCAL_AGENT_PROVIDERS: readonly LocalAgentProvider[] = [
  "codex",
  "claude",
  "opencode",
  "pi",
  "cursor",
  "copilot",
];

export interface LocalAgentProfile {
  name: string;
  description: string;
  provider: LocalAgentProvider;
  model?: string;
  thinking?: string;
  writeMode: LocalAgentWriteMode;
  profileHash: string;
  filePath: string;
  body: string;
  disabled: boolean;
}

export interface LocalAgentProfileSummary {
  name: string;
  description: string;
  provider: LocalAgentProvider;
  model?: string;
  thinking?: string;
  writeMode: LocalAgentWriteMode;
  profileHash: string;
}

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_DELIMITER = "---";
const PROVIDERS = new Set<LocalAgentProvider>(LOCAL_AGENT_PROVIDERS);
const WRITE_MODES = new Set<LocalAgentWriteMode>(["read_only", "allowed"]);

export async function loadLocalAgentProfiles(
  config: ServerConfig,
  workspaceRoot: string,
): Promise<LocalAgentProfile[]> {
  if (!config.subagents) return [];

  const profileDirs = [
    config.devspaceAgentsDir,
    join(workspaceRoot, ".devspace", "agents"),
  ];
  const profilesByName = new Map<string, LocalAgentProfile>();

  for (const directory of profileDirs) {
    for (const profile of await loadProfilesFromDirectory(directory)) {
      profilesByName.set(profile.name, profile);
    }
  }

  return Array.from(profilesByName.values())
    .filter((profile) => !profile.disabled)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizeLocalAgentProfile(
  profile: LocalAgentProfile,
): LocalAgentProfileSummary {
  return {
    name: profile.name,
    description: profile.description,
    provider: profile.provider,
    model: profile.model,
    thinking: profile.thinking,
    writeMode: profile.writeMode,
    profileHash: profile.profileHash,
  };
}

async function loadProfilesFromDirectory(directory: string): Promise<LocalAgentProfile[]> {
  const resolvedDirectory = resolve(directory);
  if (!existsSync(resolvedDirectory)) return [];

  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  const profiles: LocalAgentProfile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;

    const filePath = join(resolvedDirectory, entry.name);
    try {
      profiles.push(await loadProfileFile(filePath));
    } catch (error) {
      console.warn(`Skipping invalid subagent profile ${filePath}: ${errorMessage(error)}`);
    }
  }

  return profiles;
}

async function loadProfileFile(filePath: string): Promise<LocalAgentProfile> {
  const content = await readFile(filePath, "utf8");
  const parsed = parseFrontmatter(content, filePath);
  return profileFromFrontmatter(parsed.frontmatter, parsed.body, filePath);
}

function parseFrontmatter(content: string, filePath: string): ParsedFrontmatter {
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new Error(`Subagent profile is missing frontmatter: ${filePath}`);
  }

  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (endIndex === -1) {
    throw new Error(`Subagent profile frontmatter is not closed: ${filePath}`);
  }

  return {
    frontmatter: parseProfileYaml(lines.slice(1, endIndex).join("\n"), filePath),
    body: lines.slice(endIndex + 1).join("\n").trim(),
  };
}

function parseProfileYaml(source: string, filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(source) ?? {};
  } catch (error) {
    throw new Error(`Unable to parse subagent profile frontmatter: ${filePath}: ${errorMessage(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Subagent profile frontmatter must be a mapping: ${filePath}`);
  }

  return parsed as Record<string, unknown>;
}

function profileFromFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
  filePath: string,
): LocalAgentProfile {
  const name = readString(frontmatter, "name") ?? basename(filePath, ".md");
  const description = readString(frontmatter, "description");
  const provider = readProvider(frontmatter, filePath);
  const writeMode = readWriteMode(frontmatter, filePath);
  if (!description) {
    throw new Error(`Subagent profile is missing description: ${filePath}`);
  }

  return {
    name,
    description,
    provider,
    model: readString(frontmatter, "model"),
    thinking: readString(frontmatter, "thinking"),
    writeMode,
    profileHash: hashProfileContent(frontmatter, body),
    filePath,
    body,
    disabled: frontmatter.disabled === true,
  };
}

function readWriteMode(
  frontmatter: Record<string, unknown>,
  filePath: string,
): LocalAgentWriteMode {
  const hasCanonical = Object.prototype.hasOwnProperty.call(frontmatter, "writeMode");
  const hasAlias = Object.prototype.hasOwnProperty.call(frontmatter, "write_mode");
  if (hasCanonical && hasAlias) {
    throw new Error(`Subagent profile must not define both writeMode and write_mode: ${filePath}`);
  }
  if (!hasCanonical && !hasAlias) return "read_only";

  const key = hasCanonical ? "writeMode" : "write_mode";
  const value = frontmatter[key];
  if (typeof value !== "string") {
    throw new Error(`Subagent profile ${key} must be read_only or allowed: ${filePath}`);
  }

  const normalized = value.trim();
  if (!WRITE_MODES.has(normalized as LocalAgentWriteMode)) {
    throw new Error(`Subagent profile ${key} must be read_only or allowed: ${filePath}`);
  }
  return normalized as LocalAgentWriteMode;
}

function hashProfileContent(frontmatter: Record<string, unknown>, body: string): string {
  const canonical = `${stableSerialize(frontmatter)}\n${body.replace(/\r\n?/g, "\n").trim()}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function readProvider(frontmatter: Record<string, unknown>, filePath: string): LocalAgentProvider {
  const provider = readString(frontmatter, "provider");
  if (!provider) {
    throw new Error(`Subagent profile is missing provider: ${filePath}`);
  }
  if (!PROVIDERS.has(provider as LocalAgentProvider)) {
    throw new Error(
      `Subagent profile provider must be codex, claude, opencode, pi, cursor, or copilot: ${filePath}`,
    );
  }
  return provider as LocalAgentProvider;
}

export function isLocalAgentProvider(value: string): value is LocalAgentProvider {
  return PROVIDERS.has(value as LocalAgentProvider);
}

function readString(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
