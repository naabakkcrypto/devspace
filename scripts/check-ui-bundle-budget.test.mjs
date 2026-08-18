import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditUiBundle } from "./check-ui-bundle-budget.mjs";

const root = mkdtempSync(join(tmpdir(), "devspace-ui-budget-"));
mkdirSync(join(root, ".vite"));
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "assets", "entry.js"), "x".repeat(100));
writeFileSync(join(root, "assets", "lazy.js"), "y".repeat(10_000));
writeFileSync(join(root, ".vite", "manifest.json"), JSON.stringify({
  "index.html": { file: "assets/entry.js", isEntry: true, dynamicImports: ["lazy.js"] },
  "lazy.js": { file: "assets/lazy.js", isDynamicEntry: true },
}));
const manifestPath = join(root, ".vite", "manifest.json");
const result = auditUiBundle(manifestPath, { maxInitialRawBytes: 200, maxInitialGzipBytes: 200 });
assert.deepEqual(result.initialFiles, ["assets/entry.js"]);
assert.equal(result.initialRawBytes, 100);
assert.throws(() => auditUiBundle(manifestPath, { maxInitialRawBytes: 99 }), /Initial UI bundle is 100 bytes/);
console.log("UI bundle budget tests passed");
