import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addCodexSdkWindowsHide,
  codexSdkSpawnIsHidden,
} from "./fix-codex-sdk-windows-hide.mjs";

const unpatched = [
  "const child = spawn(this.executablePath, commandArgs, {",
  "      env,",
  "      signal: args.signal",
  "    });",
].join("\n");
const firstPass = addCodexSdkWindowsHide(unpatched);
assert.equal(firstPass.changed, true);
assert.equal(codexSdkSpawnIsHidden(firstPass.source), true);
const secondPass = addCodexSdkWindowsHide(firstPass.source);
assert.equal(secondPass.changed, false);
assert.equal(secondPass.source, firstPass.source);
assert.throws(
  () => addCodexSdkWindowsHide("const child = spawn(otherExecutable, []);"),
  /Expected exactly one unhidden Codex SDK spawn call/,
);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installedSdk = await readFile(
  resolve(projectRoot, "node_modules", "@openai", "codex-sdk", "dist", "index.js"),
  "utf8",
);
assert.equal(
  codexSdkSpawnIsHidden(installedSdk),
  true,
  "The installed Codex SDK must hide its Windows console process.",
);
