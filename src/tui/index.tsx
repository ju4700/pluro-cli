#!/usr/bin/env node

import { Command } from "commander";
import React from "react";
import { render } from "ink";

import { ensureDataDirectory, resolvePaths } from "../core/config";
import { ContextService } from "../core/context-service";
import { ConversationDiscoveryService } from "../core/conversation-discovery";
import { EncryptionService } from "../core/security/encryption";
import { SqliteStore } from "../core/storage/sqlite";
import type { SupportedIde } from "../core/types";
import { getPluroVersion } from "../core/version";
import { PluroTuiApp } from "./ui";

interface TuiCliOptions {
  dataDir?: string;
  dbPath?: string;
  passphrase?: string;
  disableKeychain?: boolean;
  ide: string;
}

const ALT_SCREEN_ENTER = "\u001B[?1049h\u001B[2J\u001B[H";
const ALT_SCREEN_EXIT = "\u001B[?1049l";

function shouldUseAltScreen(): boolean {
  if (!process.stdout.isTTY) {
    return false;
  }

  if (process.env.CI) {
    return false;
  }

  if (process.env.PLURO_DISABLE_ALT_SCREEN === "1") {
    return false;
  }

  return true;
}

function writeTerminalEscape(sequence: string): void {
  try {
    process.stdout.write(sequence);
  } catch {
    // Ignore write failures for terminals that do not support escape sequences.
  }
}

function parseSupportedIde(value: string): SupportedIde {
  const normalized = value.trim().toLowerCase();

  if (normalized === "cursor" || normalized === "vscode-copilot" || normalized === "antigravity") {
    return normalized;
  }

  throw new Error(`Invalid IDE: ${value}. Expected cursor, vscode-copilot, or antigravity.`);
}

async function runTui(options: TuiCliOptions): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error(
      "pluro-tui requires an interactive terminal (TTY). Use pluro CLI commands in non-interactive shells."
    );
  }

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
  const useAltScreen = shouldUseAltScreen();

  try {
    if (useAltScreen) {
      writeTerminalEscape(ALT_SCREEN_ENTER);
    }

    const discovery = new ConversationDiscoveryService(service);
    const app = render(
      React.createElement(PluroTuiApp, {
        service,
        discovery,
        defaultIde: parseSupportedIde(options.ide),
        dataDir: paths.dataDir,
        version: getPluroVersion()
      })
    );

    await app.waitUntilExit();
  } finally {
    if (useAltScreen) {
      writeTerminalEscape(ALT_SCREEN_EXIT);
    }

    service.close();
  }
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("pluro-tui")
    .description("Interactive terminal UI for Pluro context and conversation workflows")
    .version(getPluroVersion())
    .option("--data-dir <path>", "Path to pluro data directory")
    .option("--db-path <path>", "Path to SQLite context database")
    .option("--passphrase <passphrase>", "Fallback passphrase when keychain is unavailable")
    .option("--disable-keychain", "Disable OS keychain integration", false)
    .option("--ide <ide>", "Default IDE focus: cursor, vscode-copilot, or antigravity", "vscode-copilot")
    .action(async (options: TuiCliOptions) => {
      await runTui(options);
    });

  await program.parseAsync(process.argv);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
