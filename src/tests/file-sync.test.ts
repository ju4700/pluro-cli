import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { FileAdapterEngine } from "../adapters/file-sync";

function withTempDir(handler: (tempDir: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pluro-file-sync-"));

  try {
    handler(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("cursor profile template creates adapter and snapshot files", () => {
  withTempDir((tempDir) => {
    const engine = new FileAdapterEngine(tempDir);
    const result = engine.createProfileTemplate("cursor-file");

    assert.ok(fs.existsSync(result.adapterFile));
    assert.ok(result.createdFiles.length >= 4);

    const config = engine.readAdapterConfig(result.adapterFile);
    assert.equal(config.profileId, "cursor-file");
    assert.equal(config.syncMode, "file-sync");
    assert.equal(config.conflictPolicy, "keep-both");

    assert.ok(config.inboundSnapshotFile);
    assert.ok(config.outboundSnapshotFile);
    assert.ok(fs.existsSync(config.inboundSnapshotFile as string));
    assert.ok(fs.existsSync(config.outboundSnapshotFile as string));
  });
});

test("vscode copilot profile template creates expected files", () => {
  withTempDir((tempDir) => {
    const engine = new FileAdapterEngine(tempDir);
    const result = engine.createProfileTemplate("vscode-copilot-file");

    assert.ok(fs.existsSync(result.adapterFile));

    const config = engine.readAdapterConfig(result.adapterFile);
    assert.equal(config.profileId, "vscode-copilot-file");
    assert.equal(config.tool, "vscode-copilot");
    assert.equal(config.syncMode, "file-sync");
    assert.ok(fs.existsSync(config.inboundSnapshotFile as string));
    assert.ok(fs.existsSync(config.outboundSnapshotFile as string));
  });
});

test("profile aliases can bootstrap templates", () => {
  withTempDir((tempDir) => {
    const engine = new FileAdapterEngine(tempDir);
    const result = engine.createProfileTemplate("copilot-file");

    const config = engine.readAdapterConfig(result.adapterFile);
    assert.equal(config.profileId, "vscode-copilot-file");
  });
});

test("mcp profile template exposes mcp command metadata", () => {
  withTempDir((tempDir) => {
    const engine = new FileAdapterEngine(tempDir);
    const result = engine.createProfileTemplate("mcp-client");

    const config = engine.readAdapterConfig(result.adapterFile);
    assert.equal(config.syncMode, "mcp");
    assert.equal(config.mcpCommand, "pluro");
    assert.deepEqual(config.mcpArgs, ["daemon", "mcp"]);
  });
});
