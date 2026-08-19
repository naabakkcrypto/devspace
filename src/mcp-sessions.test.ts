import assert from "node:assert/strict";
import { createMcpSessionResource, McpSessionRegistry } from "./mcp-sessions.js";

interface FakeTransport {
  closeCalls: number;
  close(): Promise<void>;
}

function createTransport(closeError?: Error): FakeTransport {
  return {
    closeCalls: 0,
    async close() {
      this.closeCalls += 1;
      if (closeError) throw closeError;
    },
  };
}

let now = 0;
const registry = new McpSessionRegistry<FakeTransport>({ now: () => now });
const staleTransport = createTransport();
const activeTransport = createTransport();

registry.register("stale", staleTransport);
now = 1_000;
registry.register("active", activeTransport);
now = 1_500;
assert.equal(registry.get("active"), activeTransport);
now = 2_000;

const idleResults = await registry.closeIdle(1_500);
assert.deepEqual(idleResults, [{ sessionId: "stale" }]);
assert.equal(staleTransport.closeCalls, 1);
assert.equal(activeTransport.closeCalls, 0);
assert.equal(registry.size, 1);
assert.equal(registry.get("stale"), undefined);
assert.equal(registry.get("active"), activeTransport);

const closeError = new Error("close failed");
const failingTransport = createTransport(closeError);
registry.register("failing", failingTransport);
now = 10_000;

const failingResults = await registry.closeIdle(1);
assert.equal(failingResults.length, 2);
assert.deepEqual(failingResults.map((result) => result.sessionId).sort(), ["active", "failing"]);
assert.equal(failingResults.find((result) => result.sessionId === "failing")?.error, closeError);
assert.equal(failingTransport.closeCalls, 1);
assert.equal(registry.size, 0);

const first = createTransport();
const second = createTransport();
registry.register("first", first);
registry.register("second", second);
registry.remove("first");

const shutdownResults = await registry.closeAll();
assert.deepEqual(shutdownResults, [{ sessionId: "second" }]);
assert.equal(first.closeCalls, 0);
assert.equal(second.closeCalls, 1);
assert.equal(registry.size, 0);

let finishDelayedClose: (() => void) | undefined;
let delayedCloseResolved = false;
const delayedTransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishDelayedClose = resolve;
    });
  },
};
registry.register("delayed", delayedTransport);
const delayedClose = registry.closeAll();
void delayedClose.then(() => {
  delayedCloseResolved = true;
});

await Promise.resolve();
assert.equal(delayedCloseResolved, false);
assert.equal(delayedTransport.closeCalls, 1);
finishDelayedClose?.();
await delayedClose;
assert.equal(delayedCloseResolved, true);
assert.equal(registry.size, 0);

const bounded = new McpSessionRegistry<FakeTransport>({ now: () => now });
const oldest = createTransport();
const middle = createTransport();
const newest = createTransport();
now = 1;
bounded.register("oldest", oldest);
now = 2;
bounded.register("middle", middle);
now = 3;
bounded.register("newest", newest);
const overflowResults = await bounded.closeOverflow(2);
assert.deepEqual(overflowResults, [{ sessionId: "oldest" }]);
assert.equal(oldest.closeCalls, 1);
assert.equal(middle.closeCalls, 0);
assert.equal(newest.closeCalls, 0);
assert.equal(bounded.size, 2);

const managedTransport = createTransport();
const managedServer = createTransport();
const managed = createMcpSessionResource(managedTransport, managedServer);
assert.equal(managed.transport, managedTransport);
await managed.close();
await managed.close();
assert.equal(managedTransport.closeCalls, 1);
assert.equal(managedServer.closeCalls, 1);

let reentrantClose: (() => Promise<void>) | undefined;
const reentrantTransport: FakeTransport = {
  closeCalls: 0,
  async close() {
    this.closeCalls += 1;
    void reentrantClose?.();
  },
};
const reentrantServer = createTransport();
const reentrantManaged = createMcpSessionResource(reentrantTransport, reentrantServer);
reentrantClose = () => reentrantManaged.close();
await reentrantManaged.close();
assert.equal(reentrantTransport.closeCalls, 1);
assert.equal(reentrantServer.closeCalls, 1);
