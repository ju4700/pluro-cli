import { z } from "zod";

export type ContextScope = "global" | "project" | "session";

export interface ContextEntry {
  id: string;
  content: string;
  encrypted: boolean;
  sourceTool: string;
  scope: string;
  tags: string[];
  metadata: Record<string, string>;
  version: number;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedContextEntry {
  id: string;
  content: string;
  contentIv: string | null;
  encrypted: boolean;
  sourceTool: string;
  scope: string;
  tags: string[];
  metadata: Record<string, string>;
  version: number;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type HistoryAction = "created" | "updated" | "deleted" | "imported";

export interface HistoryEntry {
  id: string;
  entryId: string;
  action: HistoryAction;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateContextInput {
  content: string;
  sourceTool: string;
  scope?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  encrypt?: boolean;
  parentId?: string;
}

export interface UpdateContextInput {
  content?: string;
  sourceTool?: string;
  scope?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  encrypt?: boolean;
}

export interface SearchContextFilters {
  query?: string;
  sourceTool?: string;
  scope?: string;
  tag?: string;
  limit?: number;
  cursor?: string;
}

export interface ContextListPage {
  entries: ContextEntry[];
  nextCursor?: string;
}

export interface SnapshotExportOptions {
  limit?: number;
  cursor?: string;
  historyLimit?: number;
}

export const snapshotEntrySchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  encrypted: z.boolean(),
  sourceTool: z.string().min(1),
  scope: z.string().min(1),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.string()).default({}),
  version: z.number().int().positive(),
  parentId: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const snapshotHistorySchema = z.object({
  id: z.string().uuid(),
  entryId: z.string().uuid(),
  action: z.enum(["created", "updated", "deleted", "imported"]),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime()
});

export const contextSnapshotSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  entries: z.array(snapshotEntrySchema),
  history: z.array(snapshotHistorySchema).default([]),
  nextCursor: z.string().optional()
});

export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;

export interface SnapshotImportResult {
  imported: number;
  updated: number;
  skipped: number;
  duplicated: number;
  conflicts: number;
}

export type SupportedIde = "cursor" | "vscode-copilot" | "antigravity";

export interface DiscoveredConversation {
  id: string;
  ide: SupportedIde;
  sourceFile: string;
  sourceHash: string;
  conversationKey: string;
  title: string;
  projectPath?: string;
  messageCount: number;
  format: string;
  sizeBytes: number;
  lastModifiedAt?: string;
  scannedAt: string;
  metadata: Record<string, string>;
}

export interface ConversationDiscoveryFilters {
  ide?: SupportedIde;
  projectPath?: string;
  limit?: number;
}

export interface ConversationIngestState {
  conversationId: string;
  sourceHash: string;
  lastIngestedAt: string;
  result: SnapshotImportResult;
}

export interface ConversationScanError {
  file: string;
  error: string;
}

export interface ConversationScanResult {
  ide: SupportedIde;
  roots: string[];
  scannedFiles: number;
  discovered: number;
  skipped: number;
  errors: ConversationScanError[];
  scannedAt: string;
  conversations: DiscoveredConversation[];
}

export interface ConversationInjectResult {
  conversationId: string;
  sourceFile: string;
  sourceHash: string;
  skipped: boolean;
  reason?: string;
  result?: SnapshotImportResult;
}
