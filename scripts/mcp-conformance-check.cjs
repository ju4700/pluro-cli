#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function removeDirWithRetry(dirPath, attempts = 10, delayMs = 100) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : undefined;

      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") {
        throw error;
      }

      if (index === attempts - 1) {
        throw error;
      }

      await wait(delayMs);
    }
  }
}

function ensureBuildOutput() {
  const cliPath = path.resolve(__dirname, "..", "dist", "cli", "index.js");
  if (!fs.existsSync(cliPath)) {
    throw new Error(
      "Build output was not found at dist/cli/index.js. Run 'npm run build' before running conformance checks."
    );
  }

  return cliPath;
}

function createRpcClient(proc) {
  let nextId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";

  const pending = new Map();

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  proc.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;

    while (true) {
      const splitIndex = stdoutBuffer.indexOf("\n");
      if (splitIndex < 0) {
        break;
      }

      const line = stdoutBuffer.slice(0, splitIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(splitIndex + 1);

      if (!line) {
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(line);
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

  proc.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
  });

  proc.on("exit", (code, signal) => {
    const message = `MCP process exited unexpectedly. code=${code ?? "null"} signal=${signal ?? "null"}`;

    for (const ticket of pending.values()) {
      clearTimeout(ticket.timeout);
      ticket.reject(new Error(message));
    }

    pending.clear();
  });

  async function request(method, params, timeoutMs = 7000) {
    const id = nextId;
    nextId += 1;

    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response to '${method}'.`));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timeout });
    });

    proc.stdin.write(`${JSON.stringify(payload)}\n`);

    const response = await responsePromise;
    if (response.error) {
      throw new Error(
        `RPC error for '${method}': ${response.error.message} (code=${response.error.code})`
      );
    }

    return response.result ?? {};
  }

  function notify(method, params) {
    const payload = {
      jsonrpc: "2.0",
      method,
      params
    };

    proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async function stop() {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      return;
    }

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // noop
        }

        resolve();
      }, 3000);

      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        proc.kill("SIGTERM");
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  return {
    request,
    notify,
    stop,
    getStderr: () => stderrBuffer
  };
}

async function run() {
  const cliPath = ensureBuildOutput();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pluro-mcp-conformance-"));

  const proc = spawn(
    process.execPath,
    [cliPath, "--data-dir", dataDir, "--disable-keychain", "daemon", "mcp"],
    {
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  const rpc = createRpcClient(proc);

  const log = (line) => {
    process.stdout.write(`${line}\n`);
  };

  try {
    log("[check] initialize handshake");
    const initialize = await rpc.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: "pluro-conformance",
        version: "0.1.0"
      }
    });

    assert.equal(initialize.serverInfo?.name, "pluro-mcp");
    assert.equal(typeof initialize.protocolVersion, "string");

    rpc.notify("notifications/initialized");

    log("[check] tools/list");
    const tools = await rpc.request("tools/list", {});
    const toolNames = (tools.tools ?? []).map((tool) => tool.name);

    assert.ok(toolNames.includes("pluro_context_add"));
    assert.ok(toolNames.includes("pluro_context_list"));
    assert.ok(toolNames.includes("pluro_snapshot_export"));

    log("[check] tools/call pluro_context_add");
    const marker = `conformance-${Date.now()}`;
    const addResult = await rpc.request("tools/call", {
      name: "pluro_context_add",
      arguments: {
        content: marker,
        sourceTool: "mcp-conformance"
      }
    });

    assert.equal(addResult.structuredContent?.entry?.content, marker);

    log("[check] tools/call pluro_context_list");
    const listResult = await rpc.request("tools/call", {
      name: "pluro_context_list",
      arguments: {
        query: marker,
        limit: 5
      }
    });

    const entries = listResult.structuredContent?.entries ?? [];
    assert.ok(entries.some((entry) => entry.content === marker));

    log("[check] tools/call pluro_snapshot_export");
    const exportResult = await rpc.request("tools/call", {
      name: "pluro_snapshot_export",
      arguments: {}
    });

    assert.equal(exportResult.structuredContent?.snapshot?.version, 1);

    log("[ok] MCP conformance checks passed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[error] ${message}\n`);

    const stderr = rpc.getStderr().trim();
    if (stderr) {
      process.stderr.write(`[mcp-stderr]\n${stderr}\n`);
    }

    process.exitCode = 1;
  } finally {
    await rpc.stop();
    await removeDirWithRetry(dataDir);
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[fatal] ${message}\n`);
  process.exitCode = 1;
});
