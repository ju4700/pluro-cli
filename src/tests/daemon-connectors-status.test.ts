import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { FileAdapterEngine } from "../adapters/file-sync";
import { ContextService } from "../core/context-service";
import { EncryptionService } from "../core/security/encryption";
import { SqliteStore } from "../core/storage/sqlite";
import { startDaemonServer } from "../daemon/server";

function withTempDir(handler: (tempDir: string) => Promise<void> | void): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pluro-daemon-it-"));

  return Promise.resolve()
    .then(() => handler(tempDir))
    .finally(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cliPath = path.join(process.cwd(), "dist", "cli", "index.js");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code) => {
      resolve({
        code,
        stdout,
        stderr
      });
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

test("daemon connectors status reports primary file-sync adapters", async () => {
  await withTempDir(async (dataDir) => {
    const engine = new FileAdapterEngine(dataDir);
    engine.createProfileTemplate("cursor-file");
    engine.createProfileTemplate("vscode-copilot-file");
    engine.createProfileTemplate("antigravity-file");

    const store = new SqliteStore(path.join(dataDir, "context.db"));
    const service = new ContextService(
      store,
      new EncryptionService({ passphrase: "daemon-test", disableKeychain: true })
    );

    service.init();

    const server = await startDaemonServer(service, {
      host: "127.0.0.1",
      port: 0,
      dataDir
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = (address as AddressInfo).port;

      const response = await fetch(
        `http://127.0.0.1:${port}/connectors/status?focus=primary&syncMode=file-sync`
      );

      assert.equal(response.status, 200);

      const payload = (await response.json()) as {
        summary: { total: number; healthy: number; warning: number; error: number };
        statuses: Array<{ expectedProfileId?: string; health: string }>;
      };

      assert.equal(payload.summary.total, 3);
      assert.equal(payload.summary.healthy, 3);
      assert.equal(payload.summary.warning, 0);
      assert.equal(payload.summary.error, 0);
      assert.ok(payload.statuses.every((status) => status.health === "healthy"));
      assert.ok(payload.statuses.some((status) => status.expectedProfileId === "cursor-file"));
      assert.ok(
        payload.statuses.some((status) => status.expectedProfileId === "vscode-copilot-file")
      );
      assert.ok(
        payload.statuses.some((status) => status.expectedProfileId === "antigravity-file")
      );
    } finally {
      await closeServer(server);
      service.close();
    }
  });
});

test("daemon connectors status supports compact mode for explicit adapter file", async () => {
  await withTempDir(async (dataDir) => {
    const engine = new FileAdapterEngine(dataDir);
    const template = engine.createProfileTemplate("cursor-file");

    const store = new SqliteStore(path.join(dataDir, "context.db"));
    const service = new ContextService(
      store,
      new EncryptionService({ passphrase: "daemon-test", disableKeychain: true })
    );

    service.init();

    const server = await startDaemonServer(service, {
      host: "127.0.0.1",
      port: 0,
      dataDir
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = (address as AddressInfo).port;

      const params = new URLSearchParams();
      params.set("adapterFile", template.adapterFile);
      params.set("compact", "1");

      const response = await fetch(`http://127.0.0.1:${port}/connectors/status?${params}`);
      assert.equal(response.status, 200);

      const payload = (await response.json()) as {
        compact: boolean;
        summary: { total: number; healthy: number };
        statuses: Array<{ health: string; issues: string[] }>;
      };

      assert.equal(payload.compact, true);
      assert.equal(payload.summary.total, 1);
      assert.equal(payload.summary.healthy, 1);
      assert.equal(payload.statuses[0]?.health, "healthy");
      assert.deepEqual(payload.statuses[0]?.issues, []);
    } finally {
      await closeServer(server);
      service.close();
    }
  });
});

test("daemon status command supports connector table output", async () => {
  await withTempDir(async (dataDir) => {
    const engine = new FileAdapterEngine(dataDir);
    engine.createProfileTemplate("cursor-file");
    engine.createProfileTemplate("vscode-copilot-file");
    engine.createProfileTemplate("antigravity-file");

    const store = new SqliteStore(path.join(dataDir, "context.db"));
    const service = new ContextService(
      store,
      new EncryptionService({ passphrase: "daemon-test", disableKeychain: true })
    );

    service.init();

    const server = await startDaemonServer(service, {
      host: "127.0.0.1",
      port: 0,
      dataDir
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = (address as AddressInfo).port;

      const result = await runCli([
        "daemon",
        "status",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--connectors",
        "--focus",
        "primary",
        "--sync-mode",
        "file-sync",
        "--format",
        "table"
      ]);

      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes("Connector Status (primary, sync=file-sync)"));
      assert.ok(result.stdout.includes("cursor-file"));
      assert.ok(result.stdout.includes("vscode-copilot-file"));
      assert.ok(result.stdout.includes("antigravity-file"));
    } finally {
      await closeServer(server);
      service.close();
    }
  });
});

test("daemon status command supports connector summary output", async () => {
  await withTempDir(async (dataDir) => {
    const engine = new FileAdapterEngine(dataDir);
    engine.createProfileTemplate("cursor-file");
    engine.createProfileTemplate("vscode-copilot-file");
    engine.createProfileTemplate("antigravity-file");

    const store = new SqliteStore(path.join(dataDir, "context.db"));
    const service = new ContextService(
      store,
      new EncryptionService({ passphrase: "daemon-test", disableKeychain: true })
    );

    service.init();

    const server = await startDaemonServer(service, {
      host: "127.0.0.1",
      port: 0,
      dataDir
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = (address as AddressInfo).port;

      const result = await runCli([
        "daemon",
        "status",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--connectors",
        "--focus",
        "primary",
        "--sync-mode",
        "file-sync",
        "--format",
        "summary"
      ]);

      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes("connector_status"));
      assert.ok(result.stdout.includes("focus=primary"));
      assert.ok(result.stdout.includes("sync=file-sync"));
      assert.ok(result.stdout.includes("total=3"));
      assert.ok(result.stdout.includes("overall=healthy"));
    } finally {
      await closeServer(server);
      service.close();
    }
  });
});

test("daemon status command supports daemon health summary output", async () => {
  await withTempDir(async (dataDir) => {
    const store = new SqliteStore(path.join(dataDir, "context.db"));
    const service = new ContextService(
      store,
      new EncryptionService({ passphrase: "daemon-test", disableKeychain: true })
    );

    service.init();

    const server = await startDaemonServer(service, {
      host: "127.0.0.1",
      port: 0,
      dataDir
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = (address as AddressInfo).port;

      const result = await runCli([
        "daemon",
        "status",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--format",
        "summary"
      ]);

      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes("daemon_health"));
      assert.ok(result.stdout.includes("status=ok"));
      assert.ok(result.stdout.includes("service=pluro-daemon"));
    } finally {
      await closeServer(server);
      service.close();
    }
  });
});

test("daemon status command fail-on-error returns non-zero for connector issues", async () => {
  await withTempDir(async (dataDir) => {
    const store = new SqliteStore(path.join(dataDir, "context.db"));
    const service = new ContextService(
      store,
      new EncryptionService({ passphrase: "daemon-test", disableKeychain: true })
    );

    service.init();

    const server = await startDaemonServer(service, {
      host: "127.0.0.1",
      port: 0,
      dataDir
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = (address as AddressInfo).port;

      const result = await runCli([
        "daemon",
        "status",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--connectors",
        "--focus",
        "primary",
        "--sync-mode",
        "file-sync",
        "--format",
        "summary",
        "--fail-on-error"
      ]);

      assert.equal(result.code, 1);
      assert.ok(result.stdout.includes("connector_status"));
      assert.ok(result.stdout.includes("overall=error"));
    } finally {
      await closeServer(server);
      service.close();
    }
  });
});
