import * as http from "node:http";
import * as path from "node:path";
import { URL } from "node:url";

import { FileAdapterEngine } from "../adapters/file-sync";
import {
  BUILTIN_ADAPTER_PROFILES,
  listPrimaryIdeProfiles,
  type AdapterSyncMode
} from "../adapters/profiles";
import type { ConflictPolicy } from "../core/conflict-resolution";
import { ContextService } from "../core/context-service";
import { ConversationDiscoveryService } from "../core/conversation-discovery";
import type {
  CreateContextInput,
  DiscoveredConversation,
  SearchContextFilters,
  SupportedIde,
  UpdateContextInput
} from "../core/types";
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from "./protocol";

export interface DaemonServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw) as unknown;
}

function getEntryId(pathname: string): string | null {
  if (!pathname.startsWith("/context/")) {
    return null;
  }

  const id = pathname.substring("/context/".length).trim();
  return id.length > 0 ? id : null;
}

function parseOptionalInt(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return parsed;
}

function parseFocus(value: string | null): "all" | "primary" {
  const normalized = (value ?? "primary").trim().toLowerCase();

  if (normalized === "all" || normalized === "primary") {
    return normalized;
  }

  throw new Error(`Invalid focus: ${value}. Expected all or primary.`);
}

function parseSyncMode(value: string | null): AdapterSyncMode | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }

  if (value === "file-sync" || value === "mcp") {
    return value;
  }

  throw new Error(`Invalid syncMode: ${value}. Expected file-sync or mcp.`);
}

function parseBooleanFlag(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseSupportedIde(value: string | null): SupportedIde {
  const normalized = (value ?? "").trim().toLowerCase();

  if (normalized === "cursor" || normalized === "vscode-copilot" || normalized === "antigravity") {
    return normalized;
  }

  throw new Error(`Invalid ide: ${value}. Expected cursor, vscode-copilot, or antigravity.`);
}

function parseProjectConfidence(value: string | null): "high" | "medium" | "low" | undefined {
  if (!value || value.trim() === "") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }

  throw new Error(`Invalid projectConfidence: ${value}. Expected high, medium, or low.`);
}

function toProjectConfidenceRank(value: "high" | "medium" | "low" | undefined): number {
  if (value === "high") {
    return 3;
  }

  if (value === "medium") {
    return 2;
  }

  return 1;
}

function filterDiscoveredConversationsByMinProjectConfidence(
  conversations: DiscoveredConversation[],
  minProjectConfidence: "high" | "medium" | "low" | undefined
): DiscoveredConversation[] {
  if (!minProjectConfidence || minProjectConfidence === "low") {
    return conversations;
  }

  const threshold = toProjectConfidenceRank(minProjectConfidence);

  return conversations.filter(
    (conversation) => toProjectConfidenceRank(conversation.projectConfidence) >= threshold
  );
}

