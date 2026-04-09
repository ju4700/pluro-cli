#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";

import { Command } from "commander";

import { FileAdapterEngine, type SyncDirection } from "../adapters/file-sync";
import {
  BUILTIN_ADAPTER_PROFILES,
  listPrimaryIdeProfiles,
  type AdapterSyncMode
} from "../adapters/profiles";
import type { ConflictPolicy } from "../core/conflict-resolution";
import { ensureDataDirectory, resolvePaths, type PluroPaths } from "../core/config";
import { ContextService } from "../core/context-service";
import { EncryptionService } from "../core/security/encryption";
import { SqliteStore } from "../core/storage/sqlite";
import type { ContextSnapshot, SearchContextFilters, UpdateContextInput } from "../core/types";
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from "../daemon/protocol";
import { runMcpStdioServer } from "../daemon/mcp-server";
import { startDaemonServer } from "../daemon/server";

interface GlobalCliOptions {
  dataDir?: string;
  dbPath?: string;
  passphrase?: string;
  disableKeychain?: boolean;
}

interface ContextAddCliOptions {
  source: string;
  scope: string;
  tag?: string[];
  meta?: string[];
  encrypt?: boolean;
}

interface ContextListCliOptions {
  source?: string;
  scope?: string;
  tag?: string;
  limit: string;
  cursor?: string;
  paged?: boolean;
}

interface ContextUpdateCliOptions {
  content?: string;
  source?: string;
  scope?: string;
  tag?: string[];
  meta?: string[];
  encrypt?: boolean;
  decrypt?: boolean;
}

interface SnapshotImportCliOptions {
  policy: string;
}

interface SnapshotExportCliOptions {
  limit?: string;
  cursor?: string;
  historyLimit: string;
}

interface HistoryCliOptions {
  limit: string;
}

interface ConnectorInitCliOptions {
  outputDir?: string;
}

interface ConnectorListCliOptions {
  focus: string;
  syncMode?: string;
}

interface ConnectorBootstrapCliOptions {
  outputDir?: string;
  syncMode: string;
}

interface ConnectorStatusCliOptions {
  focus: string;
  syncMode?: string;
  outputDir?: string;
  format: string;
  failOnWarning?: boolean;
  failOnError?: boolean;
}

interface ConnectorStatusTarget {
  adapterFile: string;
  expectedProfileId?: string;
  expectedProfileName?: string;
  expectedTool?: string;
  expectedSyncMode?: AdapterSyncMode;
}

interface ConnectorStatusSummary {
  total: number;
  healthy: number;
  warning: number;
  error: number;
}

interface ConnectorStatusRow {
  adapterFile: string;
  profileId?: string;
  expectedProfileId?: string;
  expectedProfileName?: string;
  tool?: string;
  expectedTool?: string;
  syncMode?: string;
  expectedSyncMode?: string;
  configured?: boolean;
  health: string;
  checkedAt?: string;
  errors?: string[];
  warnings?: string[];
  issues?: string[];
}

type StatusOutputFormat = "json" | "table" | "summary";

interface ConnectorStatusTablePayload {
  focus: string;
  syncMode: string;
  checkedAt: string;
  summary: ConnectorStatusSummary;
  statuses: ConnectorStatusRow[];
}

interface DaemonHealthTablePayload {
  service?: string;
  timestamp?: string;
}

interface ConnectorSyncCliOptions {
  direction: string;
}

interface ConnectorWatchCliOptions {
  direction: string;
  debounceMs: string;
  maxRetries: string;
  retryBaseMs: string;
  quarantineInvalid?: boolean;
  runInitial?: boolean;
}

interface DaemonRunCliOptions {
  host: string;
  port: string;
}

interface DaemonStatusCliOptions {
  host: string;
  port: string;
  connectors?: boolean;
  focus: string;
  syncMode?: string;
  compact?: boolean;
  format: string;
  failOnWarning?: boolean;
  failOnError?: boolean;
}

interface StatusFailureOptions {
  failOnWarning?: boolean;
  failOnError?: boolean;
}

interface SyncRetryOptions {
  maxRetries: number;
  retryBaseMs: number;
}

interface SyncRetryEvent {
  attempt: number;
  retryInMs: number;
  error: string;
}

interface InvalidInboundRecovery {
  quarantinedFile: string;
  movedOriginal: boolean;
  resetInboundFile: boolean;
}

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printText(payload: string): void {
  process.stdout.write(`${payload}\n`);
}

function parseIntValue(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed;
}

function parseOptionalIntValue(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return parsed;
}

function parseMetadata(values?: string[]): Record<string, string> {
  if (!values || values.length === 0) {
    return {};
  }

  const metadata: Record<string, string> = {};

  for (const pair of values) {
    const splitIndex = pair.indexOf("=");
    if (splitIndex <= 0) {
      throw new Error(`Invalid metadata pair: ${pair}. Expected key=value.`);
    }

    const key = pair.slice(0, splitIndex).trim();
    const value = pair.slice(splitIndex + 1).trim();

    if (!key) {
      throw new Error(`Invalid metadata key in pair: ${pair}`);
    }

    metadata[key] = value;
  }

  return metadata;
}

