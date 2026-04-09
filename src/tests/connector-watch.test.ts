import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { FileAdapterEngine } from "../adapters/file-sync";
import { PluroClient } from "../sdk";
import type { ContextSnapshot } from "../core/types";

function withTempDir(handler: (tempDir: string) => Promise<void> | void): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pluro-watch-it-"));

  return Promise.resolve()
    .then(() => handler(tempDir))
    .finally(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function startConnectorWatch(
  dataDir: string,
  adapterFile: string,
  direction: "import" | "export",
  extraArgs: string[] = []
): ChildProcessWithoutNullStreams {
  const cliPath = path.join(process.cwd(), "dist", "cli", "index.js");

  return spawn(
    process.execPath,
    [
      cliPath,
      "--data-dir",
      dataDir,
      "connector",
      "watch",
      adapterFile,
      "--direction",
      direction,
      "--debounce-ms",
      "120",
      "--no-run-initial",
      ...extraArgs
    ],
    {
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
}

async function waitForOutput(
  proc: ChildProcessWithoutNullStreams,
  matcher: RegExp,
  timeoutMs = 10000
): Promise<string> {
  let output = "";
  let stderr = "";

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  const onStdout = (chunk: string) => {
    output += chunk;
  };

  const onStderr = (chunk: string) => {
    stderr += chunk;
  };

  proc.stdout.on("data", onStdout);
  proc.stderr.on("data", onStderr);

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for output ${matcher.toString()}\nstdout:\n${output}\nstderr:\n${stderr}`
          )
        );
      }, timeoutMs);

      const interval = setInterval(() => {
        if (matcher.test(output)) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve();
        }
      }, 40);

      proc.once("exit", (code, signal) => {
        clearTimeout(timeout);
        clearInterval(interval);
        reject(
          new Error(
            `Watch process exited unexpectedly. code=${code ?? "null"} signal=${signal ?? "null"}\nstdout:\n${output}\nstderr:\n${stderr}`
          )
        );
      });
    });

    return output;
  } finally {
    proc.stdout.off("data", onStdout);
    proc.stderr.off("data", onStderr);
  }
}

async function stopProcess(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");

    setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
    }, 1200);
  });
}

function buildInboundSnapshot(content: string): ContextSnapshot {
  const now = new Date().toISOString();

  return {
    version: 1,
    exportedAt: now,
    entries: [
      {
        id: "99999999-9999-4999-8999-999999999999",
        content,
        encrypted: false,
        sourceTool: "cursor-agent",
        scope: "global",
        tags: ["watch", "import"],
        metadata: {
          source: "connector-watch-test"
        },
        version: 1,
        parentId: null,
        createdAt: now,
        updatedAt: now
      }
    ],
    history: []
  };
}

test("connector watch imports inbound snapshot changes", async () => {
  await withTempDir(async (dataDir) => {
    const engine = new FileAdapterEngine(dataDir);
    const template = engine.createProfileTemplate("cursor-file");
    const config = engine.readAdapterConfig(template.adapterFile);
    const inbound = config.inboundSnapshotFile as string;

    const proc = startConnectorWatch(dataDir, template.adapterFile, "import");

    try {
      await waitForOutput(proc, /"watching"\s*:\s*true/, 8000);

      const snapshot = buildInboundSnapshot("watch import content");
      fs.writeFileSync(inbound, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

      await waitForOutput(proc, /"event"\s*:\s*"import-sync"/, 10000);

      const client = new PluroClient({ dataDir, disableKeychain: true });
      try {
        const entries = await client.listContexts({ query: "watch import content", limit: 10 });
        assert.ok(entries.length >= 1);
        assert.equal(entries[0]?.content, "watch import content");
      } finally {
        client.close();
      }
    } finally {
      await stopProcess(proc);
    }
  });
});

test("connector watch exports when local context changes", async () => {
  await withTempDir(async (dataDir) => {
    const engine = new FileAdapterEngine(dataDir);
    const template = engine.createProfileTemplate("cursor-file");
    const config = engine.readAdapterConfig(template.adapterFile);
    const outbound = config.outboundSnapshotFile as string;

    const proc = startConnectorWatch(dataDir, template.adapterFile, "export");

    try {
      await waitForOutput(proc, /"watching"\s*:\s*true/, 8000);

      const client = new PluroClient({ dataDir, disableKeychain: true });
      try {
        await client.addContext({
          content: "watch export content",
          sourceTool: "watch-test"
        });
      } finally {
        client.close();
      }

      await waitForOutput(proc, /"event"\s*:\s*"export-sync"/, 12000);

      const snapshot = engine.readSnapshot(outbound);
      assert.ok(snapshot.entries.some((entry) => entry.content === "watch export content"));
    } finally {
      await stopProcess(proc);
    }
  });
});

test("connector watch quarantines invalid inbound snapshots", async () => {
  await withTempDir(async (dataDir) => {
    const engine = new FileAdapterEngine(dataDir);
    const template = engine.createProfileTemplate("cursor-file");
    const config = engine.readAdapterConfig(template.adapterFile);
    const inbound = config.inboundSnapshotFile as string;

    const proc = startConnectorWatch(dataDir, template.adapterFile, "import", [
      "--max-retries",
      "1",
      "--retry-base-ms",
      "50"
    ]);

    try {
      await waitForOutput(proc, /"watching"\s*:\s*true/, 8000);

      fs.writeFileSync(inbound, "{\n  \"version\": 1,\n  \"broken\": ", "utf8");

      await waitForOutput(proc, /"event"\s*:\s*"import-sync-invalid-snapshot-recovered"/, 12000);

      const quarantineDir = path.join(path.dirname(inbound), ".pluro-invalid");
      assert.ok(fs.existsSync(quarantineDir));

      const quarantinedFiles = fs.readdirSync(quarantineDir);
      assert.ok(quarantinedFiles.length >= 1);
      assert.ok(quarantinedFiles.some((name) => name.startsWith(path.basename(inbound))));

      const recoveredSnapshot = engine.readSnapshot(inbound);
      assert.equal(recoveredSnapshot.entries.length, 0);
      assert.equal(recoveredSnapshot.history.length, 0);
    } finally {
      await stopProcess(proc);
    }
  });
});
