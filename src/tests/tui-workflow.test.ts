import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import type { DiscoveredConversation } from "../core/types";
import {
  buildWorkspaceOptions,
  conversationMatchesWorkspace,
  targetProfileIdForIde
} from "../tui/workflow";

function withTempDir(handler: (tempDir: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pluro-tui-workflow-it-"));

  try {
    handler(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createConversationFixture(rootPath: string): DiscoveredConversation {
  const workspaceStorageRoot = path.join(rootPath, "Code", "User", "workspaceStorage");
  const workspaceId = "workspace-001";
  const sourceFile = path.join(workspaceStorageRoot, workspaceId, "conversation.json");
  const projectPath = path.join(rootPath, "project-alpha");

  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });

  return {
    id: "conv-1",
    ide: "vscode-copilot",
    sourceFile,
    sourceHash: "hash-1",
    conversationKey: "key-1",
    title: "Conversation fixture",
    projectPath,
    projectConfidence: "high",
    projectSource: "metadata",
    projectGroup: projectPath,
    messageCount: 2,
    format: "json",
    sizeBytes: 128,
    scannedAt: new Date().toISOString(),
    metadata: {
      workspaceId,
      sourceRoot: workspaceStorageRoot
    }
  };
}

test("workspace options merge machine roots and discovered metadata", () => {
  withTempDir((tempDir) => {
    const workspaceStorageRoot = path.join(tempDir, "Code", "User", "workspaceStorage");
    const machineWorkspacePath = path.join(workspaceStorageRoot, "workspace-001");

    fs.mkdirSync(machineWorkspacePath, { recursive: true });

    const conversation = createConversationFixture(tempDir);

    const options = buildWorkspaceOptions([workspaceStorageRoot], [conversation]);

    assert.ok(options.some((option) => option.source === "machine-workspace"));
    assert.ok(options.some((option) => option.source === "discovered-project"));
    assert.ok(options.some((option) => option.workspaceId === "workspace-001"));
    assert.ok(options.some((option) => (option.conversationCount ?? 0) > 0));
  });
});

test("workspace options show folder name when workspace.json is present", () => {
  withTempDir((tempDir) => {
    const workspaceStorageRoot = path.join(tempDir, "Code", "User", "workspaceStorage");
    const workspaceId = "workspace-002";
    const machineWorkspacePath = path.join(workspaceStorageRoot, workspaceId);
    const projectPath = path.join(tempDir, "project-beta");

    fs.mkdirSync(machineWorkspacePath, { recursive: true });
    fs.mkdirSync(projectPath, { recursive: true });

    fs.writeFileSync(
      path.join(machineWorkspacePath, "workspace.json"),
      `${JSON.stringify({ folder: pathToFileURL(projectPath).toString() }, null, 2)}\n`,
      "utf8"
    );

    const options = buildWorkspaceOptions([workspaceStorageRoot], []);
    const workspaceOption = options.find((option) => option.workspaceId === workspaceId);

    assert.ok(workspaceOption);
    assert.equal(workspaceOption?.projectPath, path.resolve(projectPath));
    assert.ok((workspaceOption?.label ?? "").includes("project-beta"));
  });
});

test("conversation workspace matching accepts project and workspace-id rules", () => {
  withTempDir((tempDir) => {
    const conversation = createConversationFixture(tempDir);
    const workspaceStorageRoot = path.join(tempDir, "Code", "User", "workspaceStorage");

    const options = buildWorkspaceOptions([workspaceStorageRoot], [conversation]);

    const projectOption = options.find((option) => option.source === "discovered-project");
    assert.ok(projectOption);
    assert.equal(conversationMatchesWorkspace(conversation, projectOption as NonNullable<typeof projectOption>), true);

    const workspaceOption = options.find((option) => option.workspaceId === "workspace-001");
    assert.ok(workspaceOption);
    assert.equal(conversationMatchesWorkspace(conversation, workspaceOption as NonNullable<typeof workspaceOption>), true);
  });
});

test("target profile mapping stays stable for primary IDEs", () => {
  assert.equal(targetProfileIdForIde("cursor"), "cursor-file");
  assert.equal(targetProfileIdForIde("vscode-copilot"), "vscode-copilot-file");
  assert.equal(targetProfileIdForIde("antigravity"), "antigravity-file");
});
