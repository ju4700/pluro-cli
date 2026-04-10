#!/usr/bin/env node

const { execSync } = require("node:child_process");

function getPackManifest() {
  const output = execSync("npm pack --dry-run --json", {
    encoding: "utf8"
  });

  const parsed = JSON.parse(output);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("npm pack --dry-run returned no package manifest.");
  }

  return parsed[parsed.length - 1];
}

function assertRequiredFiles(paths) {
  const required = ["dist/cli/index.js", "dist/index.js", "package.json"];

  for (const requiredPath of required) {
    if (!paths.includes(requiredPath)) {
      throw new Error(`Published package is missing required file '${requiredPath}'.`);
    }
  }
}

function assertForbiddenFiles(paths) {
  const forbidden = paths.filter((item) => item.startsWith("dist/tests/"));

  if (forbidden.length > 0) {
    const preview = forbidden.slice(0, 5).join(", ");
    throw new Error(
      `Published package includes test artifacts (${forbidden.length}): ${preview}`
    );
  }
}

function main() {
  const manifest = getPackManifest();
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const paths = files
    .map((entry) => (entry && typeof entry.path === "string" ? entry.path : ""))
    .filter(Boolean);

  assertRequiredFiles(paths);
  assertForbiddenFiles(paths);

  process.stdout.write(
    `[ok] package dry-run validated (${paths.length} files, size=${manifest.size ?? "unknown"}).\n`
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[error] ${message}\n`);
  process.exitCode = 1;
}
