import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import { contextSnapshotSchema, type ContextSnapshot } from "../core/types";
import {
  BUILTIN_ADAPTER_PROFILES,
  findAdapterProfileById,
  type AdapterProfile,
  type AdapterSyncMode,
  type AdapterConflictPolicy
} from "./profiles";

export type SyncDirection = "import" | "export" | "bidirectional";

export type AdapterHealthLevel = "healthy" | "warning" | "error";

export interface SnapshotFileStatus {
  path: string;
  exists: boolean;
  valid: boolean;
  entries: number;
  exportedAt?: string;
  lastModifiedAt?: string;
  error?: string;
}

export interface FileSyncAdapterStatus {
  inbound: SnapshotFileStatus;
  outbound: SnapshotFileStatus;
  quarantineDir: string;
  quarantinedFilesCount: number;
}

export interface McpAdapterStatus {
  command?: string;
  args: string[];
  commandFound: boolean;
  commandPath?: string;
}

export interface AdapterStatus {
  adapterFile: string;
  configured: boolean;
  profileId?: string;
  tool?: string;
  syncMode?: AdapterSyncMode;
  health: AdapterHealthLevel;
  warnings: string[];
  errors: string[];
  checkedAt: string;
  fileSync?: FileSyncAdapterStatus;
  mcp?: McpAdapterStatus;
}

const adapterConfigSchema = z
  .object({
    version: z.literal(1),
    profileId: z.string().min(1),
    tool: z.string().min(1),
    syncMode: z.custom<AdapterSyncMode>((value) => value === "file-sync" || value === "mcp"),
    conflictPolicy: z.custom<AdapterConflictPolicy>(
      (value) => value === "lww" || value === "keep-both"
    ),
    inboundSnapshotFile: z.string().optional(),
    outboundSnapshotFile: z.string().optional(),
    mcpCommand: z.string().optional(),
    mcpArgs: z.array(z.string()).optional(),
    notes: z.array(z.string()).default([]),
    createdAt: z.string().datetime()
  })
  .superRefine((value, ctx) => {
    if (value.syncMode === "file-sync") {
      if (!value.inboundSnapshotFile) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["inboundSnapshotFile"],
          message: "inboundSnapshotFile is required for file-sync profiles"
        });
      }

      if (!value.outboundSnapshotFile) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outboundSnapshotFile"],
          message: "outboundSnapshotFile is required for file-sync profiles"
        });
      }
    }

    if (value.syncMode === "mcp" && !value.mcpCommand) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mcpCommand"],
        message: "mcpCommand is required for mcp profiles"
      });
    }
  });

export type AdapterConfig = z.infer<typeof adapterConfigSchema>;

export interface AdapterTemplateResult {
  adapterFile: string;
  createdFiles: string[];
}

function emptySnapshot(): ContextSnapshot {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    entries: [],
    history: []
  };
}

function pathIfPresent(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }

  return filePath;
}

export class FileAdapterEngine {
  constructor(private readonly baseDir: string) {}

  listProfiles(): AdapterProfile[] {
    return BUILTIN_ADAPTER_PROFILES;
  }

