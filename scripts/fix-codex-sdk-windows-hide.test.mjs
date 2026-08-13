import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  addCodexSdkWindowsHide,
  codexSdkSpawnIsHidden,
  resolveInstalledCodexSdkPath,
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

const hoistedFixture = await mkdtemp(join(tmpdir(), "devspace-hoisted-sdk-"));
try {
  const packageRoot = join(hoistedFixture, "node_modules", "@waishnav", "devspace");
  const sdkRoot = join(hoistedFixture, "node_modules", "@openai", "codex-sdk");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(join(sdkRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), '{"name":"@waishnav/devspace"}');
  await writeFile(
    join(sdkRoot, "package.json"),
    '{"name":"@openai/codex-sdk","exports":{".":{"import":"./dist/index.js","types":"./dist/index.d.ts"}}}',
  );
  await writeFile(join(sdkRoot, "dist", "index.js"), "export {};\n");
  assert.equal(
    resolveInstalledCodexSdkPath(packageRoot),
    join(sdkRoot, "dist", "index.js"),
  );
} finally {
  await rm(hoistedFixture, { recursive: true, force: true });
}
