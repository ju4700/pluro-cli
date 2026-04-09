import { randomUUID } from "node:crypto";

import { resolveConflict, type ConflictPolicy } from "./conflict-resolution";
import { EncryptionService } from "./security/encryption";
import { SqliteStore, type ContextPageCursor } from "./storage/sqlite";
import {
  contextSnapshotSchema,
  type ContextListPage,
  type ContextEntry,
  type ContextSnapshot,
  type CreateContextInput,
  type HistoryEntry,
  type PersistedContextEntry,
  type SearchContextFilters,
  type SnapshotExportOptions,
  type SnapshotImportResult,
  type UpdateContextInput
} from "./types";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const DEFAULT_EXPORT_PAGE_SIZE = 1000;
const MAX_EXPORT_PAGE_SIZE = 5000;
const DEFAULT_EXPORT_HISTORY_LIMIT = 5000;

interface PreparedImportWrite {
  entry: PersistedContextEntry;
  history: HistoryEntry;
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) {
    return [];
  }

  return [...new Set(tags.map((item) => item.trim()).filter((item) => item.length > 0))];
}

function normalizeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  if (!metadata) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const cleanKey = key.trim();
    if (!cleanKey) {
      continue;
    }

    normalized[cleanKey] = String(value);
  }

  return normalized;
}

export class ContextService {
  constructor(
    private readonly store: SqliteStore,
    private readonly encryptionService: EncryptionService
  ) {}

  init(): void {
    this.store.init();
  }

  close(): void {
    this.store.close();
  }

  async addContext(input: CreateContextInput): Promise<ContextEntry> {
    const now = new Date().toISOString();
    const entry: ContextEntry = {
      id: randomUUID(),
      content: input.content,
      encrypted: input.encrypt ?? false,
      sourceTool: input.sourceTool,
      scope: input.scope ?? "global",
      tags: normalizeTags(input.tags),
      metadata: normalizeMetadata(input.metadata),
      version: 1,
      parentId: input.parentId,
      createdAt: now,
      updatedAt: now
    };

    await this.persistEntry(entry);
    this.appendHistory(entry.id, "created", {
      sourceTool: entry.sourceTool,
      scope: entry.scope,
      encrypted: entry.encrypted
    });

    return entry;
  }

  async updateContext(id: string, input: UpdateContextInput): Promise<ContextEntry | null> {
    const existingStored = this.store.getContext(id);
    if (!existingStored) {
      return null;
    }

    const existing = await this.toPublic(existingStored);
    const updated: ContextEntry = {
      ...existing,
      content: input.content ?? existing.content,
      encrypted: input.encrypt ?? existing.encrypted,
      sourceTool: input.sourceTool ?? existing.sourceTool,
      scope: input.scope ?? existing.scope,
      tags: input.tags ? normalizeTags(input.tags) : existing.tags,
      metadata: input.metadata ? normalizeMetadata(input.metadata) : existing.metadata,
      version: existing.version + 1,
      updatedAt: new Date().toISOString()
    };

    await this.persistEntry(updated);
    this.appendHistory(updated.id, "updated", {
      previousVersion: existing.version,
      nextVersion: updated.version
    });

    return updated;
  }

  async getContext(id: string): Promise<ContextEntry | null> {
    const existing = this.store.getContext(id);
    if (!existing) {
      return null;
    }

    return this.toPublic(existing);
  }

  async listContexts(filters: SearchContextFilters = {}): Promise<ContextEntry[]> {
    const page = await this.listContextsPage(filters);
    return page.entries;
  }

