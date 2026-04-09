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

test("adapter status reports healthy for valid file-sync profile", () => {
  withTempDir((tempDir) => {
    const engine = new FileAdapterEngine(tempDir);
    const result = engine.createProfileTemplate("cursor-file");

    const status = engine.getAdapterStatus(result.adapterFile);

    assert.equal(status.configured, true);
    assert.equal(status.health, "healthy");
    assert.equal(status.profileId, "cursor-file");
    assert.equal(status.syncMode, "file-sync");
    assert.ok(status.fileSync);
    assert.equal(status.fileSync?.inbound.valid, true);
    assert.equal(status.fileSync?.outbound.valid, true);
  });
});

test("adapter status reports invalid inbound snapshot and quarantine count", () => {
  withTempDir((tempDir) => {
    const engine = new FileAdapterEngine(tempDir);
    const result = engine.createProfileTemplate("cursor-file");
    const config = engine.readAdapterConfig(result.adapterFile);
    const inbound = config.inboundSnapshotFile as string;

    fs.writeFileSync(inbound, "{\n  \"version\": 1,\n  \"broken\": ", "utf8");

    const quarantineDir = path.join(path.dirname(inbound), ".pluro-invalid");
    fs.mkdirSync(quarantineDir, { recursive: true });
    fs.writeFileSync(path.join(quarantineDir, "bad.snapshot.json"), "{}\n", "utf8");

    const status = engine.getAdapterStatus(result.adapterFile);

    assert.equal(status.health, "error");
    assert.ok(status.errors.some((item) => item.includes("Inbound snapshot is invalid")));
    assert.equal(status.fileSync?.quarantinedFilesCount, 1);
  });
});
