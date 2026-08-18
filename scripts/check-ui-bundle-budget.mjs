import { existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function auditUiBundle(manifestPath, options = {}) {
  const maxInitialRawBytes = options.maxInitialRawBytes ?? 450_000;
  const maxInitialGzipBytes = options.maxInitialGzipBytes ?? 120_000;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const outputRoot = resolve(dirname(manifestPath), "..");
  const entry = Object.values(manifest).find((item) => item.isEntry);
  if (!entry) throw new Error("Vite manifest has no entry chunk.");
  const initialFiles = new Set();
  const visit = (item) => {
    if (!item?.file || initialFiles.has(item.file)) return;
    initialFiles.add(item.file);
    for (const key of item.imports ?? []) visit(manifest[key]);
  };
  visit(entry);
  let initialRawBytes = 0;
  let initialGzipBytes = 0;
  for (const file of initialFiles) {
    const contents = readFileSync(join(outputRoot, file));
    initialRawBytes += contents.length;
    initialGzipBytes += gzipSync(contents).length;
  }
  if (initialRawBytes > maxInitialRawBytes) throw new Error(`Initial UI bundle is ${initialRawBytes} bytes (limit ${maxInitialRawBytes}).`);
  if (initialGzipBytes > maxInitialGzipBytes) throw new Error(`Initial UI bundle gzip is ${initialGzipBytes} bytes (limit ${maxInitialGzipBytes}).`);
  return { initialFiles: [...initialFiles], initialRawBytes, initialGzipBytes };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const manifestPath = resolve(process.argv[2] ?? "dist/ui/.vite/manifest.json");
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) throw new Error(`Vite manifest not found: ${manifestPath}`);
  console.log(JSON.stringify({ status: "ok", ...auditUiBundle(manifestPath) }));
}