  async listContextsPage(filters: SearchContextFilters = {}): Promise<ContextListPage> {
    const baseFilters: Omit<SearchContextFilters, "cursor"> = {
      query: filters.query,
      sourceTool: filters.sourceTool,
      scope: filters.scope,
      tag: filters.tag,
      limit: filters.limit
    };

    return this.fetchContextPage(baseFilters, filters.cursor, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  }

  async deleteContext(id: string): Promise<boolean> {
    const removed = this.store.deleteContext(id);
    if (removed) {
      this.appendHistory(id, "deleted", { removed: true });
    }

    return removed;
  }

  listHistory(entryId?: string, limit = 100): HistoryEntry[] {
    return this.store.listHistory(entryId, limit);
  }

  async exportSnapshot(options: SnapshotExportOptions = {}): Promise<ContextSnapshot> {
    const historyLimit = this.clampLimit(
      options.historyLimit,
      DEFAULT_EXPORT_HISTORY_LIMIT,
      DEFAULT_EXPORT_HISTORY_LIMIT
    );

    if (options.limit !== undefined || options.cursor !== undefined) {
      const page = await this.fetchContextPage(
        { limit: options.limit },
        options.cursor,
        DEFAULT_EXPORT_PAGE_SIZE,
        MAX_EXPORT_PAGE_SIZE
      );

      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        entries: page.entries,
        history: this.store.listHistory(undefined, historyLimit),
        nextCursor: page.nextCursor
      };
    }

    const entries: ContextEntry[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.fetchContextPage(
        { limit: DEFAULT_EXPORT_PAGE_SIZE },
        cursor,
        DEFAULT_EXPORT_PAGE_SIZE,
        MAX_EXPORT_PAGE_SIZE
      );

      entries.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      entries,
      history: this.store.listHistory(undefined, historyLimit)
    };
  }

  async importSnapshot(
    rawSnapshot: unknown,
    policy: ConflictPolicy = "lww"
  ): Promise<SnapshotImportResult> {
    const snapshot = contextSnapshotSchema.parse(rawSnapshot);

    const result: SnapshotImportResult = {
      imported: 0,
      updated: 0,
      skipped: 0,
      duplicated: 0,
      conflicts: 0
    };

    const writes: PreparedImportWrite[] = [];

    for (const incomingEntry of snapshot.entries) {
      const incoming = {
        ...incomingEntry,
        parentId: incomingEntry.parentId ?? undefined
      } as ContextEntry;

      const existingStored = this.store.getContext(incoming.id);
      if (!existingStored) {
        writes.push({
          entry: await this.toPersisted(incoming),
          history: this.buildHistoryEntry(incoming.id, "imported", { mode: "insert" })
        });

        result.imported += 1;
        continue;
      }

      const existing = this.toConflictComparable(existingStored);
      const decision = resolveConflict(existing, incoming, policy);

      result.conflicts += 1;

      if (decision.duplicateIncoming) {
        const duplicate: ContextEntry = {
          ...incoming,
          id: randomUUID(),
          parentId: existing.id,
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        writes.push({
          entry: await this.toPersisted(duplicate),
          history: this.buildHistoryEntry(duplicate.id, "imported", {
            mode: "duplicate",
            conflictWith: existing.id
          })
        });

        result.duplicated += 1;
        continue;
      }

      if (decision.winner === "incoming") {
        writes.push({
          entry: await this.toPersisted(incoming),
          history: this.buildHistoryEntry(incoming.id, "imported", {
            mode: "overwrite",
            reason: decision.reason
          })
        });

        result.updated += 1;
        continue;
      }

      result.skipped += 1;
    }

    this.store.runInTransaction(() => {
      for (const write of writes) {
        this.store.upsertContext(write.entry);
        this.store.appendHistory(write.history);
      }
    });

    return result;
  }

  private async persistEntry(entry: ContextEntry): Promise<void> {
    const persisted = await this.toPersisted(entry);
    this.store.upsertContext(persisted);
  }

  private appendHistory(
    entryId: string,
    action: HistoryEntry["action"],
    payload: Record<string, unknown>
  ): void {
    this.store.appendHistory(this.buildHistoryEntry(entryId, action, payload));
  }

  private buildHistoryEntry(
    entryId: string,
    action: HistoryEntry["action"],
    payload: Record<string, unknown>
  ): HistoryEntry {
    return {
      id: randomUUID(),
      entryId,
      action,
      payload,
      createdAt: new Date().toISOString()
    };
  }

  private async fetchContextPage(
    filters: Omit<SearchContextFilters, "cursor">,
    cursorToken: string | undefined,
    defaultLimit: number,
    maxLimit: number
  ): Promise<ContextListPage> {
    const limit = this.clampLimit(filters.limit, defaultLimit, maxLimit);
    const cursor = this.parseCursorToken(cursorToken);
    const rows = this.store.listContextsPage(
      {
        query: filters.query,
        sourceTool: filters.sourceTool,
        scope: filters.scope,
        tag: filters.tag,
        limit: limit + 1
      },
      cursor,
      maxLimit + 1
    );

    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    const entries = await Promise.all(visibleRows.map((row) => this.toPublic(row)));

    if (!hasMore || visibleRows.length === 0) {
      return { entries };
    }

    const lastRow = visibleRows[visibleRows.length - 1];
    return {
      entries,
      nextCursor: this.createCursorToken(lastRow)
    };
  }

  private clampLimit(value: number | undefined, fallback: number, max: number): number {
    const parsed = Number.isFinite(value) ? Number(value) : fallback;
    return Math.max(1, Math.min(Math.trunc(parsed), max));
  }

  private createCursorToken(entry: Pick<PersistedContextEntry, "updatedAt" | "id">): string {
    return Buffer.from(
      JSON.stringify({
        updatedAt: entry.updatedAt,
        id: entry.id
      }),
      "utf8"
    ).toString("base64url");
  }

  private parseCursorToken(token: string | undefined): ContextPageCursor | undefined {
    if (!token) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
        updatedAt?: unknown;
        id?: unknown;
      };

      if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string") {
        throw new Error("Cursor token is missing required fields.");
      }

