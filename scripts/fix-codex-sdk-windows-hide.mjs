import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = resolve(scriptRoot, "..");

export function codexSdkSpawnIsHidden(source) {
  return /const child = spawn\(this\.executablePath, commandArgs, \{\s*env,\s*windowsHide:\s*true,\s*signal: args\.signal\s*\}\);/.test(source);
}

export function addCodexSdkWindowsHide(source) {
  if (codexSdkSpawnIsHidden(source)) return { source, changed: false };

  const pattern = /const child = spawn\(this\.executablePath, commandArgs, \{\r?\n([ \t]+)env,(\r?\n)([ \t]+)signal: args\.signal\r?\n([ \t]+)\}\);/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one unhidden Codex SDK spawn call, found ${matches.length}.`,
    );
  }

  const match = matches[0];
  const indentation = match[1];
  const newline = match[2];
  const replacement = match[0].replace(
    `${indentation}env,${newline}`,
    `${indentation}env,${newline}${indentation}windowsHide: true,${newline}`,
  );
  return {
    source: source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length),
    changed: true,
  };
}

export async function patchInstalledCodexSdk(projectRoot = defaultProjectRoot) {
  const sdkPath = resolveInstalledCodexSdkPath(projectRoot);
  const source = await readFile(sdkPath, "utf8");
  const patched = addCodexSdkWindowsHide(source);
  if (patched.changed) await writeFile(sdkPath, patched.source, "utf8");
  return { sdkPath, changed: patched.changed };
}

export function resolveInstalledCodexSdkPath(projectRoot = defaultProjectRoot) {
  const requireFromPackage = createRequire(resolve(projectRoot, "package.json"));
  return requireFromPackage.resolve("@openai/codex-sdk");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await patchInstalledCodexSdk();
  console.log(result.changed ? "Patched Codex SDK Windows console spawning." : "Codex SDK Windows console spawning already patched.");
}
