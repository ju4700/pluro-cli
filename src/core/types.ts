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
  history: z.array(snapshotHistorySchema).default([])
});

export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;

export interface SnapshotImportResult {
  imported: number;
  updated: number;
  skipped: number;
  duplicated: number;
  conflicts: number;
}
