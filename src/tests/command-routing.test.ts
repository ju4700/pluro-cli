import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const cliPath = path.join(process.cwd(), "dist", "cli", "index.js");

  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8"
  });

  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

test("package bin maps pluro-cli to TUI and pluro to CLI", () => {
  const packageJsonPath = path.join(process.cwd(), "package.json");
  const payload = fs.readFileSync(packageJsonPath, "utf8");
  const packageJson = JSON.parse(payload) as {
    bin: Record<string, string>;
  };

  assert.equal(packageJson.bin.pluro, "dist/cli/index.js");
  assert.equal(packageJson.bin["pluro-cli"], "dist/tui/index.js");
  assert.equal(packageJson.bin["pluro-tui"], "dist/tui/index.js");
});

test("dist CLI remains command-driven under pluro entrypoint", () => {
  const result = runCli(["--help"]);

  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes("Usage: pluro"));
  assert.ok(result.stdout.includes("conversation"));
  assert.ok(result.stdout.includes("daemon"));
});

test("dist CLI without subcommand attempts TUI launch", () => {
  const result = runCli([]);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.code, 1);
  assert.ok(combinedOutput.toLowerCase().includes("interactive terminal"));
});
