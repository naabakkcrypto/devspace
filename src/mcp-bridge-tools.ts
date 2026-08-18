import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  bridgeToolInputSchema,
  bridgedToolName,
  resolveMcpBridgeTenant,
  type McpBridgeCatalog,
  type McpBridgeManager,
} from "./mcp-bridge.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export interface McpBridgeToolRuntime {
  catalog: McpBridgeCatalog;
  manager: McpBridgeManager;
  tenantResolverPath: string;
}

export function registerMcpBridgeTools(
  server: McpServer,
  workspaces: WorkspaceRegistry,
  runtime: McpBridgeToolRuntime,
): void {
  for (const upstreamServer of runtime.catalog.servers) {
    for (const tool of upstreamServer.tools) {
      server.registerTool(
        bridgedToolName(upstreamServer.name, tool.name),
        {
          title: tool.title ?? `${upstreamServer.name}: ${tool.name}`,
          description: `[Codex MCP route: ${upstreamServer.name}] ${tool.description ?? tool.name}`,
          inputSchema: bridgeToolInputSchema(tool.inputSchema),
          ...(tool.annotations ? { annotations: tool.annotations as ToolAnnotations } : {}),
        },
        async (rawInput) => {
          const input = rawInput as Record<string, unknown>;
          const workspaceId = input.workspaceId;
          if (typeof workspaceId !== "string" || !workspaceId) {
            throw new Error("MCP bridge workspaceId is required");
          }
          const workspace = await workspaces.verifyWorkspaceContext(workspaceId);
          const argumentsValue = { ...input };
          delete argumentsValue.workspaceId;
          const tenant = upstreamServer.name === "openmemory"
            ? await resolveMcpBridgeTenant(runtime.tenantResolverPath, workspace.root)
            : undefined;
          const result = await runtime.manager.call({
            workspaceId,
            serverName: upstreamServer.name,
            toolName: tool.name,
            argumentsValue,
            scope: {
              workspaceRoot: workspace.root,
              projectId: tenant?.projectId,
              instanceId: tenant?.instanceId,
            },
          });
          if (!Array.isArray(result.content)) {
            throw new Error(`MCP bridge ${upstreamServer.name}.${tool.name} returned invalid content`);
          }
          return result as { content: Array<{ type: "text"; text: string }> };
        },
      );
    }
  }
}