export async function startDaemonServer(
  service: ContextService,
  options: DaemonServerOptions = {}
): Promise<http.Server> {
  const host = options.host ?? DEFAULT_DAEMON_HOST;
  const port = options.port ?? DEFAULT_DAEMON_PORT;
  const dataDir = options.dataDir;

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        sendJson(res, 400, { ok: false, error: "Malformed request" });
        return;
      }

      const url = new URL(req.url, `http://${host}:${port}`);
      const pathname = url.pathname;
      const method = req.method.toUpperCase();

      if (pathname === "/health" && method === "GET") {
        sendJson(res, 200, {
          ok: true,
          service: "pluro-daemon",
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (pathname === "/context" && method === "GET") {
        const filters: SearchContextFilters = {
          query: url.searchParams.get("query") ?? undefined,
          sourceTool: url.searchParams.get("source") ?? undefined,
          scope: url.searchParams.get("scope") ?? undefined,
          tag: url.searchParams.get("tag") ?? undefined,
          limit: parseOptionalInt(url.searchParams.get("limit")),
          cursor: url.searchParams.get("cursor") ?? undefined
        };

        const page = await service.listContextsPage(filters);
        sendJson(res, 200, { ok: true, entries: page.entries, nextCursor: page.nextCursor });
        return;
      }

      if (pathname === "/context" && method === "POST") {
        const body = (await readJsonBody(req)) as Partial<CreateContextInput>;

        if (!body || typeof body.content !== "string" || typeof body.sourceTool !== "string") {
          sendJson(res, 400, {
            ok: false,
            error: "content and sourceTool are required"
          });
          return;
        }

        const entry = await service.addContext({
          content: body.content,
          sourceTool: body.sourceTool,
          scope: body.scope,
          tags: body.tags,
          metadata: body.metadata,
          encrypt: body.encrypt,
          parentId: body.parentId
        });

        sendJson(res, 201, { ok: true, entry });
        return;
      }

      if (pathname === "/snapshot/export" && method === "GET") {
        const snapshot = await service.exportSnapshot({
          limit: parseOptionalInt(url.searchParams.get("limit")),
          cursor: url.searchParams.get("cursor") ?? undefined,
          historyLimit: parseOptionalInt(url.searchParams.get("historyLimit"))
        });

        sendJson(res, 200, { ok: true, snapshot });
        return;
      }

      if (pathname === "/snapshot/import" && method === "POST") {
        const body = (await readJsonBody(req)) as {
          snapshot?: unknown;
          policy?: ConflictPolicy;
        };

        if (!body || typeof body !== "object" || body.snapshot === undefined) {
          sendJson(res, 400, { ok: false, error: "snapshot is required" });
          return;
        }

        const result = await service.importSnapshot(body.snapshot, body.policy ?? "lww");
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (pathname === "/conversations" && method === "GET") {
        const ideRaw = url.searchParams.get("ide");
        const ide = ideRaw ? parseSupportedIde(ideRaw) : undefined;
        const projectPath = url.searchParams.get("projectPath") ?? undefined;
        const projectConfidence = parseProjectConfidence(url.searchParams.get("projectConfidence"));
        const projectSource = url.searchParams.get("projectSource") ?? undefined;
        const minProjectConfidence = parseProjectConfidence(
          url.searchParams.get("minProjectConfidence")
        );
        const limit = parseOptionalInt(url.searchParams.get("limit")) ?? 200;

        const discovery = new ConversationDiscoveryService(service);
        const conversations = discovery.list({
          ide,
          projectPath,
          projectConfidence,
          projectSource,
          minProjectConfidence,
          limit
        });

        sendJson(res, 200, {
          ok: true,
          ide: ide ?? "all",
          projectPath,
          projectConfidence: projectConfidence ?? "all",
          projectSource: projectSource ?? "all",
          minProjectConfidence: minProjectConfidence ?? "all",
          total: conversations.length,
          conversations
        });
        return;
      }

      if (pathname === "/conversations/scan" && method === "POST") {
        const body = (await readJsonBody(req)) as {
          ide?: string;
          roots?: string[];
          recursive?: boolean;
          projectPath?: string;
          minProjectConfidence?: string;
          maxFiles?: number;
          maxFileSizeBytes?: number;
          includeSessionLogs?: boolean;
        };

        if (!body || typeof body.ide !== "string") {
          sendJson(res, 400, { ok: false, error: "ide is required" });
          return;
        }

        const discovery = new ConversationDiscoveryService(service);
        const minProjectConfidence = parseProjectConfidence(body.minProjectConfidence ?? null);
        const result = await discovery.scan({
          ide: parseSupportedIde(body.ide),
          roots: Array.isArray(body.roots)
            ? body.roots.filter((root) => typeof root === "string" && root.trim().length > 0)
            : undefined,
          recursive: body.recursive !== false,
          projectPath: body.projectPath,
          maxFiles: body.maxFiles,
          maxFileSizeBytes: body.maxFileSizeBytes,
          includeSessionLogs: body.includeSessionLogs !== false
        });

        const filteredConversations = filterDiscoveredConversationsByMinProjectConfidence(
          result.conversations,
          minProjectConfidence
        );

        if (minProjectConfidence) {
          sendJson(res, 200, {
            ok: true,
            ...result,
            minProjectConfidence,
            indexedDiscovered: result.discovered,
            discovered: filteredConversations.length,
            conversations: filteredConversations
          });
          return;
        }

        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (pathname === "/conversations/inject" && method === "POST") {
        const body = (await readJsonBody(req)) as {
          conversationId?: string;
          policy?: ConflictPolicy;
          skipUnchanged?: boolean;
          scope?: string;
          tags?: string[];
          projectPath?: string;
        };

        if (!body || typeof body.conversationId !== "string") {
          sendJson(res, 400, { ok: false, error: "conversationId is required" });
          return;
        }

        if (body.policy && body.policy !== "lww" && body.policy !== "keep-both") {
          sendJson(res, 400, { ok: false, error: `Invalid conflict policy: ${body.policy}` });
          return;
        }

        const discovery = new ConversationDiscoveryService(service);
        const result = await discovery.injectConversation({
          conversationId: body.conversationId,
          policy: body.policy,
          skipUnchanged: body.skipUnchanged !== false,
          scope: body.scope,
          tags: body.tags,
          projectPath: body.projectPath
        });

        sendJson(res, 200, { ok: true, inject: result });
        return;
      }

      if (pathname === "/connectors/status" && method === "GET") {
        const syncMode = parseSyncMode(url.searchParams.get("syncMode"));
        const compact = parseBooleanFlag(url.searchParams.get("compact"));
        const requestedAdapterFiles = url.searchParams
          .getAll("adapterFile")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);

        const effectiveDataDir = dataDir ?? process.cwd();
        const engine = new FileAdapterEngine(effectiveDataDir);

        const statuses =
          requestedAdapterFiles.length > 0
            ? requestedAdapterFiles.map((adapterFile) => ({
                expectedProfileId: undefined,
                expectedProfileName: undefined,
                expectedTool: undefined,
                expectedSyncMode: undefined,
                ...engine.getAdapterStatus(path.resolve(adapterFile))
              }))
            : (parseFocus(url.searchParams.get("focus")) === "primary"
                ? listPrimaryIdeProfiles(syncMode)
                : BUILTIN_ADAPTER_PROFILES.filter(
                    (profile) => !syncMode || profile.syncMode === syncMode
                  )
              ).map((profile) => ({
                expectedProfileId: profile.id,
                expectedProfileName: profile.name,
                expectedTool: profile.tool,
                expectedSyncMode: profile.syncMode,
                ...engine.getAdapterStatus(
                  path.join(effectiveDataDir, profile.suggestedPath, "pluro.adapter.json")
                )
              }));

        const summary = {
          total: statuses.length,
          healthy: statuses.filter((status) => status.health === "healthy").length,
          warning: statuses.filter((status) => status.health === "warning").length,
          error: statuses.filter((status) => status.health === "error").length
        };

        const payload = {
          ok: true,
          outputDir: effectiveDataDir,
          syncMode: syncMode ?? "all",
          compact,
          checkedAt: new Date().toISOString(),
          summary,
          statuses: compact
            ? statuses.map((status) => ({
                adapterFile: status.adapterFile,
                profileId: status.profileId,
                expectedProfileId: status.expectedProfileId,
                tool: status.tool,
                syncMode: status.syncMode,
                health: status.health,
                issues: [...status.errors, ...status.warnings],
                checkedAt: status.checkedAt
              }))
            : statuses
        };

        sendJson(res, 200, payload);
        return;
      }

      if (pathname === "/history" && method === "GET") {
        const entryId = url.searchParams.get("entryId") ?? undefined;
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 100;
        const history = service.listHistory(entryId, limit);
        sendJson(res, 200, { ok: true, history });
        return;
      }

      const entryId = getEntryId(pathname);
      if (entryId && method === "GET") {
        const entry = await service.getContext(entryId);
        if (!entry) {
          sendJson(res, 404, { ok: false, error: "Context entry not found" });
          return;
        }

        sendJson(res, 200, { ok: true, entry });
        return;
      }

      if (entryId && method === "PATCH") {
        const body = (await readJsonBody(req)) as UpdateContextInput;
        const updated = await service.updateContext(entryId, body);
        if (!updated) {
          sendJson(res, 404, { ok: false, error: "Context entry not found" });
          return;
        }

        sendJson(res, 200, { ok: true, entry: updated });
        return;
      }

      if (entryId && method === "DELETE") {
        const deleted = await service.deleteContext(entryId);
        if (!deleted) {
          sendJson(res, 404, { ok: false, error: "Context entry not found" });
          return;
        }

        sendJson(res, 200, { ok: true, deleted: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown daemon error";
      sendJson(res, 500, { ok: false, error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  return server;
}
