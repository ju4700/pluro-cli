import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ConflictPolicy } from "../core/conflict-resolution";
import { ContextService } from "../core/context-service";
import { ConversationDiscoveryService } from "../core/conversation-discovery";
import { getPluroVersion } from "../core/version";

const addContextArgsSchema = z.object({
  content: z.string().min(1),
  sourceTool: z.string().min(1),
  scope: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  encrypt: z.boolean().optional(),
  parentId: z.string().uuid().optional()
});

const listContextArgsSchema = z.object({
  query: z.string().optional(),
  sourceTool: z.string().optional(),
  scope: z.string().optional(),
  tag: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().optional()
});

const snapshotExportArgsSchema = z.object({
  limit: z.number().int().min(1).max(5000).optional(),
  cursor: z.string().optional(),
  historyLimit: z.number().int().min(1).max(5000).optional()
});

const getContextArgsSchema = z.object({
  id: z.string().uuid()
});

const deleteContextArgsSchema = z.object({
  id: z.string().uuid()
});

const snapshotImportArgsSchema = z.object({
  snapshot: z.unknown(),
  policy: z.enum(["lww", "keep-both"]).optional()
});

const historyArgsSchema = z.object({
  entryId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(5000).optional()
});

const conversationScanArgsSchema = z.object({
  ide: z.enum(["cursor", "vscode-copilot", "antigravity"]),
  roots: z.array(z.string()).optional(),
  recursive: z.boolean().optional(),
  projectPath: z.string().optional(),
  maxFiles: z.number().int().min(1).max(20000).optional(),
  maxFileSizeBytes: z.number().int().min(1024).optional(),
  includeSessionLogs: z.boolean().optional()
});

const conversationListArgsSchema = z.object({
  ide: z.enum(["cursor", "vscode-copilot", "antigravity"]).optional(),
  projectPath: z.string().optional(),
  projectConfidence: z.enum(["high", "medium", "low"]).optional(),
  projectSource: z.string().optional(),
  limit: z.number().int().min(1).max(5000).optional()
});

const conversationInjectArgsSchema = z.object({
  conversationId: z.string().min(1),
  policy: z.enum(["lww", "keep-both"]).optional(),
  skipUnchanged: z.boolean().optional(),
  scope: z.string().optional(),
  tags: z.array(z.string()).optional(),
  projectPath: z.string().optional()
});

function toToolResult(payload: unknown) {
  const structuredContent = normalizeUnknownObject(payload);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent
  };
}

function toToolError(message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message
      }
    ]
  };
}

function normalizeUnknownObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "pluro_context_add",
    description: "Create a shared context entry in the local pluro store.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Context text" },
        sourceTool: { type: "string", description: "Source tool id" },
        scope: { type: "string", description: "Scope name" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Index tags"
        },
        metadata: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Metadata key value pairs"
        },
        encrypt: { type: "boolean", description: "Encrypt content at rest" },
        parentId: { type: "string", description: "Optional parent entry id" }
      },
      required: ["content", "sourceTool"]
    }
  },
  {
    name: "pluro_context_list",
    description: "List shared context entries with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        sourceTool: { type: "string" },
        scope: { type: "string" },
        tag: { type: "string" },
        limit: { type: "number" },
        cursor: { type: "string" }
      }
    }
  },
  {
    name: "pluro_context_get",
    description: "Get one context entry by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"]
    }
  },
  {
    name: "pluro_context_delete",
    description: "Delete one context entry by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"]
    }
  },
  {
    name: "pluro_snapshot_export",
    description: "Export context entries as a structured snapshot payload.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        cursor: { type: "string" },
        historyLimit: { type: "number" }
      }
    }
  },
  {
    name: "pluro_snapshot_import",
    description: "Import a snapshot payload into the local context store.",
    inputSchema: {
      type: "object",
      properties: {
        snapshot: { type: "object" },
        policy: { type: "string", enum: ["lww", "keep-both"] }
      },
      required: ["snapshot"]
    }
  },
  {
    name: "pluro_history_list",
    description: "List context history entries.",
    inputSchema: {
      type: "object",
      properties: {
        entryId: { type: "string" },
        limit: { type: "number" }
      }
    }
  },
  {
    name: "pluro_conversation_scan",
    description: "Scan local IDE roots and index discovered conversations.",
    inputSchema: {
      type: "object",
      properties: {
        ide: { type: "string", enum: ["cursor", "vscode-copilot", "antigravity"] },
        roots: {
          type: "array",
          items: { type: "string" }
        },
        recursive: { type: "boolean" },
        projectPath: { type: "string" },
        maxFiles: { type: "number" },
        maxFileSizeBytes: { type: "number" },
        includeSessionLogs: { type: "boolean" }
      },
      required: ["ide"]
    }
  },
  {
    name: "pluro_conversation_list",
    description: "List conversations discovered by previous scans.",
    inputSchema: {
      type: "object",
      properties: {
        ide: { type: "string", enum: ["cursor", "vscode-copilot", "antigravity"] },
        projectPath: { type: "string" },
        projectConfidence: { type: "string", enum: ["high", "medium", "low"] },
        projectSource: { type: "string" },
        limit: { type: "number" }
      }
    }
  },
  {
    name: "pluro_conversation_inject",
    description: "Inject one discovered conversation into the pluro store.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        policy: { type: "string", enum: ["lww", "keep-both"] },
        skipUnchanged: { type: "boolean" },
        scope: { type: "string" },
        tags: {
          type: "array",
          items: { type: "string" }
        },
        projectPath: { type: "string" }
      },
      required: ["conversationId"]
    }
  }
];

