#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function resolveTagFromEnvironment() {
  if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME.length > 0) {
    return process.env.GITHUB_REF_NAME;
  }

  if (process.env.GITHUB_REF && process.env.GITHUB_REF.startsWith("refs/tags/")) {
    return process.env.GITHUB_REF.slice("refs/tags/".length);
  }

  return "";
}

function readPackageVersion() {
  const packagePath = path.resolve(__dirname, "..", "package.json");
  const payload = fs.readFileSync(packagePath, "utf8");
  const parsed = JSON.parse(payload);

  if (!parsed.version || typeof parsed.version !== "string") {
    throw new Error("package.json is missing a valid version field.");
  }

  return parsed.version;
}

function isSemverTag(tag) {
  return /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag);
}

function main() {
  const explicitTag = process.argv[2] ?? "";
  const tag = explicitTag || resolveTagFromEnvironment();

  if (!tag) {
    throw new Error(
      "No release tag provided. Pass a tag argument like v0.2.0 or set GITHUB_REF_NAME."
    );
  }

  if (!isSemverTag(tag)) {
    throw new Error(
      `Invalid release tag '${tag}'. Expected format vMAJOR.MINOR.PATCH with optional prerelease/build.`
    );
  }

  const packageVersion = readPackageVersion();
  const normalizedTagVersion = tag.slice(1);

  if (normalizedTagVersion !== packageVersion) {
    throw new Error(
      `Release tag '${tag}' does not match package.json version '${packageVersion}'.`
    );
  }

  process.stdout.write(
    `[ok] release tag '${tag}' matches package version '${packageVersion}'.\n`
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[error] ${message}\n`);
  process.exitCode = 1;
}