function parseSyncDirection(value: string): SyncDirection {
  if (value === "import" || value === "export" || value === "bidirectional") {
    return value;
  }

  throw new Error(`Invalid sync direction: ${value}`);
}

function parseAdapterSyncMode(value: string): AdapterSyncMode {
  if (value === "file-sync" || value === "mcp") {
    return value;
  }

  throw new Error(`Invalid sync mode: ${value}. Expected file-sync or mcp.`);
}

function parseConnectorFocus(value: string): "all" | "primary" {
  const focus = value.trim().toLowerCase();

  if (focus === "all" || focus === "primary") {
    return focus;
  }

  throw new Error(`Invalid focus: ${value}. Expected all or primary.`);
}

function parseStatusOutputFormat(value: string): StatusOutputFormat {
  const normalized = value.trim().toLowerCase();

  if (normalized === "json" || normalized === "table" || normalized === "summary") {
    return normalized;
  }

  throw new Error(`Invalid format: ${value}. Expected json, table, or summary.`);
}

function toOverallHealth(summary: ConnectorStatusSummary): "healthy" | "warning" | "error" {
  if (summary.error > 0) {
    return "error";
  }

  if (summary.warning > 0) {
    return "warning";
  }

  return "healthy";
}

function shouldFailStatusCheck(
  summary: ConnectorStatusSummary,
  options: StatusFailureOptions
): boolean {
  if (options.failOnError && summary.error > 0) {
    return true;
  }

  if (options.failOnWarning && (summary.warning > 0 || summary.error > 0)) {
    return true;
  }

  return false;
}

function applyStatusFailurePolicy(
  summary: ConnectorStatusSummary,
  options: StatusFailureOptions
): void {
  if (shouldFailStatusCheck(summary, options)) {
    process.exitCode = 1;
  }
}

function formatDaemonHealthTable(url: string, payload: DaemonHealthTablePayload): string {
  const service = payload.service ?? "unknown";
  const timestamp = payload.timestamp ?? "unknown";

  return [
    "Daemon Health",
    `URL: ${url}`,
    `Service: ${service}`,
    `Timestamp: ${timestamp}`,
    "Status: OK"
  ].join("\n");
}

function formatDaemonHealthSummary(url: string, payload: DaemonHealthTablePayload): string {
  const service = payload.service ?? "unknown";
  const timestamp = payload.timestamp ?? "unknown";

  return `daemon_health status=ok service=${service} url=${url} timestamp=${timestamp}`;
}

function formatConnectorStatusSummary(payload: ConnectorStatusTablePayload): string {
  const overall = toOverallHealth(payload.summary);

  return [
    "connector_status",
    `focus=${payload.focus}`,
    `sync=${payload.syncMode}`,
    `total=${payload.summary.total}`,
    `healthy=${payload.summary.healthy}`,
    `warning=${payload.summary.warning}`,
    `error=${payload.summary.error}`,
    `overall=${overall}`,
    `checkedAt=${payload.checkedAt}`
  ].join(" ");
}

