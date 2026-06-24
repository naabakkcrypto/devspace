import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";

const ownerToken = "test-owner-token-that-is-long-enough";
const redirectUri = "https://chatgpt.com/callback";
const resourceUrl = new URL("http://127.0.0.1:7676/mcp");
const resourceAlias = new URL(
  "https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_6a31f9e922488191a2981cd562acd892",
);
const root = await mkdtemp(join(tmpdir(), "devspace-oauth-provider-test-"));
const providers: SingleUserOAuthProvider[] = [];
let providerIndex = 0;

function createProvider(resourceAliases: string[] = []): SingleUserOAuthProvider {
  const provider = new SingleUserOAuthProvider(
    {
      ownerToken,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2592000,
      scopes: ["devspace"],
      allowedRedirectHosts: ["chatgpt.com"],
      resourceAliases,
    },
    resourceUrl,
    join(root, `provider-${providerIndex++}`),
  );
  providers.push(provider);
  return provider;
}

async function registerClient(provider: SingleUserOAuthProvider): Promise<OAuthClientInformationFull> {
  assert.ok(provider.clientsStore.registerClient);

  return await provider.clientsStore.registerClient({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

function fakeResponse(method: "GET" | "POST", body: Record<string, string> = {}) {
  const state: {
    statusCode?: number;
    headers: Record<string, string | number | readonly string[]>;
    body?: string;
    location?: string;
  } = {
    headers: {},
  };

  let response: Response;
  response = {
    req: { method, body },
    status(code: number) {
      state.statusCode = code;
      return response;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      state.headers[name] = value;
      return response;
    },
    send(bodyValue: unknown) {
      state.body = String(bodyValue);
      return response;
    },
    redirect(code: number, location: string) {
      state.statusCode = code;
      state.location = location;
      return response;
    },
  } as unknown as Response;

  return { response, state };
}

try {
  await run();
} finally {
  for (const provider of providers) {
    provider.close();
  }
  await rm(root, { recursive: true, force: true });
}

async function run(): Promise<void> {
  const provider = createProvider();
  const client = await registerClient(provider);
  const params = {
    scopes: ["devspace"],
    redirectUri,
    codeChallenge: "challenge",
    state: "state-1",
  };

  const form = fakeResponse("GET");
  await provider.authorize(client, params, form.response);
  assert.equal(form.state.statusCode, 200);
  assert.match(form.state.body ?? "", /Connect DevSpace/);
  assert.match(form.state.body ?? "", /http:\/\/127\.0\.0\.1:7676\/mcp/);

  const approval = fakeResponse("POST", { owner_token: ownerToken });
  await provider.authorize(client, params, approval.response);
  assert.equal(approval.state.statusCode, 302);
  assert.ok(approval.state.location);

  const code = new URL(approval.state.location).searchParams.get("code");
  assert.ok(code);

  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, redirectUri);
  assert.equal(tokens.token_type, "bearer");

  const authInfo = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(authInfo.resource?.href, resourceUrl.href);

  await assert.rejects(
    () =>
      provider.authorize(
        client,
        {
          ...params,
          resource: new URL("http://127.0.0.1:9999/mcp"),
        },
        fakeResponse("GET").response,
      ),
    InvalidRequestError,
  );

  const aliasProvider = createProvider([resourceAlias.href]);
  const aliasClient = await registerClient(aliasProvider);
  const aliasApproval = fakeResponse("POST", { owner_token: ownerToken });
  await aliasProvider.authorize(
    aliasClient,
    {
      ...params,
      resource: resourceAlias,
    },
    aliasApproval.response,
  );
  assert.equal(aliasApproval.state.statusCode, 302);

  const aliasCode = new URL(aliasApproval.state.location ?? "").searchParams.get("code");
  assert.ok(aliasCode);

  const aliasTokens = await aliasProvider.exchangeAuthorizationCode(
    aliasClient,
    aliasCode,
    undefined,
    redirectUri,
    resourceAlias,
  );
  const aliasAuthInfo = await aliasProvider.verifyAccessToken(aliasTokens.access_token);
  assert.equal(aliasAuthInfo.resource?.href, resourceUrl.href);
}
