import { readFileSync } from "node:fs";

interface PackageMetadata {
  version?: unknown;
}

const metadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageMetadata;

if (typeof metadata.version !== "string" || metadata.version.length === 0) {
  throw new Error("DevSpace package version is missing.");
}

export const DEVSPACE_VERSION = metadata.version;
