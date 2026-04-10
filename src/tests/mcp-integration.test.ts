import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

function withTempDir(handler: (tempDir: string) => Promise<void> | void): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pluro-mcp-it-"));

  return Promise.resolve()
    .then(() => handler(tempDir))
    .finally(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function writeConversationFixture(
  rootDir: string,
  options: {
    includeProjectPath?: boolean;
  } = {}
): void {
  fs.mkdirSync(rootDir, { recursive: true });

  const includeProjectPath = options.includeProjectPath !== false;
  const fixture: Record<string, unknown> = {
    title: "MCP Conversation Fixture",
    ...(includeProjectPath ? { projectPath: path.join(rootDir, "project-mcp") } : {}),
    messages: [
      {
        role: "user",
        content: "show me mcp scan"
      },
      {
        role: "assistant",
        content: "mcp scan result ready"
      }
    ]
  };

  fs.writeFileSync(path.join(rootDir, "mcp-conversation.json"), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
}

function startMcpProcess(dataDir: string): ChildProcessWithoutNullStreams {
  const cliPath = path.join(process.cwd(), "dist", "cli", "index.js");
  return spawn(process.execPath, [cliPath, "--data-dir", dataDir, "daemon", "mcp"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function createRpcClient(proc: ChildProcessWithoutNullStreams) {
  let nextId = 1;
  let buffer = "";
  let stderr = "";

  const pending = new Map<
    JsonRpcId,
    {
      resolve: (message: JsonRpcResponse) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  proc.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  proc.stdout.on("data", (chunk: string) => {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      let parsed: JsonRpcResponse;

      try {
        parsed = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }

      if (parsed.id === undefined || parsed.id === null) {
        continue;
      }

      const ticket = pending.get(parsed.id);
      if (!ticket) {
        continue;
      }

      clearTimeout(ticket.timeout);
      pending.delete(parsed.id);
      ticket.resolve(parsed);
    }
  });

  proc.on("exit", (code, signal) => {
    const err = new Error(
      `MCP process exited before response. code=${code ?? "null"} signal=${signal ?? "null"} stderr=${stderr}`
    );

    for (const ticket of pending.values()) {
      clearTimeout(ticket.timeout);
      ticket.reject(err);
    }

    pending.clear();
  });

  const request = async <T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 7000
  ): Promise<T> => {
    const id = nextId;
    nextId += 1;

    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response to '${method}'`));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timeout });
    });

    proc.stdin.write(`${JSON.stringify(payload)}\n`);

    const response = await responsePromise;

    if (response.error) {
      throw new Error(
        `RPC error for ${method}: ${response.error.message} (code=${response.error.code})`
      );
    }

    return (response.result ?? {}) as T;
  };

  const notify = (method: string, params?: Record<string, unknown>): void => {
    const payload: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params
    };

    proc.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const stop = async (): Promise<void> => {
    if (proc.killed) {
      return;
    }

    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.kill("SIGTERM");

      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 1000);
    });
  };

  return {
    request,
    notify,
    stop,
    getStderr: () => stderr
  };
}

test("MCP stdio supports initialize, tools/list, and tools/call", async () => {
  await withTempDir(async (dataDir) => {
    const proc = startMcpProcess(dataDir);
    const rpc = createRpcClient(proc);

    try {
      const initialize = await rpc.request<{
        protocolVersion: string;
        capabilities: Record<string, unknown>;
        serverInfo: { name: string; version: string };
      }>("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: {
          name: "pluro-test-client",
          version: "0.0.1"
        }
      });

      assert.equal(initialize.serverInfo.name, "pluro-mcp");
      assert.equal(typeof initialize.protocolVersion, "string");

      rpc.notify("notifications/initialized");

      const toolsList = await rpc.request<{ tools: Array<{ name: string }> }>("tools/list", {});
      const names = toolsList.tools.map((tool) => tool.name);

      assert.ok(names.includes("pluro_context_add"));
      assert.ok(names.includes("pluro_context_list"));

      const addResult = await rpc.request<{
        structuredContent?: {
          entry?: {
            id: string;
            content: string;
            sourceTool: string;
          };
        };
      }>("tools/call", {
        name: "pluro_context_add",
        arguments: {
          content: "mcp integration context",
          sourceTool: "mcp-test"
        }
      });

      assert.equal(
        addResult.structuredContent?.entry?.content,
        "mcp integration context"
      );

      const listResult = await rpc.request<{
        structuredContent?: {
          count?: number;
          entries?: Array<{ content: string; sourceTool: string }>;
        };
      }>("tools/call", {
        name: "pluro_context_list",
        arguments: {
          query: "mcp integration context"
        }
      });

      assert.ok((listResult.structuredContent?.count ?? 0) >= 1);
      assert.ok(
        (listResult.structuredContent?.entries ?? []).some(
          (entry) => entry.sourceTool === "mcp-test"
        )
      );
    } finally {
      await rpc.stop();
    }
  });
});

test("MCP conversation scan supports min project confidence response filtering", async () => {
  await withTempDir(async (dataDir) => {
    const scanRoot = path.join(dataDir, "Code");
    const highRoot = path.join(scanRoot, "project-high");
    const lowRoot = path.join(scanRoot, "User", "workspaceStorage", "workspace-123");

    writeConversationFixture(highRoot);
    writeConversationFixture(lowRoot, { includeProjectPath: false });

    const proc = startMcpProcess(dataDir);
    const rpc = createRpcClient(proc);

    try {
      await rpc.request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: {
          name: "pluro-test-client",
          version: "0.0.1"
        }
      });

      rpc.notify("notifications/initialized");

      const scanResult = await rpc.request<{
        structuredContent?: {
          minProjectConfidence?: string;
          indexedDiscovered?: number;
          discovered?: number;
          conversations?: Array<{ projectConfidence?: string }>;
        };
      }>("tools/call", {
        name: "pluro_conversation_scan",
        arguments: {
          ide: "vscode-copilot",
          roots: [scanRoot],
          minProjectConfidence: "high"
        }
      });

      assert.equal(scanResult.structuredContent?.minProjectConfidence, "high");
      assert.equal(scanResult.structuredContent?.indexedDiscovered, 2);
      assert.equal(scanResult.structuredContent?.discovered, 1);
      assert.equal(scanResult.structuredContent?.conversations?.[0]?.projectConfidence, "high");

      const listResult = await rpc.request<{
        structuredContent?: {
          total?: number;
        };
      }>("tools/call", {
        name: "pluro_conversation_list",
        arguments: {
          ide: "vscode-copilot"
        }
      });

      assert.equal(listResult.structuredContent?.total, 2);
    } finally {
      await rpc.stop();
    }
  });
});
