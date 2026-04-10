import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_VERSION = "0.0.0";

let cachedVersion: string | undefined;

export function getPluroVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");

  try {
    const payload = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(payload) as { version?: unknown };

    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      cachedVersion = parsed.version.trim();
      return cachedVersion;
    }
  } catch {
    // Fall through to default version.
  }

  cachedVersion = DEFAULT_VERSION;
  return cachedVersion;
}