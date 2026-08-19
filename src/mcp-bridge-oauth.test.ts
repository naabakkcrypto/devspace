import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  McpBridgeOAuthRegistry,
  PersistentMcpBridgeOAuthProvider,
  loadMcpBridgeOAuthTarget,
  mcpBridgeOAuthCredentialPath,
  mcpBridgeOAuthCallbackUrl,
} from "./mcp-bridge-oauth.js";
import { parseMcpBridgeAuthCommand } from "./mcp-bridge-auth.js";

test("bridge OAuth provider persists client credentials, tokens, verifier, and one-time state outside config", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-mcp-oauth-"));
  try {
    const redirects: string[] = [];
    const options = {
      stateDir,
      serverName: "netlify",
      serverUrl: new URL("https://netlify-mcp.netlify.app/mcp"),
      redirectUrl: new URL("http://127.0.0.1:43123/callback"),
      onRedirect: (url: URL) => {
        redirects.push(url.toString());
      },
    };
    const provider = new PersistentMcpBridgeOAuthProvider(options);

    await provider.saveClientInformation({
      client_id: "client-1",
      client_secret: "client-secret",
      redirect_uris: [options.redirectUrl.toString()],
    });
    await provider.saveTokens({
      access_token: "access-secret",
      token_type: "bearer",
      refresh_token: "refresh-secret",
      expires_in: 3600,
    });
    await provider.saveCodeVerifier("verifier-secret");
    const state = await provider.state();
    await provider.redirectToAuthorization(new URL(`https://auth.example/authorize?state=${state}`));

    const restored = new PersistentMcpBridgeOAuthProvider(options);
    assert.equal((await restored.clientInformation())?.client_id, "client-1");
    assert.equal((await restored.tokens())?.access_token, "access-secret");
    assert.equal((await restored.tokens())?.refresh_token, "refresh-secret");
    assert.equal(await restored.codeVerifier(), "verifier-secret");
    assert.equal(await restored.consumeAuthorizationState(state), true);
    assert.equal(await restored.consumeAuthorizationState(state), false);
    assert.deepEqual(redirects, [`https://auth.example/authorize?state=${state}`]);

    const credentials = mcpBridgeOAuthCredentialPath(stateDir, "netlify");
    if (process.platform !== "win32") {
      assert.equal((await stat(credentials)).mode & 0o777, 0o600);
    }
    assert.notEqual(credentials.toLowerCase().endsWith("config.toml"), true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("bridge OAuth credential invalidation is scoped and fails closed for a missing verifier", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-mcp-oauth-"));
  try {
    const provider = new PersistentMcpBridgeOAuthProvider({
      stateDir,
      serverName: "netlify",
      serverUrl: new URL("https://netlify-mcp.netlify.app/mcp"),
      redirectUrl: new URL("http://127.0.0.1:43123/callback"),
    });
    await provider.saveClientInformation({ client_id: "client-1" });
    await provider.saveTokens({ access_token: "access-secret", token_type: "bearer" });
    await provider.saveCodeVerifier("verifier-secret");

    await provider.invalidateCredentials("tokens");
    assert.equal(await provider.tokens(), undefined);
    assert.equal((await provider.clientInformation())?.client_id, "client-1");
    assert.equal(await provider.codeVerifier(), "verifier-secret");

    await provider.invalidateCredentials("all");
    assert.equal(await provider.clientInformation(), undefined);
    await assert.rejects(async () => await provider.codeVerifier(), /verifier/i);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("OAuth target loader accepts an HTTPS streamable HTTP server while it is disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-mcp-oauth-target-"));
  try {
    const configPath = join(directory, "config.toml");
    await writeFile(configPath, [
      "[mcp_servers.netlify]",
      'url = "https://netlify-mcp.netlify.app/mcp"',
      "enabled = false",
      "",
      "[mcp_servers.legacy]",
      'command = "npx"',
      'args = ["-y", "@netlify/mcp"]',
      "enabled = false",
      "",
    ].join("\n"));

    const target = loadMcpBridgeOAuthTarget(configPath, "netlify");
    assert.equal(target.serverName, "netlify");
    assert.equal(target.serverUrl.toString(), "https://netlify-mcp.netlify.app/mcp");
    assert.equal(target.enabled, false);
    assert.throws(() => loadMcpBridgeOAuthTarget(configPath, "legacy"), /streamable HTTP|URL/i);
    assert.throws(() => loadMcpBridgeOAuthTarget(configPath, "missing"), /missing/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OAuth registry reuses one provider per upstream server and rejects URL drift", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-mcp-oauth-registry-"));
  try {
    const registry = new McpBridgeOAuthRegistry({
      stateDir,
      redirectUrlFor: (serverName) => new URL(`http://127.0.0.1:43123/callback/${serverName}`),
    });
    const first = registry.providerFor("netlify", new URL("https://netlify-mcp.netlify.app/mcp"));
    const second = registry.providerFor("netlify", new URL("https://netlify-mcp.netlify.app/mcp"));
    assert.equal(first, second);
    assert.throws(
      () => registry.providerFor("netlify", new URL("https://example.test/mcp")),
      /URL drift/i,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("OAuth callback and command parser stay loopback-only with bounded ports and timeouts", () => {
  assert.equal(
    mcpBridgeOAuthCallbackUrl("netlify").toString(),
    "http://127.0.0.1:7677/mcp-bridge/oauth/callback/netlify",
  );
  const options = parseMcpBridgeAuthCommand([
    "--codex-config", ".\\config.toml",
    "--state-dir", ".\\state",
    "--server", "netlify",
    "--callback-port", "8765",
    "--timeout-sec", "30",
  ]);
  assert.equal(options.serverName, "netlify");
  assert.equal(options.callbackPort, 8765);
  assert.equal(options.timeoutMs, 30_000);
  assert.throws(
    () => parseMcpBridgeAuthCommand([
      "--codex-config", "config.toml",
      "--state-dir", "state",
      "--server", "netlify",
      "--callback-port", "70000",
    ]),
    /callback-port/i,
  );
});
