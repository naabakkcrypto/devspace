import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Keep the DevSpace workspace root as the authority boundary while preserving
 * the directory from which the user launched the subagent command.
 */
export function resolveLocalAgentExecutionRoot(
  workspaceRoot: string,
  currentDirectory: string,
): string {
  const authorityRoot = canonicalExistingDirectory(workspaceRoot, "workspace root");
  const executionRoot = canonicalExistingDirectory(currentDirectory, "execution directory");
  const relationship = relative(authorityRoot, executionRoot);
  if (
    relationship === ".."
    || relationship.startsWith(`..${sep}`)
    || isAbsolute(relationship)
  ) {
    throw new Error("Subagent execution directory is outside the active DevSpace workspace.");
  }
  return executionRoot;
}

function canonicalExistingDirectory(path: string, label: string): string {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    throw new Error(`Subagent ${label} is unavailable.`);
  }
}
