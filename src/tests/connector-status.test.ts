import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { FileAdapterEngine } from "../adapters/file-sync";

function withTempDir(handler: (tempDir: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pluro-status-it-"));

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

test("connector status reports primary file-sync adapters", () => {
  withTempDir((dataDir) => {
    const result = runCli([
      "--data-dir",
      dataDir,
      "connector",
      "status",
      "--focus",
      "primary",
      "--sync-mode",
      "file-sync"
    ]);

    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout) as {
      summary: { total: number };
      statuses: Array<{ expectedProfileId?: string }>;
    };

    assert.equal(payload.summary.total, 3);
    const expected = payload.statuses.map((status) => status.expectedProfileId);

    assert.ok(expected.includes("cursor-file"));
    assert.ok(expected.includes("vscode-copilot-file"));
    assert.ok(expected.includes("antigravity-file"));
  });
});

test("connector status reports healthy for explicit adapter file", () => {
  withTempDir((dataDir) => {
    const engine = new FileAdapterEngine(dataDir);
    const template = engine.createProfileTemplate("cursor-file");

    const result = runCli([
      "--data-dir",
      dataDir,
      "connector",
      "status",
      template.adapterFile
    ]);

    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout) as {
      summary: { total: number; healthy: number };
      statuses: Array<{ health: string; configured: boolean }>;
    };

    assert.equal(payload.summary.total, 1);
    assert.equal(payload.summary.healthy, 1);
    assert.equal(payload.statuses[0]?.configured, true);
    assert.equal(payload.statuses[0]?.health, "healthy");
  });
});

test("connector status supports table output format", () => {
  withTempDir((dataDir) => {
    const engine = new FileAdapterEngine(dataDir);
    engine.createProfileTemplate("cursor-file");
    engine.createProfileTemplate("vscode-copilot-file");
    engine.createProfileTemplate("antigravity-file");

    const result = runCli([
      "--data-dir",
      dataDir,
      "connector",
      "status",
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
    assert.ok(result.stdout.includes("Summary:"));
  });
});
