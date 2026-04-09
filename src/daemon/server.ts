import * as http from "node:http";
import { URL } from "node:url";

import type { ConflictPolicy } from "../core/conflict-resolution";
import { ContextService } from "../core/context-service";
import type { CreateContextInput, SearchContextFilters, UpdateContextInput } from "../core/types";
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from "./protocol";

export interface DaemonServerOptions {
  host?: string;
  port?: number;
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

export async function startDaemonServer(
  service: ContextService,
  options: DaemonServerOptions = {}
): Promise<http.Server> {
  const host = options.host ?? DEFAULT_DAEMON_HOST;
  const port = options.port ?? DEFAULT_DAEMON_PORT;

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
        const limitRaw = url.searchParams.get("limit");
        const filters: SearchContextFilters = {
          query: url.searchParams.get("query") ?? undefined,
          sourceTool: url.searchParams.get("source") ?? undefined,
          scope: url.searchParams.get("scope") ?? undefined,
          tag: url.searchParams.get("tag") ?? undefined,
          limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined
        };

        const entries = await service.listContexts(filters);
        sendJson(res, 200, { ok: true, entries });
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
        const snapshot = await service.exportSnapshot();
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
