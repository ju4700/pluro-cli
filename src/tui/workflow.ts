import * as fs from "node:fs";
import * as path from "node:path";

import { FileAdapterEngine } from "../adapters/file-sync";
import { findAdapterProfileById } from "../adapters/profiles";
import type { ContextService } from "../core/context-service";
import type { DiscoveredConversation, SupportedIde } from "../core/types";

const IDE_TARGET_PROFILE: Record<SupportedIde, string> = {
  cursor: "cursor-file",
  "vscode-copilot": "vscode-copilot-file",
  antigravity: "antigravity-file"
};

export interface IdeAvailability {
  ide: SupportedIde;
  knownRoots: string[];
  discoveredCount: number;
  available: boolean;
}

export type WorkspaceOptionSource =
  | "machine-root"
  | "machine-workspace"
  | "discovered-project"
  | "discovered-workspace"
  | "discovered-group"
  | "fallback";

export interface WorkspaceOption {
  id: string;
  label: string;
  source: WorkspaceOptionSource;
  scanRoots: string[];
  projectPath?: string;
  projectGroup?: string;
  workspaceId?: string;
  conversationCount?: number;
}

export interface AdapterExportResult {
  adapterFile: string;
  outboundFile: string;
  entries: number;
  exportedAt: string;
  profileId: string;
  adapterCreated: boolean;
}

function normalizeAbsolutePath(filePath: string): string {
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function shortenPath(filePath: string, maxLength = 64): string {
  if (filePath.length <= maxLength) {
    return filePath;
  }

  return `…${filePath.slice(filePath.length - maxLength + 1)}`;
}

function pathStartsWith(filePath: string, rootPath: string): boolean {
  const normalizedPath = normalizeAbsolutePath(filePath);
  const normalizedRoot = normalizeAbsolutePath(rootPath);

  if (normalizedPath === normalizedRoot) {
    return true;
  }

  const separator = path.sep;
  return normalizedPath.startsWith(`${normalizedRoot}${separator}`);
}

function safeDirectoryChildren(rootPath: string): string[] {
  try {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootPath, entry.name));
  } catch {
    return [];
  }
}

function decodeFileUri(value: string): string | undefined {
  const raw = value.trim();
  if (!raw.startsWith("file://")) {
    return undefined;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "file:") {
      return undefined;
    }

    let pathname = decodeURIComponent(parsed.pathname);
    if (process.platform === "win32") {
      if (pathname.startsWith("/")) {
        pathname = pathname.slice(1);
      }

      pathname = pathname.replace(/\//g, path.sep);
    }

    return path.resolve(pathname);
  } catch {
    return undefined;
  }
}