  createProfileTemplate(profileId: string): AdapterTemplateResult {
    const profile = findAdapterProfileById(profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    const outputDir = path.join(this.baseDir, profile.suggestedPath);
    fs.mkdirSync(outputDir, { recursive: true });

    const targetFile = path.join(outputDir, "pluro.adapter.json");
    const inboundSnapshotFile = profile.inboundFileName
      ? path.join(outputDir, profile.inboundFileName)
      : undefined;
    const outboundSnapshotFile = profile.outboundFileName
      ? path.join(outputDir, profile.outboundFileName)
      : undefined;

    const payload: AdapterConfig = {
      version: 1,
      profileId: profile.id,
      tool: profile.tool,
      syncMode: profile.syncMode,
      conflictPolicy: profile.defaultConflictPolicy ?? "lww",
      inboundSnapshotFile: pathIfPresent(inboundSnapshotFile),
      outboundSnapshotFile: pathIfPresent(outboundSnapshotFile),
      mcpCommand: profile.syncMode === "mcp" ? "pluro" : undefined,
      mcpArgs: profile.syncMode === "mcp" ? ["daemon", "mcp"] : undefined,
      notes: profile.notes,
      createdAt: new Date().toISOString()
    };

    const createdFiles: string[] = [];

    if (inboundSnapshotFile) {
      this.writeSnapshot(inboundSnapshotFile, emptySnapshot());
      createdFiles.push(inboundSnapshotFile);
    }

    if (outboundSnapshotFile) {
      this.writeSnapshot(outboundSnapshotFile, emptySnapshot());
      createdFiles.push(outboundSnapshotFile);
    }

    const instructionsPath = path.join(outputDir, "README.adapter.md");
    const instructionsLines = [
      `# ${profile.name}`,
      "",
      profile.description,
      "",
      "## Notes",
      "",
      ...profile.notes.map((line) => `- ${line}`),
      ""
    ];
    fs.writeFileSync(instructionsPath, `${instructionsLines.join("\n")}\n`, "utf8");
    createdFiles.push(instructionsPath);

    fs.writeFileSync(targetFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    createdFiles.push(targetFile);

    return {
      adapterFile: targetFile,
      createdFiles
    };
  }

  readAdapterConfig(filePath: string): AdapterConfig {
    const payload = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(payload) as unknown;
    return adapterConfigSchema.parse(parsed);
  }

  resolveAdapterFilePath(adapterFilePath: string, configuredPath: string): string {
    if (path.isAbsolute(configuredPath)) {
      return configuredPath;
    }

    return path.resolve(path.dirname(adapterFilePath), configuredPath);
  }

  watchFile(
    filePath: string,
    onChange: () => Promise<void> | void,
    debounceMs = 500
  ): () => void {
    const parentDir = path.dirname(filePath);
    const targetFile = path.basename(filePath);
    fs.mkdirSync(parentDir, { recursive: true });

    let debounceTimer: NodeJS.Timeout | undefined;
    let running = false;
    let pending = false;

    const invoke = async () => {
      if (running) {
        pending = true;
        return;
      }

      running = true;

      try {
        await onChange();
      } finally {
        running = false;

        if (pending) {
          pending = false;
          await invoke();
        }
      }
    };

    const schedule = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        void invoke();
      }, debounceMs);
    };

    const watcher = fs.watch(parentDir, (_eventName, filename) => {
      if (!filename) {
        schedule();
        return;
      }

      if (filename.toString() === targetFile) {
        schedule();
      }
    });

