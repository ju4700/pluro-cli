import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface PluroPaths {
  dataDir: string;
  dbPath: string;
}

export interface ResolvePathOptions {
  dataDir?: string;
  dbPath?: string;
}

function defaultDataDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      return path.join(appData, "pluro");
    }
  }

  return path.join(os.homedir(), ".pluro");
}

export function resolvePaths(options: ResolvePathOptions = {}): PluroPaths {
  const dataDir = options.dataDir ?? defaultDataDir();
  const dbPath = options.dbPath ?? path.join(dataDir, "context.db");
  return {
    dataDir,
    dbPath
  };
}

export function ensureDataDirectory(paths: PluroPaths): void {
  fs.mkdirSync(paths.dataDir, { recursive: true });
}