function readWorkspaceProjectPath(workspacePath: string): string | undefined {
  const workspaceMetadataFile = path.join(workspacePath, "workspace.json");
  if (!fs.existsSync(workspaceMetadataFile)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(workspaceMetadataFile, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    if (typeof record.folder === "string" && record.folder.trim().length > 0) {
      const fromUri = decodeFileUri(record.folder);
      if (fromUri) {
        return fromUri;
      }

      if (fs.existsSync(record.folder)) {
        return path.resolve(record.folder);
      }
    }

    const workspace = record.workspace;
    if (typeof workspace === "string" && workspace.trim().length > 0) {
      const fromUri = decodeFileUri(workspace);
      if (fromUri) {
        return fromUri;
      }
    }

    if (workspace && typeof workspace === "object" && !Array.isArray(workspace)) {
      const configPath = (workspace as Record<string, unknown>).configPath;
      if (typeof configPath === "string" && configPath.trim().length > 0) {
        const fromUri = decodeFileUri(configPath);
        if (fromUri) {
          return path.dirname(fromUri);
        }

        if (fs.existsSync(configPath)) {
          return path.dirname(path.resolve(configPath));
        }
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function uniqueScanRoots(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.length > 0)))];
}

function baseNameOrFallback(filePath: string, fallback: string): string {
  const name = path.basename(filePath).trim();
  return name.length > 0 ? name : fallback;
}

function upsertWorkspaceOption(map: Map<string, WorkspaceOption>, option: WorkspaceOption): void {
  if (!map.has(option.id)) {
    map.set(option.id, option);
  }
}

function workspacePriority(source: WorkspaceOptionSource): number {
  switch (source) {
    case "machine-workspace":
      return 0;
    case "discovered-project":
      return 1;
    case "discovered-workspace":
      return 2;
    case "machine-root":
      return 3;
    case "discovered-group":
      return 4;
    default:
      return 5;
  }
}

export function buildIdeAvailability(
  ide: SupportedIde,
  knownRoots: string[],
  discoveredCount: number
): IdeAvailability {
  return {
    ide,
    knownRoots,
    discoveredCount,
    available: knownRoots.length > 0 || discoveredCount > 0
  };
}

export function buildWorkspaceOptions(
  knownRoots: string[],
  conversations: DiscoveredConversation[]
): WorkspaceOption[] {
  const options = new Map<string, WorkspaceOption>();

  for (const knownRoot of knownRoots) {
    const normalizedRoot = path.resolve(knownRoot);
    upsertWorkspaceOption(options, {
      id: `root:${normalizeAbsolutePath(normalizedRoot)}`,
      label: `Root ${shortenPath(normalizedRoot)}`,
      source: "machine-root",
      scanRoots: [normalizedRoot]
    });

    if (path.basename(normalizedRoot).toLowerCase() === "workspacestorage") {
      const workspaces = safeDirectoryChildren(normalizedRoot);

      for (const workspacePath of workspaces) {
        const workspaceId = path.basename(workspacePath);
        const workspaceProjectPath = readWorkspaceProjectPath(workspacePath);
        const displayName = workspaceProjectPath
          ? baseNameOrFallback(workspaceProjectPath, workspaceId)
          : workspaceId;

        upsertWorkspaceOption(options, {
          id: `workspace:${normalizeAbsolutePath(workspacePath)}`,
          label: `Workspace ${displayName} · ${workspaceId}`,
          source: "machine-workspace",
          scanRoots: uniqueScanRoots([workspacePath, workspaceProjectPath]),
          workspaceId,
          projectPath: workspaceProjectPath
        });
      }
    }
  }

  for (const conversation of conversations) {
    if (conversation.projectPath) {
      const normalizedProjectPath = path.resolve(conversation.projectPath);
      upsertWorkspaceOption(options, {
        id: `project:${normalizeAbsolutePath(normalizedProjectPath)}`,
        label: `Project ${shortenPath(normalizedProjectPath)}`,
        source: "discovered-project",
        scanRoots: [normalizedProjectPath],
        projectPath: normalizedProjectPath,
        workspaceId: conversation.metadata.workspaceId
      });
    }

    const metadataWorkspaceId = conversation.metadata.workspaceId;
    const metadataSourceRoot = conversation.metadata.sourceRoot;

    if (metadataWorkspaceId && metadataSourceRoot) {
      const workspacePath = path.resolve(metadataSourceRoot, metadataWorkspaceId);
      const workspaceProjectPath = readWorkspaceProjectPath(workspacePath);
      const scanRoots = fs.existsSync(workspacePath)
        ? uniqueScanRoots([workspacePath, workspaceProjectPath])
        : fs.existsSync(metadataSourceRoot)
          ? uniqueScanRoots([path.resolve(metadataSourceRoot)])
          : [];

      const displayName = workspaceProjectPath
        ? baseNameOrFallback(workspaceProjectPath, metadataWorkspaceId)
        : metadataWorkspaceId;

      upsertWorkspaceOption(options, {
        id: `discovered-workspace:${normalizeAbsolutePath(workspacePath)}`,
        label: `Indexed workspace ${displayName} · ${metadataWorkspaceId}`,
        source: "discovered-workspace",
        scanRoots,
        workspaceId: metadataWorkspaceId,
        projectPath: workspaceProjectPath
      });
    }

    if (conversation.projectGroup) {
      upsertWorkspaceOption(options, {
        id: `group:${conversation.projectGroup}`,
        label: `Group ${conversation.projectGroup}`,
        source: "discovered-group",
        scanRoots: [],
        projectGroup: conversation.projectGroup,
        workspaceId: conversation.metadata.workspaceId
      });
    }
  }

  const sortedOptions = [...options.values()].sort((left, right) => {
    const sourceCompare = workspacePriority(left.source) - workspacePriority(right.source);
    if (sourceCompare !== 0) {
      return sourceCompare;
    }

    return left.label.localeCompare(right.label);
  });

  if (sortedOptions.length > 0) {
    return sortedOptions.map((option) => ({
      ...option,
      conversationCount: conversations.reduce(
        (count, conversation) =>
          count + (conversationMatchesWorkspace(conversation, option) ? 1 : 0),
        0
      )
    }));
  }

  return [
    {
      id: "fallback:none",
      label: "No workspace discovered yet",
      source: "fallback",
      scanRoots: knownRoots,
      conversationCount: 0
    }
  ];
}

export function conversationMatchesWorkspace(
  conversation: DiscoveredConversation,
  workspace: WorkspaceOption
): boolean {
  let hasRule = false;

  if (workspace.projectPath) {
    hasRule = true;

    if (conversation.projectPath) {
      const normalizedConversationPath = normalizeAbsolutePath(conversation.projectPath);
      const normalizedWorkspacePath = normalizeAbsolutePath(workspace.projectPath);
      if (normalizedConversationPath === normalizedWorkspacePath) {
        return true;
      }
    }
  }

  if (workspace.projectGroup) {
    hasRule = true;

    if (conversation.projectGroup === workspace.projectGroup) {
      return true;
    }
  }

  if (workspace.workspaceId) {
    hasRule = true;

    if (conversation.metadata.workspaceId === workspace.workspaceId) {
      return true;
    }
  }

  if (workspace.scanRoots.length > 0) {
    hasRule = true;

    for (const root of workspace.scanRoots) {
      if (pathStartsWith(conversation.sourceFile, root)) {
        return true;
      }

      if (conversation.projectPath && pathStartsWith(conversation.projectPath, root)) {
        return true;
      }
    }
  }

  return !hasRule;
}

export function targetProfileIdForIde(ide: SupportedIde): string {
  return IDE_TARGET_PROFILE[ide];
}

export function ensureTargetAdapterFile(dataDir: string, ide: SupportedIde): {
  adapterFile: string;
  profileId: string;
  created: boolean;
} {
  const profileId = targetProfileIdForIde(ide);
  const profile = findAdapterProfileById(profileId);

  if (!profile) {
    throw new Error(`Unable to resolve target adapter profile for IDE '${ide}'.`);
  }

  const adapterFile = path.join(dataDir, profile.suggestedPath, "pluro.adapter.json");
  const engine = new FileAdapterEngine(dataDir);

  let created = false;
  if (!fs.existsSync(adapterFile)) {
    engine.createProfileTemplate(profile.id);
    created = true;
  }

  return {
    adapterFile,
    profileId: profile.id,
    created
  };
}

export async function exportSnapshotToTargetIde(
  service: ContextService,
  dataDir: string,
  ide: SupportedIde
): Promise<AdapterExportResult> {
  const ensured = ensureTargetAdapterFile(dataDir, ide);
  const engine = new FileAdapterEngine(dataDir);
  const config = engine.readAdapterConfig(ensured.adapterFile);

  if (config.syncMode !== "file-sync") {
    throw new Error(
      `Target profile '${ensured.profileId}' uses sync mode '${config.syncMode}'. File-sync profile required.`
    );
  }

  if (!config.outboundSnapshotFile) {
    throw new Error(`Target profile '${ensured.profileId}' is missing outbound snapshot config.`);
  }

  const outboundFile = engine.resolveAdapterFilePath(ensured.adapterFile, config.outboundSnapshotFile);
  const snapshot = await service.exportSnapshot();
  engine.writeSnapshot(outboundFile, snapshot);

  return {
    adapterFile: ensured.adapterFile,
    outboundFile,
    entries: snapshot.entries.length,
    exportedAt: snapshot.exportedAt,
    profileId: ensured.profileId,
    adapterCreated: ensured.created
  };
}
