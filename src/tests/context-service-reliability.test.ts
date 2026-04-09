import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { ContextService } from "../core/context-service";
import { EncryptionService } from "../core/security/encryption";
import { SqliteStore } from "../core/storage/sqlite";
import type { ContextSnapshot, HistoryEntry } from "../core/types";

class FailingHistoryStore extends SqliteStore {
  private appendCount = 0;

  appendHistory(entry: HistoryEntry): void {
    this.appendCount += 1;

    if (this.appendCount === 2) {
      throw new Error("Simulated history write failure");
    }

    super.appendHistory(entry);
  }
}

function withTempDir(handler: (tempDir: string) => Promise<void> | void): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pluro-core-it-"));

  return Promise.resolve()
    .then(() => handler(tempDir))
    .finally(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function buildSnapshot(contents: string[]): ContextSnapshot {
  const baseTime = Date.now();

  return {
    version: 1,
    exportedAt: new Date(baseTime).toISOString(),
    entries: contents.map((content, index) => {
      const timestamp = new Date(baseTime + index * 1000).toISOString();

      return {
        id: randomUUID(),
        content,
        encrypted: false,
        sourceTool: "snapshot-test",
        scope: "global",
        tags: ["snapshot"],
        metadata: { batch: "reliability" },
        version: 1,
        parentId: null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
    }),
    history: []
  };
}

test("snapshot import is atomic when a history write fails", async () => {
  await withTempDir(async (tempDir) => {
    const dbPath = path.join(tempDir, "context.db");
    const store = new FailingHistoryStore(dbPath);
    const service = new ContextService(
      store,
      new EncryptionService({ passphrase: "test-passphrase", disableKeychain: true })
    );

    service.init();

    try {
      const snapshot = buildSnapshot(["first", "second"]);

      await assert.rejects(
        async () => service.importSnapshot(snapshot, "lww"),
        /Simulated history write failure/
      );

      const entries = await service.listContexts({ limit: 10 });
      const history = service.listHistory(undefined, 10);

      assert.equal(entries.length, 0);
      assert.equal(history.length, 0);
    } finally {
      service.close();
    }
  });
});

test("snapshot export supports cursor pagination", async () => {
  await withTempDir(async (tempDir) => {
    const dbPath = path.join(tempDir, "context.db");
    const store = new SqliteStore(dbPath);
    const service = new ContextService(
      store,
      new EncryptionService({ passphrase: "test-passphrase", disableKeychain: true })
    );

    service.init();

    try {
      await service.addContext({ content: "entry one", sourceTool: "test" });
      await service.addContext({ content: "entry two", sourceTool: "test" });
      await service.addContext({ content: "entry three", sourceTool: "test" });

      const firstPage = await service.exportSnapshot({ limit: 2, historyLimit: 100 });
      assert.equal(firstPage.entries.length, 2);
      assert.ok(firstPage.nextCursor);

      const secondPage = await service.exportSnapshot({
        limit: 2,
        cursor: firstPage.nextCursor,
        historyLimit: 100
      });

      assert.equal(secondPage.entries.length, 1);
      assert.equal(secondPage.nextCursor, undefined);

      const ids = new Set([...firstPage.entries, ...secondPage.entries].map((entry) => entry.id));
      assert.equal(ids.size, 3);
    } finally {
      service.close();
    }
  });
});