export async function runMcpStdioServer(service: ContextService): Promise<void> {
  const server = new Server(
    {
      name: "pluro-mcp",
      version: getPluroVersion()
    },
    {
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      instructions:
        "Use pluro tools to create, query, and synchronize local shared context between LLM tools."
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_DEFINITIONS
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = normalizeUnknownObject(request.params.arguments);

    try {
      if (toolName === "pluro_context_add") {
        const payload = addContextArgsSchema.parse(args);
        const entry = await service.addContext(payload);
        return toToolResult({ entry });
      }

      if (toolName === "pluro_context_list") {
        const payload = listContextArgsSchema.parse(args);
        const page = await service.listContextsPage(payload);
        return toToolResult({ entries: page.entries, count: page.entries.length, nextCursor: page.nextCursor });
      }

      if (toolName === "pluro_context_get") {
        const payload = getContextArgsSchema.parse(args);
        const entry = await service.getContext(payload.id);
        return toToolResult({ entry });
      }

      if (toolName === "pluro_context_delete") {
        const payload = deleteContextArgsSchema.parse(args);
        const deleted = await service.deleteContext(payload.id);
        return toToolResult({ deleted, id: payload.id });
      }

      if (toolName === "pluro_snapshot_export") {
        const payload = snapshotExportArgsSchema.parse(args);
        const snapshot = await service.exportSnapshot(payload);
        return toToolResult({ snapshot });
      }

      if (toolName === "pluro_snapshot_import") {
        const payload = snapshotImportArgsSchema.parse(args);
        const policy = (payload.policy ?? "lww") as ConflictPolicy;
        const result = await service.importSnapshot(payload.snapshot, policy);
        return toToolResult({ result });
      }

      if (toolName === "pluro_history_list") {
        const payload = historyArgsSchema.parse(args);
        const history = service.listHistory(payload.entryId, payload.limit ?? 100);
        return toToolResult({ history, count: history.length });
      }

      if (toolName === "pluro_conversation_scan") {
        const payload = conversationScanArgsSchema.parse(args);
        const discovery = new ConversationDiscoveryService(service);
        const result = await discovery.scan(payload);
        return toToolResult(result);
      }

      if (toolName === "pluro_conversation_list") {
        const payload = conversationListArgsSchema.parse(args);
        const discovery = new ConversationDiscoveryService(service);
        const conversations = discovery.list({
          ide: payload.ide,
          projectPath: payload.projectPath,
          projectConfidence: payload.projectConfidence,
          projectSource: payload.projectSource,
          limit: payload.limit ?? 200
        });
        return toToolResult({
          ide: payload.ide ?? "all",
          projectPath: payload.projectPath,
          projectConfidence: payload.projectConfidence ?? "all",
          projectSource: payload.projectSource ?? "all",
          conversations,
          total: conversations.length
        });
      }

      if (toolName === "pluro_conversation_inject") {
        const payload = conversationInjectArgsSchema.parse(args);
        const discovery = new ConversationDiscoveryService(service);
        const result = await discovery.injectConversation({
          conversationId: payload.conversationId,
          policy: payload.policy as ConflictPolicy | undefined,
          skipUnchanged: payload.skipUnchanged,
          scope: payload.scope,
          tags: payload.tags,
          projectPath: payload.projectPath
        });
        return toToolResult({ inject: result });
      }

      return toToolError(`Unknown tool: ${toolName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed";
      return toToolError(message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  await new Promise<void>((resolve) => {
    let closed = false;

    const closeOnce = async () => {
      if (closed) {
        return;
      }

      closed = true;
      await server.close();
      resolve();
    };

    transport.onclose = () => {
      void closeOnce();
    };

    transport.onerror = (error) => {
      const message = error instanceof Error ? error.message : "MCP transport error";
      process.stderr.write(`${message}\n`);
    };

    process.once("SIGINT", () => {
      void closeOnce();
    });

    process.once("SIGTERM", () => {
      void closeOnce();
    });
  });
}
