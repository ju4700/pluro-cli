import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { FileAdapterEngine } from "../adapters/file-sync";
import type { ContextSnapshot } from "../core/types";

function withTempDir(handler: (tempDir: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pluro-convo-it-"));

  try {
    handler(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const cliPath = path.join(process.cwd(), "dist", "cli", "index.js");

  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8"
  });

  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function writeConversationFixture(rootDir: string): void {
  fs.mkdirSync(rootDir, { recursive: true });

  const fixture = {
    title: "Conversation Fixture",
    projectPath: path.join(rootDir, "project-a"),
    messages: [
      {
        role: "user",
        content: "Please summarize the migration plan"
      },
      {
        role: "assistant",
        content: "Migration plan includes schema upgrades and smoke checks"
      }
    ]
  };

  fs.writeFileSync(path.join(rootDir, "conversation.json"), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
}

test("conversation scan/list/inject supports idempotent re-import", () => {
  withTempDir((tempDir) => {
    const dataDir = path.join(tempDir, "pluro-data");
    const scanRoot = path.join(tempDir, "cursor-storage");

    writeConversationFixture(scanRoot);

    const scanResult = runCli([
      "--data-dir",
      dataDir,
      "conversation",
      "scan",
      "--ide",
      "cursor",
      "--root",
      scanRoot,
      "--format",
      "json"
    ]);

    assert.equal(scanResult.code, 0, scanResult.stderr);

    const scanPayload = JSON.parse(scanResult.stdout) as {
      discovered: number;
      conversations: Array<{ id: string }>;
    };

    assert.equal(scanPayload.discovered, 1);
    const conversationId = scanPayload.conversations[0]?.id;
    assert.ok(conversationId);

    const listResult = runCli([
      "--data-dir",
      dataDir,
      "conversation",
      "list",
      "--ide",
      "cursor",
      "--format",
      "json"
    ]);

    assert.equal(listResult.code, 0, listResult.stderr);

    const listPayload = JSON.parse(listResult.stdout) as {
      total: number;
      conversations: Array<{ id: string }>;
    };

    assert.equal(listPayload.total, 1);
    assert.equal(listPayload.conversations[0]?.id, conversationId);

    const firstInject = runCli([
      "--data-dir",
      dataDir,
      "conversation",
      "inject",
      conversationId,
      "--format",
      "json"
    ]);

    assert.equal(firstInject.code, 0, firstInject.stderr);

    const firstInjectPayload = JSON.parse(firstInject.stdout) as {
      inject: {
        skipped: boolean;
        result?: { imported: number; updated: number; duplicated: number };
      };
    };

    assert.equal(firstInjectPayload.inject.skipped, false);
    assert.ok((firstInjectPayload.inject.result?.imported ?? 0) >= 1);

    const secondInject = runCli([
      "--data-dir",
      dataDir,
      "conversation",
      "inject",
      conversationId,
      "--format",
      "json"
    ]);

    assert.equal(secondInject.code, 0, secondInject.stderr);

    const secondInjectPayload = JSON.parse(secondInject.stdout) as {
      inject: { skipped: boolean; reason?: string };
    };

    assert.equal(secondInjectPayload.inject.skipped, true);
    assert.equal(secondInjectPayload.inject.reason, "unchanged");
  });
});

test("conversation inject can export to target profile adapter", () => {
  withTempDir((tempDir) => {
    const dataDir = path.join(tempDir, "pluro-data");
    const scanRoot = path.join(tempDir, "vscode-storage");

    writeConversationFixture(scanRoot);

    const engine = new FileAdapterEngine(dataDir);
    const template = engine.createProfileTemplate("vscode-copilot-file");
    const adapterConfig = engine.readAdapterConfig(template.adapterFile);
    const outboundFile = adapterConfig.outboundSnapshotFile as string;

    const scanResult = runCli([
      "--data-dir",
      dataDir,
      "conversation",
      "scan",
      "--ide",
      "vscode-copilot",
      "--root",
      scanRoot,
      "--format",
      "json"
    ]);

    assert.equal(scanResult.code, 0, scanResult.stderr);
    const scanPayload = JSON.parse(scanResult.stdout) as {
      conversations: Array<{ id: string }>;
    };

    const conversationId = scanPayload.conversations[0]?.id;
    assert.ok(conversationId);

    const injectResult = runCli([
      "--data-dir",
      dataDir,
      "conversation",
      "inject",
      conversationId,
      "--target-profile",
      "vscode-copilot-file",
      "--format",
      "json"
    ]);

    assert.equal(injectResult.code, 0, injectResult.stderr);

    const injectPayload = JSON.parse(injectResult.stdout) as {
      exportResult?: {
        export?: {
          file: string;
          entries: number;
        };
      };
    };

    assert.equal(injectPayload.exportResult?.export?.file, outboundFile);
    assert.ok((injectPayload.exportResult?.export?.entries ?? 0) >= 1);

    const exportedSnapshot = engine.readSnapshot(outboundFile) as ContextSnapshot;
    assert.ok(exportedSnapshot.entries.length >= 1);
  });
});

test("conversation inject supports --select when conversationId is omitted", () => {
  withTempDir((tempDir) => {
    const dataDir = path.join(tempDir, "pluro-data");
    const scanRoot = path.join(tempDir, "cursor-storage");

    writeConversationFixture(scanRoot);

    const scanResult = runCli([
      "--data-dir",
      dataDir,
      "conversation",
      "scan",
      "--ide",
      "cursor",
      "--root",
      scanRoot,
      "--format",
      "json"
    ]);

    assert.equal(scanResult.code, 0, scanResult.stderr);

    const injectResult = runCli([
      "--data-dir",
      dataDir,
      "conversation",
      "inject",
      "--ide",
      "cursor",
      "--select",
      "1",
      "--format",
      "json"
    ]);

    assert.equal(injectResult.code, 0, injectResult.stderr);

    const injectPayload = JSON.parse(injectResult.stdout) as {
      inject: {
        skipped: boolean;
        result?: { imported: number };
      };
    };

    assert.equal(injectPayload.inject.skipped, false);
    assert.ok((injectPayload.inject.result?.imported ?? 0) >= 1);
  });
});

test("conversation inject without id in non-interactive mode suggests --select", () => {
  withTempDir((tempDir) => {
    const dataDir = path.join(tempDir, "pluro-data");
    const scanRoot = path.join(tempDir, "cursor-storage");

    writeConversationFixture(scanRoot);

    const scanResult = runCli([
      "--data-dir",
      dataDir,
      "conversation",
      "scan",
      "--ide",
      "cursor",
      "--root",
      scanRoot,
      "--format",
      "json"
    ]);

    assert.equal(scanResult.code, 0, scanResult.stderr);

    const injectResult = runCli([
      "--data-dir",
      dataDir,
      "conversation",
      "inject",
      "--ide",
      "cursor",
      "--format",
      "summary"
    ]);

    assert.equal(injectResult.code, 1);
    assert.ok(injectResult.stderr.includes("--select <number>"));
  });
});
