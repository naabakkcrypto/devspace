import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { ServerConfig } from "./config.js";
import type { WorkspaceContext } from "./workspaces.js";

interface FingerprintEntry {
  key: string;
  bytes: number;
  sha256: string;
}

interface SkillFingerprint extends FingerprintEntry {
  name: string;
  descriptionSha256: string;
}

export interface WorkspaceContextFingerprint {
  schemaVersion: 1;
  posture: {
    skillsEnabled: boolean;
    subagentsEnabled: boolean;
  };
  instructions: FingerprintEntry[];
  availableInstructions: string[];
  skills: SkillFingerprint[];
  subagentProfiles: number;
  aggregateSha256: string;
}

export async function fingerprintWorkspaceContext(
  context: WorkspaceContext,
  config: ServerConfig,
): Promise<WorkspaceContextFingerprint> {
  const instructions = context.agentsFiles
    .map((file) => ({
      key: contextPathKey(file.path, context.workspace.root, config.agentDir),
      bytes: Buffer.byteLength(file.content),
      sha256: sha256(file.content),
    }))
    .sort(compareByKey);
  const availableInstructions = context.availableAgentsFiles
    .map((file) => contextPathKey(file.path, context.workspace.root, config.agentDir))
    .sort();
  const skills = await Promise.all(context.workspace.skills.map(async (skill) => {
    const content = await readFile(skill.filePath, "utf8");
    return {
      key: skill.name,
      name: skill.name,
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
      descriptionSha256: sha256(skill.description ?? ""),
    };
  }));
  skills.sort(compareByKey);

  const fingerprint = {
    schemaVersion: 1 as const,
    posture: {
      skillsEnabled: config.skillsEnabled,
      subagentsEnabled: config.subagents,
    },
    instructions,
    availableInstructions,
    skills,
    subagentProfiles: context.workspace.agentProfiles.length,
  };
  return {
    ...fingerprint,
    aggregateSha256: sha256(stableJson(fingerprint)),
  };
}

function contextPathKey(path: string, workspaceRoot: string, agentDir: string): string {
  const absolute = resolve(path);
  const workspaceRelative = safeRelative(workspaceRoot, absolute);
  if (workspaceRelative !== undefined) return `workspace/${workspaceRelative}`;
  const agentRelative = safeRelative(agentDir, absolute);
  if (agentRelative !== undefined) return `agent-dir/${agentRelative}`;
  return `external/${basename(absolute)}`;
}

function safeRelative(root: string, path: string): string | undefined {
  const value = relative(resolve(root), path);
  if (value === "") return ".";
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) return undefined;
  return value.split(sep).join("/");
}

function compareByKey(left: FingerprintEntry, right: FingerprintEntry): number {
  return left.key.localeCompare(right.key);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
