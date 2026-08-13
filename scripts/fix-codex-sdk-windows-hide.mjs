import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
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
  let current = resolve(projectRoot);
  const filesystemRoot = parse(current).root;
  while (true) {
    const packageRoot = join(current, "node_modules", "@openai", "codex-sdk");
    const manifestPath = join(packageRoot, "package.json");
    if (existsSync(manifestPath) && statSync(manifestPath).isFile()) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const rootExport = manifest.exports?.["."];
      const entry = typeof rootExport === "string"
        ? rootExport
        : rootExport?.import ?? rootExport?.default ?? manifest.module ?? manifest.main;
      if (typeof entry !== "string" || !entry.startsWith("./")) {
        throw new Error(`Unable to resolve the Codex SDK import entry from ${manifestPath}.`);
      }
      const sdkPath = resolve(packageRoot, entry);
      if (!existsSync(sdkPath) || !statSync(sdkPath).isFile()) {
        throw new Error(`Resolved Codex SDK entry is missing: ${sdkPath}`);
      }
      return sdkPath;
    }
    if (current === filesystemRoot) break;
    current = dirname(current);
  }
  throw new Error(`Unable to locate @openai/codex-sdk from ${projectRoot}.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await patchInstalledCodexSdk();
  console.log(result.changed ? "Patched Codex SDK Windows console spawning." : "Codex SDK Windows console spawning already patched.");
}