    return () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      watcher.close();
    };
  }

  writeSnapshot(filePath: string, snapshot: ContextSnapshot): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  readSnapshot(filePath: string): ContextSnapshot {
    const payload = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(payload) as unknown;
    return contextSnapshotSchema.parse(parsed);
  }

  getAdapterStatus(adapterFilePath: string): AdapterStatus {
    const resolvedAdapterFilePath = path.resolve(adapterFilePath);
    const warnings: string[] = [];
    const errors: string[] = [];
    const checkedAt = new Date().toISOString();

    if (!fs.existsSync(resolvedAdapterFilePath)) {
      errors.push("Adapter file not found.");

      return {
        adapterFile: resolvedAdapterFilePath,
        configured: false,
        health: "error",
        warnings,
        errors,
        checkedAt
      };
    }

    let config: AdapterConfig;

    try {
      config = this.readAdapterConfig(resolvedAdapterFilePath);
    } catch (error) {
      errors.push(`Invalid adapter config: ${this.getErrorMessage(error)}`);

      return {
        adapterFile: resolvedAdapterFilePath,
        configured: false,
        health: "error",
        warnings,
        errors,
        checkedAt
      };
    }

    const status: AdapterStatus = {
      adapterFile: resolvedAdapterFilePath,
      configured: true,
      profileId: config.profileId,
      tool: config.tool,
      syncMode: config.syncMode,
      health: "healthy",
      warnings,
      errors,
      checkedAt
    };

    if (config.syncMode === "file-sync") {
      const inboundPath = this.resolveConfiguredPath(resolvedAdapterFilePath, config.inboundSnapshotFile);
      const outboundPath = this.resolveConfiguredPath(
        resolvedAdapterFilePath,
        config.outboundSnapshotFile
      );

      if (!inboundPath) {
        errors.push("inboundSnapshotFile is missing.");
      }

      if (!outboundPath) {
        errors.push("outboundSnapshotFile is missing.");
      }

      const inboundStatus = this.inspectSnapshotFile(inboundPath);
      const outboundStatus = this.inspectSnapshotFile(outboundPath);

      if (!inboundStatus.exists) {
        warnings.push("Inbound snapshot file is missing.");
      } else if (!inboundStatus.valid) {
        errors.push(`Inbound snapshot is invalid: ${inboundStatus.error ?? "unknown error"}`);
      }

      if (!outboundStatus.exists) {
        warnings.push("Outbound snapshot file is missing.");
      } else if (!outboundStatus.valid) {
        errors.push(`Outbound snapshot is invalid: ${outboundStatus.error ?? "unknown error"}`);
      }

      const quarantineDir = inboundPath
        ? path.join(path.dirname(inboundPath), ".pluro-invalid")
        : path.join(path.dirname(resolvedAdapterFilePath), ".pluro-invalid");
      const quarantinedFilesCount = this.countDirectoryEntries(quarantineDir);

      if (quarantinedFilesCount > 0) {
        warnings.push(
          `Detected ${quarantinedFilesCount} quarantined inbound snapshot file(s).`
        );
      }

      status.fileSync = {
        inbound: inboundStatus,
        outbound: outboundStatus,
        quarantineDir,
        quarantinedFilesCount
      };
    }

    if (config.syncMode === "mcp") {
      const command = config.mcpCommand;
      const commandPath = command ? this.resolveCommandPath(command) : undefined;

      if (!command) {
        errors.push("mcpCommand is missing.");
      } else if (!commandPath) {
        warnings.push(`MCP command '${command}' was not found on PATH.`);
      }

      status.mcp = {
        command,
        args: config.mcpArgs ?? [],
        commandFound: Boolean(commandPath),
        commandPath
      };
    }

    if (errors.length > 0) {
      status.health = "error";
    } else if (warnings.length > 0) {
      status.health = "warning";
    }

    return status;
  }

  private inspectSnapshotFile(filePath: string | undefined): SnapshotFileStatus {
    if (!filePath) {
      return {
        path: "",
        exists: false,
        valid: false,
        entries: 0,
        error: "Path not configured"
      };
    }

    if (!fs.existsSync(filePath)) {
      return {
        path: filePath,
        exists: false,
        valid: false,
        entries: 0
      };
    }

    const stats = fs.statSync(filePath);

    try {
      const snapshot = this.readSnapshot(filePath);

      return {
        path: filePath,
        exists: true,
        valid: true,
        entries: snapshot.entries.length,
        exportedAt: snapshot.exportedAt,
        lastModifiedAt: stats.mtime.toISOString()
      };
    } catch (error) {
      return {
        path: filePath,
        exists: true,
        valid: false,
        entries: 0,
        lastModifiedAt: stats.mtime.toISOString(),
        error: this.getErrorMessage(error)
      };
    }
  }

  private resolveConfiguredPath(
    adapterFilePath: string,
    configuredPath: string | undefined
  ): string | undefined {
    if (!configuredPath) {
      return undefined;
    }

    return this.resolveAdapterFilePath(adapterFilePath, configuredPath);
  }

  private countDirectoryEntries(dirPath: string): number {
    if (!fs.existsSync(dirPath)) {
      return 0;
    }

    try {
      return fs.readdirSync(dirPath).length;
    } catch {
      return 0;
    }
  }

  private resolveCommandPath(command: string): string | undefined {
    if (!command.trim()) {
      return undefined;
    }

    if (path.isAbsolute(command)) {
      return fs.existsSync(command) ? command : undefined;
    }

    if (command.includes("/") || command.includes("\\")) {
      const candidate = path.resolve(command);
      return fs.existsSync(candidate) ? candidate : undefined;
    }

    const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const extensions =
      process.platform === "win32" ? ["", ".exe", ".cmd", ".bat", ".ps1"] : [""];

    for (const pathEntry of pathEntries) {
      for (const extension of extensions) {
        const candidate = path.join(pathEntry, `${command}${extension}`);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    return undefined;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
