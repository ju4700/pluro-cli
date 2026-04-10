import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ConflictPolicy } from "./conflict-resolution";
import { ContextService } from "./context-service";
import {
  contextSnapshotSchema,
  type ConversationDiscoveryFilters,
  type ContextSnapshot,
  type ConversationInjectResult,
  type ConversationScanError,
  type ConversationScanResult,
  type DiscoveredConversation,
  type SupportedIde
} from "./types";

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_SCAN_FILE_LIMIT = 20000;
const MAX_TITLE_LENGTH = 120;
const DIRECTORY_EXCLUSIONS = new Set([
  ".git",
  "node_modules",
  ".pluro-invalid",
  "dist",
  "build",
  ".cache"
]);

const PROJECT_PATH_KEYS = [
  "projectPath",
  "workspacePath",
  "workspaceRoot",
  "repoPath",
  "cwd",
  "rootPath"
];

const IDE_MARKERS = [".cursor", ".vscode", ".antigravity"];

interface ProjectInference {
  projectPath?: string;
  confidence: "high" | "medium" | "low";
  source: string;
  group: string;
}

interface ParsedConversation {
  conversationKey: string;
  title: string;
  projectPath?: string;
  messages: string[];
  format: string;
  metadata: Record<string, string>;
}

interface ParsedFileResult {
  sourceHash: string;
  sizeBytes: number;
  lastModifiedAt?: string;
  conversations: ParsedConversation[];
}

interface ScanKnownOptions {
  ide: SupportedIde;
  roots?: string[];
  recursive?: boolean;
  projectPath?: string;
  maxFiles?: number;
  maxFileSizeBytes?: number;
  includeSessionLogs?: boolean;
}

interface InjectConversationOptions {
  conversationId: string;
  policy?: ConflictPolicy;
  skipUnchanged?: boolean;
  scope?: string;
  tags?: string[];
  projectPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toAbsoluteNormalized(filePath: string): string {
  const resolved = path.resolve(filePath);
  return path.normalize(resolved);
}

function toHash(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizeMessages(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.trunc(value as number), max));
}

function trimTitle(value: string): string {
  const clean = value.trim();
  if (clean.length <= MAX_TITLE_LENGTH) {
    return clean;
  }

  return `${clean.slice(0, MAX_TITLE_LENGTH - 1)}~`;
}

function inferTitle(messages: string[], fallback: string): string {
  const first = messages.find((message) => message.trim().length > 0);
  if (!first) {
    return fallback;
  }

  return trimTitle(first.replace(/\s+/g, " "));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toSafeMetadataValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const clean = value.trim();
    return clean.length > 0 ? clean : undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

function extractWorkspaceIdFromPath(filePath: string): string | undefined {
  const normalized = toAbsoluteNormalized(filePath);
  const segments = normalized.split(path.sep).filter((segment) => segment.length > 0);

  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index]?.toLowerCase() !== "workspacestorage") {
      continue;
    }

    const workspaceId = segments[index + 1];
    if (workspaceId && workspaceId.trim().length > 0) {
      return workspaceId;
    }
  }

  return undefined;
}

export class ConversationDiscoveryService {
  constructor(private readonly contextService: ContextService) {}

  resolveKnownRoots(ide: SupportedIde): string[] {
    const roots = this.resolveKnownRootsForIde(ide)
      .map((root) => toAbsoluteNormalized(root))
      .filter((root) => root.length > 0 && fs.existsSync(root));

    return [...new Set(roots)];
  }

