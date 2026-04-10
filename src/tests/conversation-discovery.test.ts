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

function writeConversationFixture(
  rootDir: string,
  options: {
    includeProjectPath?: boolean;
    model?: string;
  } = {}
): void {
  fs.mkdirSync(rootDir, { recursive: true });

  const includeProjectPath = options.includeProjectPath !== false;
  const fixture: Record<string, unknown> = {
    title: "Conversation Fixture",
    ...(includeProjectPath ? { projectPath: path.join(rootDir, "project-a") } : {}),
    ...(options.model ? { model: options.model } : {}),
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

test("conversation scan assigns high confidence for explicit project metadata", () => {
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
      conversations: Array<{
        projectPath?: string;
        projectConfidence?: string;
        projectSource?: string;
        projectGroup?: string;
      }>;
    };

    const conversation = scanPayload.conversations[0];
    assert.ok(conversation?.projectPath);
    assert.equal(conversation?.projectConfidence, "high");
    assert.equal(conversation?.projectSource, "metadata");
    assert.equal(conversation?.projectGroup, conversation?.projectPath);
  });
});

test("conversation scan derives workspace metadata and fallback group", () => {
  withTempDir((tempDir) => {
    const dataDir = path.join(tempDir, "pluro-data");
    const scanRoot = path.join(tempDir, "Code");
    const storageRoot = path.join(scanRoot, "User", "workspaceStorage", "workspace-123");

    writeConversationFixture(storageRoot, {
      includeProjectPath: false,
      model: "gpt-4o-mini"
    });

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
      conversations: Array<{
        projectPath?: string;
        projectConfidence?: string;
        projectSource?: string;
        projectGroup?: string;
        metadata: Record<string, string>;
      }>;
    };

    const conversation = scanPayload.conversations[0];
    assert.equal(conversation?.projectPath, undefined);
    assert.equal(conversation?.projectConfidence, "low");
    assert.equal(conversation?.projectSource, "workspace-storage");
    assert.ok(conversation?.projectGroup?.includes("workspace-123"));
    assert.equal(conversation?.metadata.workspaceId, "workspace-123");
    assert.equal(conversation?.metadata.ideChannel, "stable");
    assert.equal(conversation?.metadata.model, "gpt-4o-mini");
    assert.ok((conversation?.metadata.roles ?? "").includes("user:1"));
    assert.ok((conversation?.metadata.roles ?? "").includes("assistant:1"));
  });
});

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

test("conversation list filters by project confidence and source", () => {
  withTempDir((tempDir) => {
    const dataDir = path.join(tempDir, "pluro-data");
    const scanRoot = path.join(tempDir, "Code");
    const highRoot = path.join(scanRoot, "project-high");
    const lowRoot = path.join(scanRoot, "User", "workspaceStorage", "workspace-123");

    writeConversationFixture(highRoot);
    writeConversationFixture(lowRoot, { includeProjectPath: false });

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

    const listHigh = runCli([
      "--data-dir",
      dataDir,
      "conversation",
      "list",
      "--ide",
      "vscode-copilot",
      "--project-confidence",
      "high",
      "--format",
      "json"
    ]);

    assert.equal(listHigh.code, 0, listHigh.stderr);
    const listHighPayload = JSON.parse(listHigh.stdout) as {
      total: number;
      conversations: Array<{ projectConfidence?: string; projectSource?: string }>;
    };

    assert.equal(listHighPayload.total, 1);
    assert.equal(listHighPayload.conversations[0]?.projectConfidence, "high");
    assert.equal(listHighPayload.conversations[0]?.projectSource, "metadata");

    const listSource = runCli([
      "--data-dir",
      dataDir,
      "conversation",
      "list",
      "--ide",
      "vscode-copilot",
      "--project-source",
      "workspace-storage",
      "--format",
      "json"
    ]);

    assert.equal(listSource.code, 0, listSource.stderr);
    const listSourcePayload = JSON.parse(listSource.stdout) as {
      total: number;
      conversations: Array<{ projectConfidence?: string; projectSource?: string }>;
    };

    assert.equal(listSourcePayload.total, 1);
    assert.equal(listSourcePayload.conversations[0]?.projectConfidence, "low");
    assert.equal(listSourcePayload.conversations[0]?.projectSource, "workspace-storage");
  });
});

test("conversation list summary includes scoring details and supports low-confidence fail flag", () => {
  withTempDir((tempDir) => {
    const dataDir = path.join(tempDir, "pluro-data");
    const scanRoot = path.join(tempDir, "Code");
    const highRoot = path.join(scanRoot, "project-high");
    const lowRoot = path.join(scanRoot, "User", "workspaceStorage", "workspace-123");

    writeConversationFixture(highRoot);
    writeConversationFixture(lowRoot, { includeProjectPath: false });

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

    const summaryResult = runCli([
      "--data-dir",
      dataDir,
      "conversation",
      "list",
      "--ide",
      "vscode-copilot",
      "--format",
      "summary"
    ]);

    assert.equal(summaryResult.code, 0, summaryResult.stderr);
    assert.ok(summaryResult.stdout.includes("projectHigh=1"));
    assert.ok(summaryResult.stdout.includes("projectLow=1"));
    assert.ok(summaryResult.stdout.includes("projectResolved=1"));
    assert.ok(summaryResult.stdout.includes("projectGroupedFallback=1"));
    assert.ok(summaryResult.stdout.includes("projectSource=metadata:1,workspace-storage:1"));

    const failResult = runCli([
      "--data-dir",
      dataDir,
      "conversation",
      "list",
      "--ide",
      "vscode-copilot",
      "--format",
      "summary",
      "--fail-on-low-confidence"
    ]);

    assert.equal(failResult.code, 1);
    assert.ok(failResult.stdout.includes("conversation_list"));
  });
});
