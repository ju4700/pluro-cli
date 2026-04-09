import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

import type { HistoryEntry, PersistedContextEntry, SearchContextFilters } from "../types";

interface SqliteContextRow {
  id: string;
  content: string;
  content_iv: string | null;
  encrypted: number;
  source_tool: string;
  scope: string;
  tags_json: string;
  metadata_json: string;
  version: number;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SqliteHistoryRow {
  id: string;
  entry_id: string;
  action: HistoryEntry["action"];
  payload_json: string;
  created_at: string;
}

export class SqliteStore {
  private readonly db: Database.Database;

  constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
  }

  init(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        content_iv TEXT,
        encrypted INTEGER NOT NULL DEFAULT 0,
        source_tool TEXT NOT NULL,
        scope TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        parent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_context_updated_at ON context_entries(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_context_source_tool ON context_entries(source_tool);
      CREATE INDEX IF NOT EXISTS idx_context_scope ON context_entries(scope);

      CREATE TABLE IF NOT EXISTS context_history (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_history_entry_id ON context_history(entry_id);
      CREATE INDEX IF NOT EXISTS idx_history_created_at ON context_history(created_at DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertContext(entry: PersistedContextEntry): void {
    const statement = this.db.prepare(`
      INSERT INTO context_entries (
        id,
        content,
        content_iv,
        encrypted,
        source_tool,
        scope,
        tags_json,
        metadata_json,
        version,
        parent_id,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @content,
        @content_iv,
        @encrypted,
        @source_tool,
        @scope,
        @tags_json,
        @metadata_json,
        @version,
        @parent_id,
        @created_at,
        @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        content_iv = excluded.content_iv,
        encrypted = excluded.encrypted,
        source_tool = excluded.source_tool,
        scope = excluded.scope,
        tags_json = excluded.tags_json,
        metadata_json = excluded.metadata_json,
        version = excluded.version,
        parent_id = excluded.parent_id,
        updated_at = excluded.updated_at
    `);

    statement.run(this.toRow(entry));
  }

  getContext(id: string): PersistedContextEntry | null {
    const statement = this.db.prepare("SELECT * FROM context_entries WHERE id = ?");
    const row = statement.get(id) as SqliteContextRow | undefined;
    if (!row) {
      return null;
    }

    return this.fromContextRow(row);
  }

  deleteContext(id: string): boolean {
    const statement = this.db.prepare("DELETE FROM context_entries WHERE id = ?");
    const result = statement.run(id);
    return result.changes > 0;
  }

  listContexts(filters: SearchContextFilters = {}): PersistedContextEntry[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.query) {
      clauses.push("(content LIKE @query OR source_tool LIKE @query OR tags_json LIKE @query)");
      params.query = `%${filters.query}%`;
    }

    if (filters.sourceTool) {
      clauses.push("source_tool = @sourceTool");
      params.sourceTool = filters.sourceTool;
    }

    if (filters.scope) {
      clauses.push("scope = @scope");
      params.scope = filters.scope;
    }

    if (filters.tag) {
      clauses.push("tags_json LIKE @tagLike");
      params.tagLike = `%\"${filters.tag}\"%`;
    }

    const boundedLimit = Math.max(1, Math.min(filters.limit ?? 50, 500));
    params.limit = boundedLimit;

    let query = "SELECT * FROM context_entries";
    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(" AND ")}`;
    }

    query += " ORDER BY updated_at DESC LIMIT @limit";

    const statement = this.db.prepare(query);
    const rows = statement.all(params) as SqliteContextRow[];
    return rows.map((row) => this.fromContextRow(row));
  }

  listAllContexts(): PersistedContextEntry[] {
    const statement = this.db.prepare("SELECT * FROM context_entries ORDER BY updated_at DESC");
    const rows = statement.all() as SqliteContextRow[];
    return rows.map((row) => this.fromContextRow(row));
  }

  appendHistory(entry: HistoryEntry): void {
    const statement = this.db.prepare(`
      INSERT INTO context_history (
        id,
        entry_id,
        action,
        payload_json,
        created_at
      ) VALUES (
        @id,
        @entry_id,
        @action,
        @payload_json,
        @created_at
      )
    `);

    statement.run({
      id: entry.id,
      entry_id: entry.entryId,
      action: entry.action,
      payload_json: JSON.stringify(entry.payload ?? {}),
      created_at: entry.createdAt
    });
  }

  listHistory(entryId?: string, limit = 100): HistoryEntry[] {
    const boundedLimit = Math.max(1, Math.min(limit, 5000));

    let query = "SELECT * FROM context_history";
    const params: Record<string, unknown> = { limit: boundedLimit };

    if (entryId) {
      query += " WHERE entry_id = @entryId";
      params.entryId = entryId;
    }

    query += " ORDER BY created_at DESC LIMIT @limit";

    const statement = this.db.prepare(query);
    const rows = statement.all(params) as SqliteHistoryRow[];

    return rows.map((row) => ({
      id: row.id,
      entryId: row.entry_id,
      action: row.action,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at
    }));
  }

  private toRow(entry: PersistedContextEntry): Record<string, unknown> {
    return {
      id: entry.id,
      content: entry.content,
      content_iv: entry.contentIv,
      encrypted: entry.encrypted ? 1 : 0,
      source_tool: entry.sourceTool,
      scope: entry.scope,
      tags_json: JSON.stringify(entry.tags),
      metadata_json: JSON.stringify(entry.metadata),
      version: entry.version,
      parent_id: entry.parentId,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt
    };
  }

  private fromContextRow(row: SqliteContextRow): PersistedContextEntry {
    return {
      id: row.id,
      content: row.content,
      contentIv: row.content_iv,
      encrypted: row.encrypted === 1,
      sourceTool: row.source_tool,
      scope: row.scope,
      tags: JSON.parse(row.tags_json) as string[],
      metadata: JSON.parse(row.metadata_json) as Record<string, string>,
      version: row.version,
      parentId: row.parent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
