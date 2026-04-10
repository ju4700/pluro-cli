import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

function withTempDir(handler: (tempDir: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pluro-tui-it-"));

  try {
    handler(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runTui(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const tuiPath = path.join(process.cwd(), "dist", "tui", "index.js");

  const result = spawnSync(process.execPath, [tuiPath, ...args], {
    encoding: "utf8"
  });

  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

test("pluro-tui help prints usage", () => {
  const result = runTui(["--help"]);

  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes("pluro-tui"));
  assert.ok(result.stdout.includes("--ide"));
});

test("pluro-tui requires interactive terminal", () => {
  withTempDir((tempDir) => {
    const result = runTui(["--data-dir", tempDir]);

    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("interactive terminal"));
  });
});
