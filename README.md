# pluro-cli

Pluro is a local-first context bridge CLI that lets multiple LLM tools and agentic IDEs share structured context on one machine.

## Current Status

This repository now includes the first working implementation:

- TypeScript npm package with global CLI target: `pluro`
- SQLite context store with history tracking
- Optional encryption at rest with OS keychain default and passphrase fallback
- Snapshot export and import with conflict policies (`lww`, `keep-both`)
- File adapter profile templates for multi-tool interoperability
- Connector one-shot and watch sync modes for file-based adapters
- MCP stdio server mode for direct MCP client integration
- Local daemon mode with HTTP endpoints (`health`, context CRUD, snapshot import/export)
- SDK wrapper for app integrations

## Install

```bash
npm install
npm run build
npm link
```

After linking, use:

```bash
pluro --help
```

## Quick Start

Add context:

```bash
pluro context add "project uses sqlite + daemon" --source vscode-copilot --tag architecture shared
```

List context:

```bash
pluro context list
```

Export snapshot:

```bash
pluro snapshot export ./.pluro/snapshot.json
```

Import snapshot:

```bash
pluro snapshot import ./.pluro/snapshot.json --policy lww
```

Run daemon:

```bash
pluro daemon run --port 43111
```

Check daemon status:

```bash
pluro daemon status --port 43111
```

Run MCP stdio server:

```bash
pluro daemon mcp
```

Run local MCP conformance checks:

```bash
npm run verify:mcp
```

## MCP Client Setup Examples

Use `pluro daemon mcp` as the MCP stdio command in any MCP-capable client.

### VS Code (GitHub Copilot Chat MCP)

Add a server definition in your VS Code settings profile that controls MCP servers:

```json
{
	"chat.mcp.servers": {
		"pluro": {
			"command": "pluro",
			"args": [
				"daemon",
				"mcp"
			]
		}
	}
}
```

If your VS Code/Copilot build uses a different MCP settings key, reuse the same command and args.

### Cursor

In Cursor MCP configuration, register:

```json
{
	"mcpServers": {
		"pluro": {
			"command": "pluro",
			"args": [
				"daemon",
				"mcp"
			]
		}
	}
}
```

### Antigravity or Other MCP Clients

Any MCP client that supports stdio can use:

```json
{
	"name": "pluro",
	"transport": "stdio",
	"command": "pluro",
	"args": [
		"daemon",
		"mcp"
	]
}
```

Bootstrap a Cursor adapter profile:

```bash
pluro connector init cursor-file
```

Run one-shot bidirectional sync:

```bash
pluro connector sync <path-to-adapter-json> --direction bidirectional
```

Run continuous sync watch mode:

```bash
pluro connector watch <path-to-adapter-json> --direction bidirectional
```

Watch mode listens for:

- inbound snapshot file writes for import direction
- SQLite `context.db` and WAL/SHM sidecar file activity for export direction

## Global Options

- `--data-dir <path>`: root directory for runtime state
- `--db-path <path>`: override SQLite file path
- `--passphrase <value>`: fallback encryption key material
- `--disable-keychain`: skip OS keychain lookup

## Commands

- `context add|get|list|update|delete`
- `snapshot export|import`
- `history`
- `connector list|init|sync|watch`
- `daemon run|status|mcp`

## Verification

- `npm test`: build + unit/integration tests
- `npm run verify:mcp`: standalone MCP handshake and tool-call conformance smoke check
- `npm run verify:ci`: CI-equivalent local gate (`typecheck`, `test`, `verify:mcp`)

GitHub Actions runs the CI gate on push and pull request via [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Architecture

- `src/core`: data model, conflict handling, storage, encryption, service layer
- `src/cli`: command-line interface
- `src/daemon`: daemon protocol and server
- `src/adapters`: tool adapter profiles and file-sync helpers
- `src/sdk`: programmatic client wrapper

## Notes

- Encryption key resolution order: OS keychain first, then passphrase.
- For environments where keychain is not available, set `PLURO_PASSPHRASE` or pass `--passphrase`.
- File-sync adapters include inbound and outbound snapshot files plus profile notes.
- MCP mode is exposed over stdio so it can be registered in MCP-capable clients.
