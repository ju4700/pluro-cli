import assert from "node:assert/strict";
import type * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { ContextService } from "../core/context-service";
import { EncryptionService } from "../core/security/encryption";
import { SqliteStore } from "../core/storage/sqlite";
import { startDaemonServer } from "../daemon/server";

function withTempDir(handler: (tempDir: string) => Promise<void> | void): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pluro-daemon-convo-it-"));

  return Promise.resolve()
    .then(() => handler(tempDir))
    .finally(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
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
    title: "Daemon Conversation Fixture",
    ...(includeProjectPath ? { projectPath: path.join(rootDir, "project-daemon") } : {}),
    messages: [
      {
        role: "user",
        content: "show me daemon scan"
      },
      {
        role: "assistant",
        content: "daemon scan result ready"
      }
    ]
  };

  fs.writeFileSync(path.join(rootDir, "daemon-conversation.json"), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
}

test("daemon conversations scan/list/inject workflow", async () => {
  await withTempDir(async (dataDir) => {
    const scanRoot = path.join(dataDir, "scan-root");
    writeConversationFixture(scanRoot);

    const store = new SqliteStore(path.join(dataDir, "context.db"));
    const service = new ContextService(
      store,
      new EncryptionService({ passphrase: "daemon-convo-test", disableKeychain: true })
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

      const scanResponse = await fetch(`http://127.0.0.1:${port}/conversations/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ide: "cursor",
          roots: [scanRoot]
        })
      });

      assert.equal(scanResponse.status, 200);

      const scanPayload = (await scanResponse.json()) as {
        discovered: number;
      };

      assert.equal(scanPayload.discovered, 1);

      const listResponse = await fetch(`http://127.0.0.1:${port}/conversations?ide=cursor`);
      assert.equal(listResponse.status, 200);

      const listPayload = (await listResponse.json()) as {
        conversations: Array<{ id: string }>;
      };

      const conversationId = listPayload.conversations[0]?.id;
      assert.ok(conversationId);

      const injectResponse = await fetch(`http://127.0.0.1:${port}/conversations/inject`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          conversationId,
          policy: "keep-both"
        })
      });

      assert.equal(injectResponse.status, 200);

      const injectPayload = (await injectResponse.json()) as {
        inject: {
          skipped: boolean;
          result?: { imported: number };
        };
      };

      assert.equal(injectPayload.inject.skipped, false);
      assert.ok((injectPayload.inject.result?.imported ?? 0) >= 1);

      const secondInjectResponse = await fetch(`http://127.0.0.1:${port}/conversations/inject`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          conversationId,
          policy: "keep-both"
        })
      });

      assert.equal(secondInjectResponse.status, 200);

      const secondInjectPayload = (await secondInjectResponse.json()) as {
        inject: {
          skipped: boolean;
          reason?: string;
        };
      };

      assert.equal(secondInjectPayload.inject.skipped, true);
      assert.equal(secondInjectPayload.inject.reason, "unchanged");
    } finally {
      await closeServer(server);
      service.close();
    }
  });
});

test("daemon conversations list supports min project confidence filtering", async () => {
  await withTempDir(async (dataDir) => {
    const scanRoot = path.join(dataDir, "Code");
    const highRoot = path.join(scanRoot, "project-high");
    const lowRoot = path.join(scanRoot, "User", "workspaceStorage", "workspace-123");

    writeConversationFixture(highRoot);
    writeConversationFixture(lowRoot, { includeProjectPath: false });

    const store = new SqliteStore(path.join(dataDir, "context.db"));
    const service = new ContextService(
      store,
      new EncryptionService({ passphrase: "daemon-convo-test", disableKeychain: true })
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

      const scanResponse = await fetch(`http://127.0.0.1:${port}/conversations/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ide: "vscode-copilot",
          roots: [scanRoot]
        })
      });

      assert.equal(scanResponse.status, 200);

      const listAllResponse = await fetch(
        `http://127.0.0.1:${port}/conversations?ide=vscode-copilot`
      );
      assert.equal(listAllResponse.status, 200);

      const listAllPayload = (await listAllResponse.json()) as {
        total: number;
      };

      assert.equal(listAllPayload.total, 2);

      const listFilteredResponse = await fetch(
        `http://127.0.0.1:${port}/conversations?ide=vscode-copilot&minProjectConfidence=high`
      );
      assert.equal(listFilteredResponse.status, 200);

      const listFilteredPayload = (await listFilteredResponse.json()) as {
        minProjectConfidence: string;
        total: number;
        conversations: Array<{ projectConfidence?: string }>;
      };

      assert.equal(listFilteredPayload.minProjectConfidence, "high");
      assert.equal(listFilteredPayload.total, 1);
      assert.equal(listFilteredPayload.conversations[0]?.projectConfidence, "high");
    } finally {
      await closeServer(server);
      service.close();
    }
  });
});
