import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
  ConversationDiscoveryFilters,
  ConversationIngestState,
  DiscoveredConversation,
  HistoryEntry,
  PersistedContextEntry,
  SearchContextFilters,
  SupportedIde
} from "../types";

export interface ContextPageCursor {
  updatedAt: string;
  id: string;
}

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

interface SqliteDiscoveredConversationRow {
  id: string;
  ide: SupportedIde;
  source_file: string;
  source_hash: string;
  conversation_key: string;
  title: string;
  project_path: string | null;
  message_count: number;
  format: string;
  size_bytes: number;
  last_modified_at: string | null;
  scanned_at: string;
  metadata_json: string;
}

interface SqliteConversationIngestRow {
  conversation_id: string;
  source_hash: string;
  last_ingested_at: string;
  result_json: string;
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

      CREATE TABLE IF NOT EXISTS discovered_conversations (
        id TEXT PRIMARY KEY,
        ide TEXT NOT NULL,
        source_file TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        title TEXT NOT NULL,
        project_path TEXT,
        message_count INTEGER NOT NULL,
        format TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        last_modified_at TEXT,
        scanned_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_discovered_conversations_ide_project
        ON discovered_conversations(ide, project_path, scanned_at DESC);
      CREATE INDEX IF NOT EXISTS idx_discovered_conversations_source_file
        ON discovered_conversations(source_file);
      CREATE INDEX IF NOT EXISTS idx_discovered_conversations_scanned_at
        ON discovered_conversations(scanned_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_ingest_state (
        conversation_id TEXT PRIMARY KEY,
        source_hash TEXT NOT NULL,
        last_ingested_at TEXT NOT NULL,
        result_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_ingest_last_ingested_at
        ON conversation_ingest_state(last_ingested_at DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  runInTransaction<T>(operation: () => T): T {
    const transaction = this.db.transaction(operation);
    return transaction();
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
    const rows = this.listContextsPage(
      {
        query: filters.query,
        sourceTool: filters.sourceTool,
        scope: filters.scope,
        tag: filters.tag,
        limit: filters.limit
      },
      undefined,
      500
    );

    return rows;
  }

  listContextsPage(
    filters: Omit<SearchContextFilters, "cursor"> = {},
    cursor?: ContextPageCursor,
    maxLimit = 500
  ): PersistedContextEntry[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    this.applyContextFilters(filters, clauses, params);

    if (cursor) {
      clauses.push(
        "(updated_at < @cursorUpdatedAt OR (updated_at = @cursorUpdatedAt AND id < @cursorId))"
      );
      params.cursorUpdatedAt = cursor.updatedAt;
      params.cursorId = cursor.id;
    }

    const boundedLimit = Math.max(1, Math.min(filters.limit ?? 50, maxLimit));
    params.limit = boundedLimit;

    let query = "SELECT * FROM context_entries";
    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(" AND ")}`;
    }

    query += " ORDER BY updated_at DESC, id DESC LIMIT @limit";

    const statement = this.db.prepare(query);
    const rows = statement.all(params) as SqliteContextRow[];
    return rows.map((row) => this.fromContextRow(row));
  }

  listAllContexts(): PersistedContextEntry[] {
    const statement = this.db.prepare(
      "SELECT * FROM context_entries ORDER BY updated_at DESC, id DESC"
    );
    const rows = statement.all() as SqliteContextRow[];
    return rows.map((row) => this.fromContextRow(row));
  }

  replaceDiscoveredConversations(
    ide: SupportedIde,
    conversations: DiscoveredConversation[]
  ): void {
    this.runInTransaction(() => {
      this.db.prepare("DELETE FROM discovered_conversations WHERE ide = ?").run(ide);

      const insertStatement = this.db.prepare(`
        INSERT INTO discovered_conversations (
          id,
          ide,
          source_file,
          source_hash,
          conversation_key,
          title,
          project_path,
          message_count,
          format,
          size_bytes,
          last_modified_at,
          scanned_at,
          metadata_json
        ) VALUES (
          @id,
          @ide,
          @source_file,
          @source_hash,
          @conversation_key,
          @title,
          @project_path,
          @message_count,
          @format,
          @size_bytes,
          @last_modified_at,
          @scanned_at,
          @metadata_json
        )
      `);

      for (const conversation of conversations) {
        insertStatement.run(this.toDiscoveredConversationRow(conversation));
      }
    });
  }

  listDiscoveredConversations(filters: ConversationDiscoveryFilters = {}): DiscoveredConversation[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.ide) {
      clauses.push("ide = @ide");
      params.ide = filters.ide;
    }

    if (filters.projectPath) {
      clauses.push("project_path = @projectPath");
      params.projectPath = filters.projectPath;
    }

    if (filters.projectConfidence) {
      clauses.push("metadata_json LIKE @projectConfidenceLike");
      params.projectConfidenceLike = `%\"projectConfidence\":\"${filters.projectConfidence}\"%`;
    }

    if (filters.projectSource) {
      clauses.push("metadata_json LIKE @projectSourceLike");
      params.projectSourceLike = `%\"projectSource\":\"${filters.projectSource}\"%`;
    }

    const limit = Math.max(1, Math.min(filters.limit ?? 200, 5000));
    params.limit = limit;

    let query = "SELECT * FROM discovered_conversations";
    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(" AND ")}`;
    }

    query += " ORDER BY scanned_at DESC, source_file ASC, conversation_key ASC LIMIT @limit";

    const statement = this.db.prepare(query);
    const rows = statement.all(params) as SqliteDiscoveredConversationRow[];
    return rows.map((row) => this.fromDiscoveredConversationRow(row));
  }

  getDiscoveredConversation(id: string): DiscoveredConversation | null {
    const statement = this.db.prepare("SELECT * FROM discovered_conversations WHERE id = ?");
    const row = statement.get(id) as SqliteDiscoveredConversationRow | undefined;

    if (!row) {
      return null;
    }

    return this.fromDiscoveredConversationRow(row);
  }

  upsertConversationIngestState(state: ConversationIngestState): void {
    const statement = this.db.prepare(`
      INSERT INTO conversation_ingest_state (
        conversation_id,
        source_hash,
        last_ingested_at,
        result_json
      ) VALUES (
        @conversation_id,
        @source_hash,
        @last_ingested_at,
        @result_json
      )
      ON CONFLICT(conversation_id) DO UPDATE SET
        source_hash = excluded.source_hash,
        last_ingested_at = excluded.last_ingested_at,
        result_json = excluded.result_json
    `);

    statement.run({
      conversation_id: state.conversationId,
      source_hash: state.sourceHash,
      last_ingested_at: state.lastIngestedAt,
      result_json: JSON.stringify(state.result)
    });
  }

  getConversationIngestState(conversationId: string): ConversationIngestState | null {
    const statement = this.db.prepare(
      "SELECT * FROM conversation_ingest_state WHERE conversation_id = ?"
    );

    const row = statement.get(conversationId) as SqliteConversationIngestRow | undefined;
    if (!row) {
      return null;
    }

    return {
      conversationId: row.conversation_id,
      sourceHash: row.source_hash,
      lastIngestedAt: row.last_ingested_at,
      result: JSON.parse(row.result_json) as ConversationIngestState["result"]
    };
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

  private applyContextFilters(
    filters: Omit<SearchContextFilters, "limit" | "cursor">,
    clauses: string[],
    params: Record<string, unknown>
  ): void {
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

  private toDiscoveredConversationRow(
    conversation: DiscoveredConversation
  ): Record<string, unknown> {
    const metadata = {
      ...conversation.metadata,
      ...(conversation.projectConfidence ? { projectConfidence: conversation.projectConfidence } : {}),
      ...(conversation.projectSource ? { projectSource: conversation.projectSource } : {}),
      ...(conversation.projectGroup ? { projectGroup: conversation.projectGroup } : {})
    };

    return {
      id: conversation.id,
      ide: conversation.ide,
      source_file: conversation.sourceFile,
      source_hash: conversation.sourceHash,
      conversation_key: conversation.conversationKey,
      title: conversation.title,
      project_path: conversation.projectPath ?? null,
      message_count: conversation.messageCount,
      format: conversation.format,
      size_bytes: conversation.sizeBytes,
      last_modified_at: conversation.lastModifiedAt ?? null,
      scanned_at: conversation.scannedAt,
      metadata_json: JSON.stringify(metadata)
    };
  }

  private fromDiscoveredConversationRow(
    row: SqliteDiscoveredConversationRow
  ): DiscoveredConversation {
    const metadata = JSON.parse(row.metadata_json) as Record<string, string>;

    return {
      id: row.id,
      ide: row.ide,
      sourceFile: row.source_file,
      sourceHash: row.source_hash,
      conversationKey: row.conversation_key,
      title: row.title,
      projectPath: row.project_path ?? undefined,
      projectConfidence:
        metadata.projectConfidence === "high" ||
        metadata.projectConfidence === "medium" ||
        metadata.projectConfidence === "low"
          ? metadata.projectConfidence
          : undefined,
      projectSource: metadata.projectSource,
      projectGroup: metadata.projectGroup,
      messageCount: row.message_count,
      format: row.format,
      sizeBytes: row.size_bytes,
      lastModifiedAt: row.last_modified_at ?? undefined,
      scannedAt: row.scanned_at,
      metadata
    };
  }
}
