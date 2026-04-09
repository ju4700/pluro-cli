import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import { contextSnapshotSchema, type ContextSnapshot } from "../core/types";
import {
  BUILTIN_ADAPTER_PROFILES,
  type AdapterProfile,
  type AdapterSyncMode,
  type AdapterConflictPolicy
} from "./profiles";

export type SyncDirection = "import" | "export" | "bidirectional";

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
    const profile = BUILTIN_ADAPTER_PROFILES.find((item) => item.id === profileId);
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
}
