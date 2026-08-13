import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertAllowedPath, expandHomePath, resolveAllowedPath } from "./roots.js";
import { editFileTool, readFileTool, writeFileTool } from "./pi-tools.js";

const home = homedir();

assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/personal/devspace"), resolve(home, "personal", "devspace"));
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");

assert.equal(
  assertAllowedPath("~/personal/devspace", [join(home, "personal")]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  assertAllowedPath("~/personal/devspace", ["~/personal"]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  resolve("/workspace", "~/file.txt"),
);

if (process.platform === "win32") {
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\devspace"]),
    /Path is outside allowed roots/,
  );
}

const containmentRoot = await mkdtemp(join(tmpdir(), "devspace-containment-root-"));
const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-containment-outside-"));
try {
  await mkdir(join(containmentRoot, "inside"));
  await writeFile(join(outsideRoot, "sentinel.txt"), "outside workspace");
  await symlink(outsideRoot, join(containmentRoot, "inside", "escape"), process.platform === "win32" ? "junction" : "dir");
  const response = await readFileTool(
    { path: "inside/escape/sentinel.txt" },
    { cwd: containmentRoot, root: containmentRoot },
  );
  assert.equal(response.isError, true);
  assert.match(response.content[0]?.type === "text" ? response.content[0].text : "", /outside allowed roots/i);

  const writeResponse = await writeFileTool(
    { path: "inside/escape/new.txt", content: "must not be written" },
    { cwd: containmentRoot, root: containmentRoot },
  );
  assert.equal(writeResponse.isError, true);
  assert.match(writeResponse.content[0]?.type === "text" ? writeResponse.content[0].text : "", /outside allowed roots/i);

  const editResponse = await editFileTool(
    {
      path: "inside/escape/sentinel.txt",
      edits: [{ oldText: "outside workspace", newText: "must not be edited" }],
    },
    { cwd: containmentRoot, root: containmentRoot },
  );
  assert.equal(editResponse.isError, true);
  assert.match(editResponse.content[0]?.type === "text" ? editResponse.content[0].text : "", /outside allowed roots/i);
} finally {
  await rm(containmentRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
}