  async scan(options: ScanKnownOptions): Promise<ConversationScanResult> {
    const maxFiles = clampLimit(options.maxFiles, DEFAULT_MAX_FILES, MAX_SCAN_FILE_LIMIT);
    const maxFileSizeBytes = Math.max(
      1024,
      Math.trunc(options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES)
    );
    const recursive = options.recursive !== false;
    const includeSessionLogs = options.includeSessionLogs !== false;

    const configuredRoots =
      options.roots && options.roots.length > 0
        ? options.roots.map((root) => toAbsoluteNormalized(root))
        : this.resolveKnownRoots(options.ide);

    const roots = configuredRoots.filter((root) => fs.existsSync(root));
    const candidates = this.collectCandidateFiles(roots, recursive, includeSessionLogs, maxFiles);

    const discovered: DiscoveredConversation[] = [];
    const errors: ConversationScanError[] = [];
    let skipped = 0;

    const scannedAt = new Date().toISOString();

    for (const filePath of candidates) {
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
          skipped += 1;
          continue;
        }

        if (stat.size > maxFileSizeBytes) {
          skipped += 1;
          continue;
        }

        const parsed = this.parseConversationFile(filePath, stat);

        if (parsed.conversations.length === 0) {
          skipped += 1;
          continue;
        }

        for (const conversation of parsed.conversations) {
          const sourceRoot = this.findSourceRoot(filePath, roots);
          const workspaceId = extractWorkspaceIdFromPath(filePath);
          const projectInference = this.inferProjectDetails({
            ide: options.ide,
            filePath,
            sourceRoot,
            explicitProjectPath: options.projectPath,
            parsedProjectPath: conversation.projectPath,
            workspaceId
          });

          const enrichedMetadata = this.buildIdeMetadata({
            ide: options.ide,
            sourceFile: filePath,
            sourceRoot,
            workspaceId,
            conversation
          });

          const stableKey = this.buildStableConversationKey(
            options.ide,
            filePath,
            conversation.conversationKey
          );

          discovered.push({
            id: stableKey,
            ide: options.ide,
            sourceFile: filePath,
            sourceHash: parsed.sourceHash,
            conversationKey: conversation.conversationKey,
            title: conversation.title,
            projectPath: projectInference.projectPath,
            projectConfidence: projectInference.confidence,
            projectSource: projectInference.source,
            projectGroup: projectInference.group,
            messageCount: conversation.messages.length,
            format: conversation.format,
            sizeBytes: parsed.sizeBytes,
            lastModifiedAt: parsed.lastModifiedAt,
            scannedAt,
            metadata: enrichedMetadata
          });
        }
      } catch (error) {
        errors.push({
          file: filePath,
          error: getErrorMessage(error)
        });
      }
    }

    this.contextService.replaceDiscoveredConversations(options.ide, discovered);

    return {
      ide: options.ide,
      roots,
      scannedFiles: candidates.length,
      discovered: discovered.length,
      skipped,
      errors,
      scannedAt,
      conversations: discovered
    };
  }

  list(filters: ConversationDiscoveryFilters = {}): DiscoveredConversation[] {
    return this.contextService.listDiscoveredConversations(filters);
  }

  async injectConversation(options: InjectConversationOptions): Promise<ConversationInjectResult> {
    const discovered = this.contextService.getDiscoveredConversation(options.conversationId);
    if (!discovered) {
      throw new Error(`Conversation not found: ${options.conversationId}`);
    }

    const stat = fs.statSync(discovered.sourceFile);
    const parsed = this.parseConversationFile(discovered.sourceFile, stat);
    const selected = parsed.conversations.find(
      (conversation) => conversation.conversationKey === discovered.conversationKey
    );

    if (!selected) {
      throw new Error(
        `Conversation key '${discovered.conversationKey}' was not found in ${discovered.sourceFile}`
      );
    }

    const existingIngestState = this.contextService.getConversationIngestState(discovered.id);
    const skipUnchanged = options.skipUnchanged !== false;

    if (skipUnchanged && existingIngestState?.sourceHash === parsed.sourceHash) {
      return {
        conversationId: discovered.id,
        sourceFile: discovered.sourceFile,
        sourceHash: parsed.sourceHash,
        skipped: true,
        reason: "unchanged"
      };
    }

    const snapshot = this.toSnapshot(discovered, selected, {
      scope: options.scope,
      tags: options.tags,
      projectPath: options.projectPath,
      sourceHash: parsed.sourceHash
    });

    const result = await this.contextService.importSnapshot(snapshot, options.policy ?? "keep-both");

    this.contextService.upsertConversationIngestState({
      conversationId: discovered.id,
      sourceHash: parsed.sourceHash,
      lastIngestedAt: new Date().toISOString(),
      result
    });

    return {
      conversationId: discovered.id,
      sourceFile: discovered.sourceFile,
      sourceHash: parsed.sourceHash,
      skipped: false,
      result
    };
  }

  private toSnapshot(
    discovered: DiscoveredConversation,
    parsed: ParsedConversation,
    options: {
      scope?: string;
      tags?: string[];
      projectPath?: string;
      sourceHash?: string;
    }
  ): ContextSnapshot {
    const projectPath = options.projectPath ?? parsed.projectPath ?? discovered.projectPath;
    const scope = options.scope ?? "project";
    const tags = uniqueStrings([
      ...(options.tags ?? []),
      "conversation",
      discovered.ide,
      parsed.format
    ]);

    const baseTime = Date.now();
    const entries = parsed.messages.map((content, index) => {
      const timestamp = new Date(baseTime + index).toISOString();

      const metadata: Record<string, string> = {
        sourceFile: discovered.sourceFile,
        sourceHash: options.sourceHash ?? discovered.sourceHash,
        conversationId: discovered.id,
        conversationKey: discovered.conversationKey,
        conversationTitle: discovered.title,
        conversationFormat: parsed.format,
        ...parsed.metadata
      };

      if (projectPath) {
        metadata.projectPath = projectPath;
      }

      return {
        id: randomUUID(),
        content,
        encrypted: false,
        sourceTool: discovered.ide,
        scope,
        tags,
        metadata,
        version: 1,
        parentId: null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
    });

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      entries,
      history: []
    };
  }

  private collectCandidateFiles(
    roots: string[],
    recursive: boolean,
    includeSessionLogs: boolean,
    maxFiles: number
  ): string[] {
    const files: string[] = [];
    const stack = [...roots];

    while (stack.length > 0 && files.length < maxFiles) {
      const current = stack.pop() as string;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);

        if (entry.isDirectory()) {
          if (!recursive) {
            continue;
          }

          if (DIRECTORY_EXCLUSIONS.has(entry.name.toLowerCase())) {
            continue;
          }

          stack.push(fullPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const extension = path.extname(entry.name).toLowerCase();
        const isSupportedJson = extension === ".json";
        const isSessionLog = extension === ".jsonl" || extension === ".log";

        if (!isSupportedJson && !(includeSessionLogs && isSessionLog)) {
          continue;
        }

        files.push(fullPath);

        if (files.length >= maxFiles) {
          break;
        }
      }
    }

    files.sort((left, right) => left.localeCompare(right));
    return files;
  }

  private parseConversationFile(filePath: string, stat: fs.Stats): ParsedFileResult {
    const payload = fs.readFileSync(filePath, "utf8");
    const extension = path.extname(filePath).toLowerCase();

    let conversations: ParsedConversation[] = [];

    if (extension === ".json") {
      const parsed = JSON.parse(payload) as unknown;
      conversations = this.parseJsonPayload(parsed, filePath);
    } else {
      conversations = this.parseSessionLogPayload(payload, filePath);
    }

    return {
      sourceHash: toHash(payload),
      sizeBytes: stat.size,
      lastModifiedAt: stat.mtime.toISOString(),
      conversations
    };
  }

  private parseJsonPayload(payload: unknown, filePath: string): ParsedConversation[] {
    const snapshot = contextSnapshotSchema.safeParse(payload);

    if (snapshot.success) {
      const messages = snapshot.data.entries
        .map((entry) => entry.content.trim())
        .filter((entry) => entry.length > 0);

      if (messages.length === 0) {
        return [];
      }

      let projectPath: string | undefined;
      for (const entry of snapshot.data.entries) {
        projectPath = this.extractProjectPath(entry.metadata);
        if (projectPath) {
          break;
        }
      }

      const model = snapshot.data.entries
        .map((entry) => entry.metadata.model)
        .find((value): value is string => typeof value === "string" && value.trim().length > 0);

      return [
        {
          conversationKey: "snapshot-v1",
          title: inferTitle(messages, path.basename(filePath)),
          projectPath,
          messages,
          format: "snapshot-v1",
          metadata: {
            exportedAt: snapshot.data.exportedAt,
            ...(model ? { model } : {})
          }
        }
      ];
    }

    return this.parseGenericJsonPayload(payload, filePath);
  }

  private parseGenericJsonPayload(payload: unknown, filePath: string): ParsedConversation[] {
    if (Array.isArray(payload)) {
      const conversationItems = payload.filter(
        (item) =>
          isRecord(item) &&
          (Array.isArray(item.messages) || Array.isArray(item.turns) || Array.isArray(item.chat))
      );

      if (conversationItems.length > 0 && conversationItems.length === payload.length) {
        return conversationItems
          .map((item, index) => this.toConversationFromObject(item, `conversation-${index}`, filePath))
          .filter((item): item is ParsedConversation => item !== null);
      }

      const messages = payload
        .map((item) => this.extractMessageText(item))
        .filter((item): item is string => item !== undefined);

      if (messages.length === 0) {
        return [];
      }

      return [
        {
          conversationKey: "array",
          title: inferTitle(messages, path.basename(filePath)),
          projectPath: undefined,
          messages,
          format: "transcript-array",
          metadata: {}
        }
      ];
    }

    if (!isRecord(payload)) {
      return [];
    }

    if (Array.isArray(payload.conversations)) {
      return payload.conversations
        .map((item, index) => this.toConversationFromObject(item, `conversation-${index}`, filePath))
        .filter((item): item is ParsedConversation => item !== null);
    }

    const singleConversation = this.toConversationFromObject(payload, "conversation", filePath);
    return singleConversation ? [singleConversation] : [];
  }

  private parseSessionLogPayload(payload: string, filePath: string): ParsedConversation[] {
    const lines = payload
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      return [];
    }

    const messages: string[] = [];

    for (const line of lines) {
      if (line.startsWith("{") && line.endsWith("}")) {
        try {
          const parsed = JSON.parse(line) as unknown;
          const text = this.extractMessageText(parsed);
          if (text) {
            messages.push(text);
          }
          continue;
        } catch {
          messages.push(line);
          continue;
        }
      }

      messages.push(line);
    }

    if (messages.length === 0) {
      return [];
    }

    return [
      {
        conversationKey: "session-log",
        title: inferTitle(messages, path.basename(filePath)),
        projectPath: undefined,
        messages,
        format: "session-log",
        metadata: {}
      }
    ];
  }

  private toConversationFromObject(
    payload: unknown,
    conversationKey: string,
    filePath: string
  ): ParsedConversation | null {
    if (!isRecord(payload)) {
      return null;
    }

    let messageSource: unknown;
    if (Array.isArray(payload.messages)) {
      messageSource = payload.messages;
    } else if (Array.isArray(payload.turns)) {
      messageSource = payload.turns;
    } else if (Array.isArray(payload.chat)) {
      messageSource = payload.chat;
    } else {
      messageSource = payload;
    }

    const messages = this.collectMessages(messageSource);
    if (messages.length === 0) {
      return null;
    }

    const title =
      (typeof payload.title === "string" && payload.title.trim()) ||
      (typeof payload.name === "string" && payload.name.trim()) ||
      inferTitle(messages, path.basename(filePath));

    const projectPath = this.extractProjectPath(payload);

    const metadata: Record<string, string> = {};
    if (typeof payload.id === "string" && payload.id.trim().length > 0) {
      metadata.originId = payload.id;
    }
    if (typeof payload.sessionId === "string" && payload.sessionId.trim().length > 0) {
      metadata.sessionId = payload.sessionId;
    }

    this.appendMetadataFromKeys(metadata, payload, {
      model: ["model", "modelName", "engine"],
      provider: ["provider", "vendor"],
      workspaceId: ["workspaceId"],
      projectName: ["projectName", "workspaceName"],
      originCreatedAt: ["createdAt", "timestamp"]
    });

    const roleStats = this.collectRoleStats(messageSource);
    if (Object.keys(roleStats).length > 0) {
      metadata.roles = Object.entries(roleStats)
        .map(([role, count]) => `${role}:${count}`)
        .join(",");
    }

    return {
      conversationKey,
      title: trimTitle(title),
      projectPath,
      messages,
      format: "transcript-json",
      metadata
    };
  }

  private collectMessages(payload: unknown): string[] {
    if (Array.isArray(payload)) {
      const messages = payload
        .map((item) => this.extractMessageText(item))
        .filter((item): item is string => item !== undefined);

      return normalizeMessages(messages);
    }

    const single = this.extractMessageText(payload);
    if (!single) {
      return [];
    }

    return [single];
  }

  private extractMessageText(payload: unknown): string | undefined {
    if (typeof payload === "string") {
      const text = payload.trim();
      return text.length > 0 ? text : undefined;
    }

    if (!isRecord(payload)) {
      return undefined;
    }

    const candidates: unknown[] = [
      payload.content,
      payload.text,
      payload.message,
      payload.prompt,
      payload.response
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    if (Array.isArray(payload.content)) {
      const parts = payload.content
        .map((part) => this.extractMessageText(part))
        .filter((part): part is string => part !== undefined);

      if (parts.length > 0) {
        return parts.join(" ");
      }
    }

    if (Array.isArray(payload.parts)) {
      const parts = payload.parts
        .map((part) => this.extractMessageText(part))
        .filter((part): part is string => part !== undefined);

      if (parts.length > 0) {
        return parts.join(" ");
      }
    }

    return undefined;
  }

  private extractProjectPath(payload: unknown): string | undefined {
    if (!isRecord(payload)) {
      return undefined;
    }

    for (const key of PROJECT_PATH_KEYS) {
      const candidate = payload[key];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return toAbsoluteNormalized(candidate);
      }
    }

    const metadata = payload.metadata;
    if (isRecord(metadata)) {
      for (const key of PROJECT_PATH_KEYS) {
        const candidate = metadata[key];
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          return toAbsoluteNormalized(candidate);
        }
      }
    }

    return undefined;
  }

  private appendMetadataFromKeys(
    metadata: Record<string, string>,
    payload: Record<string, unknown>,
    keys: Record<string, string[]>
  ): void {
    const nestedMetadata = isRecord(payload.metadata) ? payload.metadata : undefined;

    for (const [targetKey, candidateKeys] of Object.entries(keys)) {
      for (const candidateKey of candidateKeys) {
        const value =
          toSafeMetadataValue(payload[candidateKey]) ??
          (nestedMetadata ? toSafeMetadataValue(nestedMetadata[candidateKey]) : undefined);

        if (!value) {
          continue;
        }

        metadata[targetKey] = value;
        break;
      }
    }
  }

  private collectRoleStats(payload: unknown): Record<string, number> {
    if (!Array.isArray(payload)) {
      return {};
    }

    const counts: Record<string, number> = {};

    for (const item of payload) {
      if (!isRecord(item)) {
        continue;
      }

      const role = toSafeMetadataValue(item.role)?.toLowerCase();
      if (!role) {
        continue;
      }

      counts[role] = (counts[role] ?? 0) + 1;
    }

    return counts;
  }

  private inferProjectDetails(options: {
    ide: SupportedIde;
    filePath: string;
    sourceRoot: string;
    explicitProjectPath?: string;
    parsedProjectPath?: string;
    workspaceId?: string;
  }): ProjectInference {
    if (options.explicitProjectPath) {
      const normalized = toAbsoluteNormalized(options.explicitProjectPath);
      return {
        projectPath: normalized,
        confidence: "high",
        source: "override",
        group: normalized
      };
    }

    if (options.parsedProjectPath) {
      const normalized = toAbsoluteNormalized(options.parsedProjectPath);
      return {
        projectPath: normalized,
        confidence: "high",
        source: "metadata",
        group: normalized
      };
    }

    const gitRoot = this.findNearestGitRoot(options.filePath, options.sourceRoot);
    if (gitRoot) {
      return {
        projectPath: gitRoot,
        confidence: "medium",
        source: "git-root",
        group: gitRoot
      };
    }

    const markerProjectPath = this.findProjectFromIdeMarker(options.filePath);
    if (markerProjectPath) {
      return {
        projectPath: markerProjectPath,
        confidence: "low",
        source: "path-marker",
        group: markerProjectPath
      };
    }

    if (options.workspaceId) {
      return {
        confidence: "low",
        source: "workspace-storage",
        group: `${options.ide}:workspace:${options.workspaceId}`
      };
    }

    const fallbackGroup = path.basename(options.sourceRoot || path.dirname(options.filePath)) || "unknown";

    return {
      confidence: "low",
      source: "unknown",
      group: `${options.ide}:root:${fallbackGroup}`
    };
  }

  private findNearestGitRoot(filePath: string, sourceRoot: string): string | undefined {
    let current = path.dirname(toAbsoluteNormalized(filePath));
    const floor = sourceRoot ? toAbsoluteNormalized(sourceRoot) : undefined;

    for (let index = 0; index < 12; index += 1) {
      if (fs.existsSync(path.join(current, ".git"))) {
        return current;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }

      if (floor && !parent.startsWith(floor)) {
        break;
      }

      current = parent;
    }

    return undefined;
  }

  private findProjectFromIdeMarker(filePath: string): string | undefined {
    const normalized = toAbsoluteNormalized(filePath);
    const segments = normalized.split(path.sep).filter((segment) => segment.length > 0);

    for (let index = 0; index < segments.length; index += 1) {
      if (!IDE_MARKERS.includes(segments[index]?.toLowerCase() ?? "")) {
        continue;
      }

      if (index === 0) {
        continue;
      }

      return path.join(...segments.slice(0, index));
    }

    return undefined;
  }

  private buildIdeMetadata(options: {
    ide: SupportedIde;
    sourceFile: string;
    sourceRoot: string;
    workspaceId?: string;
    conversation: ParsedConversation;
  }): Record<string, string> {
    const metadata: Record<string, string> = {
      ...options.conversation.metadata,
      sourceRoot: options.sourceRoot,
      sourceFileExt: path.extname(options.sourceFile).toLowerCase(),
      sourceFileBase: path.basename(options.sourceFile)
    };

    if (options.workspaceId) {
      metadata.workspaceId = options.workspaceId;
    }

    if (options.ide === "vscode-copilot") {
      metadata.ideChannel = options.sourceFile.includes("Code - Insiders") ? "insiders" : "stable";
    }

    if (options.ide === "cursor") {
      metadata.ideVariant = options.sourceFile.includes("Cursor") ? "desktop" : "unknown";
    }

    if (options.ide === "antigravity") {
      metadata.ideVariant = "antigravity";
    }

    return metadata;
  }

  private findSourceRoot(filePath: string, roots: string[]): string {
    const normalizedFilePath = toAbsoluteNormalized(filePath);

    for (const root of roots) {
      const normalizedRoot = toAbsoluteNormalized(root);
      if (normalizedFilePath.startsWith(normalizedRoot)) {
        return normalizedRoot;
      }
    }

    return roots[0] ?? "";
  }

  private buildStableConversationKey(ide: SupportedIde, filePath: string, key: string): string {
    const normalized =
      process.platform === "win32"
        ? `${ide}|${toAbsoluteNormalized(filePath).toLowerCase()}|${key}`
        : `${ide}|${toAbsoluteNormalized(filePath)}|${key}`;

    return toHash(normalized).slice(0, 32);
  }

  private resolveKnownRootsForIde(ide: SupportedIde): string[] {
    if (process.platform === "win32") {
      const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
      const localAppData =
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");

      if (ide === "cursor") {
        return [
          path.join(appData, "Cursor", "User", "workspaceStorage"),
          path.join(localAppData, "Cursor", "User", "workspaceStorage")
        ];
      }

      if (ide === "vscode-copilot") {
        return [
          path.join(appData, "Code", "User", "workspaceStorage"),
          path.join(appData, "Code - Insiders", "User", "workspaceStorage")
        ];
      }

      return [
        path.join(appData, "Antigravity"),
        path.join(localAppData, "Antigravity"),
        path.join(os.homedir(), ".antigravity")
      ];
    }

    if (ide === "cursor") {
      return [
        path.join(os.homedir(), ".config", "Cursor", "User", "workspaceStorage"),
        path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "workspaceStorage")
      ];
    }

    if (ide === "vscode-copilot") {
      return [
        path.join(os.homedir(), ".config", "Code", "User", "workspaceStorage"),
        path.join(
          os.homedir(),
          "Library",
          "Application Support",
          "Code",
          "User",
          "workspaceStorage"
        )
      ];
    }

    return [path.join(os.homedir(), ".antigravity")];
  }
}

export type { InjectConversationOptions, ScanKnownOptions };