      return {
        updatedAt: parsed.updatedAt,
        id: parsed.id
      };
    } catch {
      throw new Error("Invalid cursor token.");
    }
  }

  private toConflictComparable(entry: PersistedContextEntry): ContextEntry {
    return {
      id: entry.id,
      content: "",
      encrypted: entry.encrypted,
      sourceTool: entry.sourceTool,
      scope: entry.scope,
      tags: entry.tags,
      metadata: entry.metadata,
      version: entry.version,
      parentId: entry.parentId ?? undefined,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    };
  }

  private async toPersisted(entry: ContextEntry): Promise<PersistedContextEntry> {
    if (entry.encrypted) {
      const encrypted = await this.encryptionService.encrypt(entry.content);

      return {
        id: entry.id,
        content: encrypted.ciphertext,
        contentIv: `${encrypted.iv}:${encrypted.authTag}`,
        encrypted: true,
        sourceTool: entry.sourceTool,
        scope: entry.scope,
        tags: normalizeTags(entry.tags),
        metadata: normalizeMetadata(entry.metadata),
        version: entry.version,
        parentId: entry.parentId ?? null,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt
      };
    }

    return {
      id: entry.id,
      content: entry.content,
      contentIv: null,
      encrypted: false,
      sourceTool: entry.sourceTool,
      scope: entry.scope,
      tags: normalizeTags(entry.tags),
      metadata: normalizeMetadata(entry.metadata),
      version: entry.version,
      parentId: entry.parentId ?? null,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    };
  }

  private async toPublic(entry: PersistedContextEntry): Promise<ContextEntry> {
    if (!entry.encrypted) {
      return {
        id: entry.id,
        content: entry.content,
        encrypted: false,
        sourceTool: entry.sourceTool,
        scope: entry.scope,
        tags: entry.tags,
        metadata: entry.metadata,
        version: entry.version,
        parentId: entry.parentId ?? undefined,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt
      };
    }

    if (!entry.contentIv) {
      throw new Error(`Encrypted entry ${entry.id} is missing IV metadata.`);
    }

    const [iv, authTag] = entry.contentIv.split(":");
    if (!iv || !authTag) {
      throw new Error(`Encrypted entry ${entry.id} has invalid IV metadata.`);
    }

    const decryptedContent = await this.encryptionService.decrypt({
      ciphertext: entry.content,
      iv,
      authTag
    });

    return {
      id: entry.id,
      content: decryptedContent,
      encrypted: true,
      sourceTool: entry.sourceTool,
      scope: entry.scope,
      tags: entry.tags,
      metadata: entry.metadata,
      version: entry.version,
      parentId: entry.parentId ?? undefined,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    };
  }
}