function truncateCell(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  if (width <= 1) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 1)}~`;
}

function padCell(value: string, width: number): string {
  return truncateCell(value, width).padEnd(width, " ");
}

function toHealthToken(health: string): string {
  if (health === "healthy") {
    return "OK";
  }

  if (health === "warning") {
    return "WARN";
  }

  return "ERR";
}

function collectStatusIssues(status: ConnectorStatusRow): string[] {
  if (status.issues && status.issues.length > 0) {
    return status.issues;
  }

  return [...(status.errors ?? []), ...(status.warnings ?? [])];
}

function formatConnectorStatusTable(payload: ConnectorStatusTablePayload): string {
  const lines: string[] = [];

  lines.push(`Connector Status (${payload.focus}, sync=${payload.syncMode})`);
  lines.push(`Checked: ${payload.checkedAt}`);
  lines.push(
    `Summary: total=${payload.summary.total} healthy=${payload.summary.healthy} warning=${payload.summary.warning} error=${payload.summary.error}`
  );
  lines.push("");

  const header = [
    padCell("HEALTH", 7),
    padCell("PROFILE", 24),
    padCell("MODE", 10),
    padCell("TOOL", 16),
    padCell("ISSUES", 6),
    "ADAPTER"
  ].join(" ");

  const divider = [
    "-".repeat(7),
    "-".repeat(24),
    "-".repeat(10),
    "-".repeat(16),
    "-".repeat(6),
    "-".repeat(28)
  ].join(" ");

  lines.push(header);
  lines.push(divider);

  for (const status of payload.statuses) {
    const profile = status.expectedProfileId ?? status.profileId ?? "-";
    const tool = status.tool ?? status.expectedTool ?? "-";
    const mode = status.syncMode ?? status.expectedSyncMode ?? "-";
    const issues = collectStatusIssues(status).length;
    const adapterName = path.basename(status.adapterFile);

    lines.push(
      [
        padCell(toHealthToken(status.health), 7),
        padCell(profile, 24),
        padCell(mode, 10),
        padCell(tool, 16),
        padCell(String(issues), 6),
        truncateCell(adapterName, 28)
      ].join(" ")
    );
  }

  const issueLines: string[] = [];

  for (const status of payload.statuses) {
    const issues = collectStatusIssues(status);
    if (issues.length === 0) {
      continue;
    }

    const label = status.expectedProfileId ?? status.profileId ?? path.basename(status.adapterFile);
    for (const issue of issues) {
      issueLines.push(`- ${label}: ${issue}`);
    }
  }

  if (issueLines.length > 0) {
    lines.push("");
    lines.push("Issues:");
    lines.push(...issueLines.slice(0, 20));

    if (issueLines.length > 20) {
      lines.push(`- ... ${issueLines.length - 20} more`);
    }
  }

  return lines.join("\n");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInvalidSnapshotError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "SyntaxError" || error.name === "ZodError";
}

function isRetryableSyncError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (isInvalidSnapshotError(error)) {
    return true;
  }

  return /SQLITE_BUSY|database is locked|ENOENT|EACCES|EPERM|EBUSY/i.test(error.message);
}

function createEmptySnapshot(): ContextSnapshot {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    entries: [],
    history: []
  };
}

async function runWithRetry<T>(
  operation: () => Promise<T>,
  options: SyncRetryOptions,
  onRetry: (event: SyncRetryEvent) => void
): Promise<T> {
  let retries = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableSyncError(error) || retries >= options.maxRetries) {
        throw error;
      }

      const retryInMs = Math.max(20, options.retryBaseMs * 2 ** retries);
      retries += 1;

      onRetry({
        attempt: retries,
        retryInMs,
        error: getErrorMessage(error)
      });

      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryInMs);
      });
    }
  }
}

function quarantineInvalidInboundSnapshot(
  engine: FileAdapterEngine,
  inboundFile: string
): InvalidInboundRecovery | null {
  if (!fs.existsSync(inboundFile)) {
    return null;
  }

  const quarantineDir = path.join(path.dirname(inboundFile), ".pluro-invalid");
  fs.mkdirSync(quarantineDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const quarantinedFile = path.join(
    quarantineDir,
    `${path.basename(inboundFile)}.${stamp}.invalid.json`
  );

  let movedOriginal = false;

  try {
    fs.renameSync(inboundFile, quarantinedFile);
    movedOriginal = true;
  } catch {
    try {
      fs.copyFileSync(inboundFile, quarantinedFile);
    } catch {
      return null;
    }
  }

  let resetInboundFile = false;

  try {
    engine.writeSnapshot(inboundFile, createEmptySnapshot());
    resetInboundFile = true;
  } catch {
    resetInboundFile = false;
  }

  return {
    quarantinedFile,
    movedOriginal,
    resetInboundFile
  };
}

function includesImport(direction: SyncDirection): boolean {
  return direction === "import" || direction === "bidirectional";
}

function includesExport(direction: SyncDirection): boolean {
  return direction === "export" || direction === "bidirectional";
}

async function runAdapterSyncOnce(
  service: ContextService,
  engine: FileAdapterEngine,
  adapterFilePath: string,
  direction: SyncDirection
): Promise<Record<string, unknown>> {
  const config = engine.readAdapterConfig(adapterFilePath);

  if (config.syncMode !== "file-sync") {
    throw new Error(
      `Adapter ${adapterFilePath} uses sync mode '${config.syncMode}'. Use 'pluro daemon mcp' for MCP profiles.`
    );
  }

  const result: Record<string, unknown> = {
    adapterFile: adapterFilePath,
    direction,
    mode: config.syncMode,
    profileId: config.profileId
  };

  if (includesImport(direction)) {
    if (!config.inboundSnapshotFile) {
      throw new Error("Adapter is missing inboundSnapshotFile for import sync.");
    }

    const inboundFile = engine.resolveAdapterFilePath(adapterFilePath, config.inboundSnapshotFile);

    if (!fs.existsSync(inboundFile)) {
      result.import = {
        file: inboundFile,
        skipped: true,
        reason: "missing_inbound_snapshot"
      };
    } else {
      const snapshot = engine.readSnapshot(inboundFile);
      const importResult = await service.importSnapshot(snapshot, config.conflictPolicy);

      result.import = {
        file: inboundFile,
        ...importResult
      };
    }
  }

  if (includesExport(direction)) {
    if (!config.outboundSnapshotFile) {
      throw new Error("Adapter is missing outboundSnapshotFile for export sync.");
    }

    const outboundFile = engine.resolveAdapterFilePath(adapterFilePath, config.outboundSnapshotFile);
    const snapshot = await service.exportSnapshot();
    engine.writeSnapshot(outboundFile, snapshot);

    result.export = {
      file: outboundFile,
      entries: snapshot.entries.length,
      exportedAt: snapshot.exportedAt
    };
  }

  return result;
}

function getGlobalOptions(command: Command): GlobalCliOptions {
  const options = command.optsWithGlobals() as Partial<GlobalCliOptions>;
  return {
    dataDir: options.dataDir,
    dbPath: options.dbPath,
    passphrase: options.passphrase,
    disableKeychain: options.disableKeychain
  };
}

async function withService(
  command: Command,
  handler: (service: ContextService, paths: PluroPaths) => Promise<void>
): Promise<void> {
  const options = getGlobalOptions(command);
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

  const service = new ContextService(store, encryption);
  service.init();

  try {
    await handler(service, paths);
  } finally {
    service.close();
  }
}

const program = new Command();

program
  .name("pluro")
  .description("Local-first shared context CLI for LLMs and agentic tools")
  .version("0.2.0")
  .option("--data-dir <path>", "Path to pluro data directory")
  .option("--db-path <path>", "Path to SQLite context database")
  .option("--passphrase <passphrase>", "Fallback passphrase when keychain is unavailable")
  .option("--disable-keychain", "Disable OS keychain integration", false);

const contextCommand = program.command("context").description("Manage shared context entries");

contextCommand
  .command("add")
  .description("Create a new context entry")
  .argument("<content>", "Context content")
  .requiredOption("--source <tool>", "Source tool identifier")
  .option("--scope <scope>", "Scope for the entry", "global")
  .option("--tag <tag...>", "Tags for indexing")
  .option("--meta <key=value...>", "Metadata key=value pairs")
  .option("--encrypt", "Encrypt content at rest", false)
  .action(async (content: string, options: ContextAddCliOptions, command: Command) => {
    await withService(command, async (service) => {
      const entry = await service.addContext({
        content,
        sourceTool: options.source,
        scope: options.scope,
        tags: options.tag,
        metadata: parseMetadata(options.meta),
        encrypt: Boolean(options.encrypt)
      });

      printJson(entry);
    });
  });

contextCommand
  .command("list")
  .description("List context entries")
  .argument("[query]", "Optional text query")
  .option("--source <tool>", "Filter by source tool")
  .option("--scope <scope>", "Filter by scope")
  .option("--tag <tag>", "Filter by tag")
  .option("--limit <number>", "Maximum number of records", "50")
  .option("--cursor <cursor>", "Pagination cursor token")
  .option("--paged", "Return entries with nextCursor token", false)
  .action(async (query: string | undefined, options: ContextListCliOptions, command: Command) => {
    await withService(command, async (service) => {
      const filters: SearchContextFilters = {
        query,
        sourceTool: options.source,
        scope: options.scope,
        tag: options.tag,
        limit: parseIntValue(String(options.limit), 50),
        cursor: options.cursor
      };

      const page = await service.listContextsPage(filters);

      if (options.paged || options.cursor) {
        printJson(page);
        return;
      }

      printJson(page.entries);
    });
  });

contextCommand
  .command("get")
  .description("Get one context entry")
  .argument("<id>", "Entry id")
  .action(async (id: string, _options: unknown, command: Command) => {
    await withService(command, async (service) => {
      const entry = await service.getContext(id);
      if (!entry) {
        throw new Error(`Context entry not found: ${id}`);
      }

      printJson(entry);
    });
  });

contextCommand
  .command("update")
  .description("Update an existing context entry")
  .argument("<id>", "Entry id")
  .option("--content <content>", "Replace content")
  .option("--source <tool>", "Replace source tool")
  .option("--scope <scope>", "Replace scope")
  .option("--tag <tag...>", "Replace tags")
  .option("--meta <key=value...>", "Replace metadata")
  .option("--encrypt", "Store encrypted")
  .option("--decrypt", "Store unencrypted")
  .action(async (id: string, options: ContextUpdateCliOptions, command: Command) => {
    const encrypt = options.encrypt ? true : options.decrypt ? false : undefined;

    const payload: UpdateContextInput = {};
    if (options.content !== undefined) {
      payload.content = options.content;
    }
    if (options.source !== undefined) {
      payload.sourceTool = options.source;
    }
    if (options.scope !== undefined) {
      payload.scope = options.scope;
    }
    if (options.tag !== undefined) {
      payload.tags = options.tag;
    }
    if (options.meta !== undefined) {
      payload.metadata = parseMetadata(options.meta);
    }
    if (encrypt !== undefined) {
      payload.encrypt = encrypt;
    }

    if (Object.keys(payload).length === 0) {
      throw new Error("No update fields were provided.");
    }

    await withService(command, async (service) => {
      const entry = await service.updateContext(id, payload);
      if (!entry) {
        throw new Error(`Context entry not found: ${id}`);
      }

      printJson(entry);
    });
  });

contextCommand
  .command("delete")
  .description("Delete a context entry")
  .argument("<id>", "Entry id")
  .action(async (id: string, _options: unknown, command: Command) => {
    await withService(command, async (service) => {
      const deleted = await service.deleteContext(id);
      printJson({ id, deleted });
    });
  });

const snapshotCommand = program.command("snapshot").description("Import and export snapshots");

snapshotCommand
  .command("export")
  .description("Export all context to a snapshot file")
  .argument("<file>", "Output file path")
  .option("--limit <number>", "Maximum entries in paged export")
  .option("--cursor <cursor>", "Pagination cursor token")
  .option("--history-limit <number>", "Maximum history rows to include", "5000")
  .action(async (file: string, options: SnapshotExportCliOptions, command: Command) => {
    await withService(command, async (service) => {
      const snapshot = await service.exportSnapshot({
        limit: parseOptionalIntValue(options.limit),
        cursor: options.cursor,
        historyLimit: parseIntValue(String(options.historyLimit), 5000)
      });

      const filePath = path.resolve(file);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

      printJson({
        ok: true,
        file: filePath,
        entries: snapshot.entries.length,
        exportedAt: snapshot.exportedAt,
        nextCursor: snapshot.nextCursor
      });
    });
  });

snapshotCommand
  .command("import")
  .description("Import a snapshot file")
  .argument("<file>", "Input file path")
  .option("--policy <policy>", "Conflict policy: lww or keep-both", "lww")
  .action(async (file: string, options: SnapshotImportCliOptions, command: Command) => {
    await withService(command, async (service) => {
      const filePath = path.resolve(file);
      const payload = fs.readFileSync(filePath, "utf8");
      const snapshot = JSON.parse(payload) as unknown;
      const policy = options.policy as ConflictPolicy;

      if (policy !== "lww" && policy !== "keep-both") {
        throw new Error(`Invalid conflict policy: ${policy}`);
      }

      const result = await service.importSnapshot(snapshot, policy);
      printJson({ ok: true, file: filePath, result });
    });
  });

program
  .command("history")
  .description("Show context change history")
  .argument("[entryId]", "Optional entry id")
  .option("--limit <number>", "Maximum history rows", "100")
  .action(async (entryId: string | undefined, options: HistoryCliOptions, command: Command) => {
    await withService(command, async (service) => {
      const history = service.listHistory(entryId, parseIntValue(String(options.limit), 100));
      printJson(history);
    });
  });

const connectorCommand = program.command("connector").description("Manage tool adapter profiles");

connectorCommand
  .command("list")
  .description("List available adapter profiles")
  .option("--focus <focus>", "all or primary", "all")
  .option("--sync-mode <mode>", "Filter by sync mode: file-sync or mcp")
  .action((options: ConnectorListCliOptions) => {
    const focus = parseConnectorFocus(String(options.focus));
    const syncMode = options.syncMode ? parseAdapterSyncMode(options.syncMode) : undefined;

    const profiles =
      focus === "primary"
        ? listPrimaryIdeProfiles(syncMode)
        : BUILTIN_ADAPTER_PROFILES.filter(
            (profile) => !syncMode || profile.syncMode === syncMode
          );

    printJson({
      focus,
      syncMode: syncMode ?? "all",
      profiles
    });
  });

connectorCommand
  .command("status")
  .description("Show adapter health and sync readiness at a glance")
  .argument("[adapterFiles...]", "Optional adapter config files to inspect")
  .option("--focus <focus>", "all or primary (used when no adapter files are passed)", "primary")
  .option("--sync-mode <mode>", "Filter discovered profiles by sync mode: file-sync or mcp")
  .option("--output-dir <path>", "Base directory for profile discovery")
  .option("--format <format>", "json, table, or summary", "json")
  .option("--fail-on-warning", "Exit with code 1 when warnings or errors are detected", false)
  .option("--fail-on-error", "Exit with code 1 when errors are detected", false)
  .action(
    (
      adapterFiles: string[] | undefined,
      options: ConnectorStatusCliOptions,
      command: Command
    ) => {
      const focus = parseConnectorFocus(String(options.focus));
      const syncMode = options.syncMode ? parseAdapterSyncMode(options.syncMode) : undefined;
      const outputFormat = parseStatusOutputFormat(options.format);
      const requestedFiles = Array.isArray(adapterFiles)
        ? adapterFiles
        : adapterFiles
          ? [adapterFiles]
          : [];

      const globals = getGlobalOptions(command);
      const paths = resolvePaths({ dataDir: globals.dataDir, dbPath: globals.dbPath });
      const outputDir = options.outputDir ? path.resolve(options.outputDir) : paths.dataDir;
      const engine = new FileAdapterEngine(outputDir);

      const targets: ConnectorStatusTarget[] =
        requestedFiles.length > 0
          ? requestedFiles.map((filePath) => ({
              adapterFile: path.resolve(filePath)
            }))
          : (focus === "primary"
              ? listPrimaryIdeProfiles(syncMode)
              : BUILTIN_ADAPTER_PROFILES.filter(
                  (profile) => !syncMode || profile.syncMode === syncMode
                )
            ).map((profile) => ({
              adapterFile: path.join(outputDir, profile.suggestedPath, "pluro.adapter.json"),
              expectedProfileId: profile.id,
              expectedProfileName: profile.name,
              expectedTool: profile.tool,
              expectedSyncMode: profile.syncMode
            }));

      const statuses: ConnectorStatusRow[] = targets.map((target) => ({
        expectedProfileId: target.expectedProfileId,
        expectedProfileName: target.expectedProfileName,
        expectedTool: target.expectedTool,
        expectedSyncMode: target.expectedSyncMode,
        ...engine.getAdapterStatus(target.adapterFile)
      }));

      const summary: ConnectorStatusSummary = {
        total: statuses.length,
        healthy: statuses.filter((status) => status.health === "healthy").length,
        warning: statuses.filter((status) => status.health === "warning").length,
        error: statuses.filter((status) => status.health === "error").length
      };

      const responsePayload = {
        ok: true,
        focus: requestedFiles.length > 0 ? "custom" : focus,
        syncMode: syncMode ?? "all",
        outputDir,
        checkedAt: new Date().toISOString(),
        summary,
        statuses
      };

      const statusPayload: ConnectorStatusTablePayload = {
        focus: responsePayload.focus,
        syncMode: responsePayload.syncMode,
        checkedAt: responsePayload.checkedAt,
        summary: responsePayload.summary,
        statuses: responsePayload.statuses
      };

      if (outputFormat === "summary") {
        printText(formatConnectorStatusSummary(statusPayload));
        applyStatusFailurePolicy(responsePayload.summary, options);
        return;
      }

      if (outputFormat === "table") {
        printText(formatConnectorStatusTable(statusPayload));
        applyStatusFailurePolicy(responsePayload.summary, options);
        return;
      }

      printJson(responsePayload);
      applyStatusFailurePolicy(responsePayload.summary, options);
    }
  );

connectorCommand
  .command("bootstrap")
  .description(
    "Initialize adapter templates for primary IDEs (Cursor, VS Code Copilot, Antigravity)"
  )
  .option("--output-dir <path>", "Directory for adapter config files")
  .option("--sync-mode <mode>", "file-sync or mcp", "file-sync")
  .action((options: ConnectorBootstrapCliOptions, command: Command) => {
    const globals = getGlobalOptions(command);
    const paths = resolvePaths({ dataDir: globals.dataDir, dbPath: globals.dbPath });
    const outputDir = options.outputDir ? path.resolve(options.outputDir) : paths.dataDir;
    const syncMode = parseAdapterSyncMode(options.syncMode);

    const engine = new FileAdapterEngine(outputDir);
    const profiles = listPrimaryIdeProfiles(syncMode);
    const templates = profiles.map((profile) => ({
      profileId: profile.id,
      profileName: profile.name,
      ...engine.createProfileTemplate(profile.id)
    }));

    printJson({
      ok: true,
      focus: "primary",
      targetIdeProfiles: ["cursor", "vscode-copilot", "antigravity"],
      syncMode,
      templates
    });
  });

connectorCommand
  .command("init")
  .description("Create an adapter profile template file")
  .argument("<profileId>", "Adapter profile id")
  .option("--output-dir <path>", "Directory for adapter config files")
  .action((profileId: string, options: ConnectorInitCliOptions, command: Command) => {
    const globals = getGlobalOptions(command);
    const paths = resolvePaths({ dataDir: globals.dataDir, dbPath: globals.dbPath });
    const outputDir = options.outputDir ? path.resolve(options.outputDir) : paths.dataDir;

    const engine = new FileAdapterEngine(outputDir);
    const template = engine.createProfileTemplate(profileId);
    printJson({
      ok: true,
      profileId,
      adapterFile: template.adapterFile,
      createdFiles: template.createdFiles
    });
  });

connectorCommand
  .command("sync")
  .description("Run one-shot adapter synchronization")
  .argument("<adapterFile>", "Path to adapter config JSON")
  .option("--direction <direction>", "import, export, or bidirectional", "bidirectional")
  .action(async (adapterFile: string, options: ConnectorSyncCliOptions, command: Command) => {
    const direction = parseSyncDirection(String(options.direction));

    await withService(command, async (service, paths) => {
      const engine = new FileAdapterEngine(paths.dataDir);
      const adapterFilePath = path.resolve(adapterFile);
      const result = await runAdapterSyncOnce(service, engine, adapterFilePath, direction);
      printJson({ ok: true, result });
    });
  });

connectorCommand
  .command("watch")
  .description("Watch adapter files and database changes for continuous sync")
  .argument("<adapterFile>", "Path to adapter config JSON")
  .option("--direction <direction>", "import, export, or bidirectional", "bidirectional")
  .option("--debounce-ms <number>", "Debounce delay for file events", "500")
  .option("--max-retries <number>", "Retry attempts for transient sync failures", "3")
  .option("--retry-base-ms <number>", "Base delay in milliseconds for retry backoff", "200")
  .option("--no-quarantine-invalid", "Do not quarantine invalid inbound snapshot files")
  .option("--no-run-initial", "Skip initial one-shot sync before watching")
  .action(async (adapterFile: string, options: ConnectorWatchCliOptions, command: Command) => {
    const direction = parseSyncDirection(String(options.direction));
    const debounceMs = parseIntValue(String(options.debounceMs), 500);
    const maxRetries = Math.max(0, parseIntValue(String(options.maxRetries), 3));
    const retryBaseMs = Math.max(20, parseIntValue(String(options.retryBaseMs), 200));
    const quarantineInvalid = options.quarantineInvalid !== false;
    const runInitial = options.runInitial !== false;

    await withService(command, async (service, paths) => {
      const engine = new FileAdapterEngine(paths.dataDir);
      const adapterFilePath = path.resolve(adapterFile);
      const config = engine.readAdapterConfig(adapterFilePath);

      if (config.syncMode !== "file-sync") {
        throw new Error(
          `Adapter ${adapterFilePath} uses sync mode '${config.syncMode}'. Use 'pluro daemon mcp' for MCP mode.`
        );
      }

      if (runInitial) {
        try {
          const initial = await runWithRetry(
            async () => runAdapterSyncOnce(service, engine, adapterFilePath, direction),
            {
              maxRetries,
              retryBaseMs
            },
            (retryEvent) => {
              printJson({
                event: "initial-sync-retry",
                direction,
                attempt: retryEvent.attempt,
                retryInMs: retryEvent.retryInMs,
                error: retryEvent.error
              });
            }
          );

          printJson({ event: "initial-sync", result: initial });
        } catch (error) {
          const message = getErrorMessage(error);
          printJson({ event: "initial-sync-error", error: message });
        }
      }

      const stops: Array<() => void> = [];

      if (includesImport(direction)) {
        if (!config.inboundSnapshotFile) {
          throw new Error("Adapter is missing inboundSnapshotFile for import watch mode.");
        }

        const inboundFile = engine.resolveAdapterFilePath(adapterFilePath, config.inboundSnapshotFile);
        const stopInbound = engine.watchFile(
          inboundFile,
          async () => {
            try {
              const result = await runWithRetry(
                async () => runAdapterSyncOnce(service, engine, adapterFilePath, "import"),
                {
                  maxRetries,
                  retryBaseMs
                },
                (retryEvent) => {
                  printJson({
                    event: "import-sync-retry",
                    file: inboundFile,
                    attempt: retryEvent.attempt,
                    retryInMs: retryEvent.retryInMs,
                    error: retryEvent.error
                  });
                }
              );

              printJson({ event: "import-sync", result });
            } catch (error) {
              const message = getErrorMessage(error);

              if (quarantineInvalid && isInvalidSnapshotError(error)) {
                const recovery = quarantineInvalidInboundSnapshot(engine, inboundFile);

                if (recovery) {
                  printJson({
                    event: "import-sync-invalid-snapshot-recovered",
                    file: inboundFile,
                    quarantinedFile: recovery.quarantinedFile,
                    movedOriginal: recovery.movedOriginal,
                    resetInboundFile: recovery.resetInboundFile,
                    error: message
                  });
                  return;
                }
              }

              printJson({ event: "import-sync-error", error: message });
            }
          },
          debounceMs
        );

        stops.push(stopInbound);
      }

      if (includesExport(direction)) {
        const dbRelatedFiles = [paths.dbPath, `${paths.dbPath}-wal`, `${paths.dbPath}-shm`];

        for (const filePath of dbRelatedFiles) {
          const stopDbWatch = engine.watchFile(
            filePath,
            async () => {
              try {
                const result = await runWithRetry(
                  async () => runAdapterSyncOnce(service, engine, adapterFilePath, "export"),
                  {
                    maxRetries,
                    retryBaseMs
                  },
                  (retryEvent) => {
                    printJson({
                      event: "export-sync-retry",
                      triggerFile: filePath,
                      attempt: retryEvent.attempt,
                      retryInMs: retryEvent.retryInMs,
                      error: retryEvent.error
                    });
                  }
                );

                printJson({ event: "export-sync", triggerFile: filePath, result });
              } catch (error) {
                const message = getErrorMessage(error);
                printJson({ event: "export-sync-error", triggerFile: filePath, error: message });
              }
            },
            debounceMs
          );

          stops.push(stopDbWatch);
        }
      }

      printJson({
        ok: true,
        watching: true,
        adapterFile: adapterFilePath,
        direction,
        debounceMs,
        maxRetries,
        retryBaseMs,
        quarantineInvalid,
        dbPath: paths.dbPath
      });

      await new Promise<void>((resolve) => {
        const shutdown = () => {
          for (const stop of stops) {
            stop();
          }

          resolve();
        };

        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
    });
  });

const daemonCommand = program.command("daemon").description("Run and inspect the local daemon");

daemonCommand
  .command("run")
  .description("Run daemon in foreground")
  .option("--host <host>", "Host to bind", DEFAULT_DAEMON_HOST)
  .option("--port <number>", "Port to bind", String(DEFAULT_DAEMON_PORT))
  .action(async (options: DaemonRunCliOptions, command: Command) => {
    await withService(command, async (service, paths) => {
      const host = options.host;
      const port = parseIntValue(String(options.port), DEFAULT_DAEMON_PORT);
      const server = await startDaemonServer(service, { host, port, dataDir: paths.dataDir });

      printJson({
        ok: true,
        message: "pluro daemon running",
        host,
        port
      });

      await new Promise<void>((resolve) => {
        const shutdown = () => {
          server.close(() => resolve());
        };

        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
    });
  });

daemonCommand
  .command("status")
  .description("Check daemon health endpoint")
  .option("--host <host>", "Host to query", DEFAULT_DAEMON_HOST)
  .option("--port <number>", "Port to query", String(DEFAULT_DAEMON_PORT))
  .option("--connectors", "Fetch connector health summary", false)
  .option("--focus <focus>", "all or primary for connector status", "primary")
  .option("--sync-mode <mode>", "Filter connector status by sync mode: file-sync or mcp")
  .option("--compact", "Compact connector status output", false)
  .option("--format <format>", "json, table, or summary", "json")
  .option("--fail-on-warning", "Exit with code 1 when connector status has warnings/errors", false)
  .option("--fail-on-error", "Exit with code 1 when connector status has errors", false)
  .action(async (options: DaemonStatusCliOptions) => {
    const host = options.host;
    const port = parseIntValue(String(options.port), DEFAULT_DAEMON_PORT);
    const focus = parseConnectorFocus(options.focus);
    const outputFormat = parseStatusOutputFormat(options.format);

    let url = `http://${host}:${port}/health`;

    if (options.connectors) {
      const params = new URLSearchParams();
      params.set("focus", focus);

      if (options.syncMode) {
        params.set("syncMode", parseAdapterSyncMode(options.syncMode));
      }

      if (options.compact) {
        params.set("compact", "1");
      }

      url = `http://${host}:${port}/connectors/status?${params.toString()}`;
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1500)
      });

      if (!response.ok) {
        throw new Error(`Unexpected status: ${response.status}`);
      }

      const payload = (await response.json()) as unknown;

      if (options.connectors) {
        const connectorPayload = payload as {
          checkedAt?: string;
          syncMode?: string;
          summary: ConnectorStatusSummary;
          statuses: ConnectorStatusRow[];
        };

        const statusPayload: ConnectorStatusTablePayload = {
          focus,
          syncMode: connectorPayload.syncMode ?? (options.syncMode ?? "all"),
          checkedAt: connectorPayload.checkedAt ?? new Date().toISOString(),
          summary: connectorPayload.summary,
          statuses: connectorPayload.statuses
        };

        if (outputFormat === "summary") {
          printText(formatConnectorStatusSummary(statusPayload));
          applyStatusFailurePolicy(statusPayload.summary, options);
          return;
        }

        if (outputFormat === "table") {
          printText(formatConnectorStatusTable(statusPayload));
          applyStatusFailurePolicy(statusPayload.summary, options);
          return;
        }

        printJson({ running: true, url, connectors: payload });
        applyStatusFailurePolicy(statusPayload.summary, options);
        return;
      }

      const healthPayload = payload as DaemonHealthTablePayload;

      if (outputFormat === "summary") {
        printText(formatDaemonHealthSummary(url, healthPayload));
        return;
      }

      if (outputFormat === "table") {
        printText(formatDaemonHealthTable(url, healthPayload));
        return;
      }

      printJson({ running: true, url, health: payload });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to reach daemon";
      printJson({ running: false, url, error: message });
      process.exitCode = 1;
    }
  });

daemonCommand
  .command("mcp")
  .description("Run MCP server over stdio transport")
  .action(async (_options: unknown, command: Command) => {
    await withService(command, async (service) => {
      await runMcpStdioServer(service);
    });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
