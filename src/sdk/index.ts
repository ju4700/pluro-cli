import type { ConflictPolicy } from "../core/conflict-resolution";
import { ensureDataDirectory, resolvePaths } from "../core/config";
import { ContextService } from "../core/context-service";
import { EncryptionService } from "../core/security/encryption";
import { SqliteStore } from "../core/storage/sqlite";
import type {
  ContextListPage,
  ContextEntry,
  ContextSnapshot,
  CreateContextInput,
  SearchContextFilters,
  SnapshotExportOptions,
  SnapshotImportResult,
  UpdateContextInput
} from "../core/types";

export interface PluroClientOptions {
  dataDir?: string;
  dbPath?: string;
  passphrase?: string;
  disableKeychain?: boolean;
}

export class PluroClient {
  private readonly service: ContextService;

  constructor(options: PluroClientOptions = {}) {
    const paths = resolvePaths({
      dataDir: options.dataDir,
      dbPath: options.dbPath
    });

    ensureDataDirectory(paths);

    const store = new SqliteStore(paths.dbPath);
    const encryption = new EncryptionService({
      passphrase: options.passphrase,
      disableKeychain: options.disableKeychain
    });

    this.service = new ContextService(store, encryption);
    this.service.init();
  }

  close(): void {
    this.service.close();
  }

  async addContext(input: CreateContextInput): Promise<ContextEntry> {
    return this.service.addContext(input);
  }

  async updateContext(id: string, input: UpdateContextInput): Promise<ContextEntry | null> {
    return this.service.updateContext(id, input);
  }

  async getContext(id: string): Promise<ContextEntry | null> {
    return this.service.getContext(id);
  }

  async listContexts(filters: SearchContextFilters = {}): Promise<ContextEntry[]> {
    return this.service.listContexts(filters);
  }

  async listContextsPage(filters: SearchContextFilters = {}): Promise<ContextListPage> {
    return this.service.listContextsPage(filters);
  }

  async deleteContext(id: string): Promise<boolean> {
    return this.service.deleteContext(id);
  }

  listHistory(entryId?: string, limit = 100) {
    return this.service.listHistory(entryId, limit);
  }

  async exportSnapshot(options: SnapshotExportOptions = {}): Promise<ContextSnapshot> {
    return this.service.exportSnapshot(options);
  }

  async importSnapshot(
    snapshot: unknown,
    policy: ConflictPolicy = "lww"
  ): Promise<SnapshotImportResult> {
    return this.service.importSnapshot(snapshot, policy);
  }
}
