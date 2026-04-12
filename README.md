# pluro-cli

[![CI](https://github.com/ju4700/pluro-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/ju4700/pluro-cli/actions/workflows/ci.yml)
[![Release](https://github.com/ju4700/pluro-cli/actions/workflows/release.yml/badge.svg)](https://github.com/ju4700/pluro-cli/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Pluro is a local-first context bridge CLI that lets multiple LLM tools and agentic IDEs share structured context on one machine.

## Primary IDE Focus

Pluro prioritizes three agentic IDEs as first-class integrations:

- Cursor
- VS Code (GitHub Copilot)
- Antigravity

Current connector commands support this focus directly while still keeping generic profiles for future IDEs and tools.

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

Global install from npm:

```bash
npm install -g pluro-cli
```

Run without global install:

```bash
npx pluro-cli --help
```

Local development setup:

```bash
npm install
npm run build
npm link
```

After linking, use:

```bash
pluro --help
```

The package exposes `pluro`, `pluro-cli`, and `pluro-tui` command names.

- `pluro`: classic command-oriented CLI (`context`, `snapshot`, `conversation`, `connector`, `daemon`)
- `pluro-cli`: interactive terminal UI launcher
- `pluro-tui`: explicit interactive terminal UI launcher (same UI as `pluro-cli`)

Running `pluro` without a subcommand now launches the TUI. Use `pluro <command>` for command-mode workflows.

## Terminal UI (Preview)

The TUI now opens on a dashboard-first landing screen with a card-style console layout inspired by premium terminal products.

Launch the full-screen terminal UI:

```bash
pluro
```

or

```bash
pluro-cli --ide vscode-copilot
```

Equivalent explicit launcher:

```bash
pluro-tui --ide vscode-copilot
```

Global keys:

- `Tab` / `Shift+Tab`: switch panels
- `1` / `2` / `3`: jump to Dashboard, Transfer, Contexts
- `q`: quit

Transfer panel keys:

- `Up` / `Down`: choose option in current step
- `Enter`: confirm current step
- `Left` / `Right` or `b` / `n`: move between steps
- `s`: scan selected source workspace
- `r`: refresh IDE/workspace/conversation catalog
- `p`: cycle conflict policy (`keep-both`, `lww`)
- `g`: cycle import scope (`project`, `session`, `global`)
- `u`: toggle skip unchanged mode
- `t`: edit comma-separated transfer tags

Transfer flow in the UI:

1. Select source IDE detected on your machine.
2. Select source workspace.
3. Select discovered conversation.
4. Select target IDE.
5. Select target workspace.
6. Confirm inject to transfer into target IDE profile export.

Context panel keys:

- `g`: cycle scope filter
- `r`: refresh rows
- `d`: start delete confirmation
- `y` / `n`: confirm or cancel deletion

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

Check connector health through daemon status API:

```bash
pluro daemon status --port 43111 --connectors --focus primary --compact
```

Show daemon connector health in a terminal-friendly table:

```bash
pluro daemon status --port 43111 --connectors --focus primary --format table
```

Emit daemon connector health as a one-line summary for scripts:

```bash
pluro daemon status --port 43111 --connectors --focus primary --format summary
```

Scan known Cursor conversation roots and index discovered conversations:

```bash
pluro conversation scan --ide cursor --format table
```

List discovered conversations for one IDE:

```bash
pluro conversation list --ide cursor --format table
```

Filter list output by project confidence and source:

```bash
pluro conversation list --ide vscode-copilot --project-confidence high --project-source metadata
```

Gate CI/scripts by minimum confidence (fails with exit code 1 if any listed conversation is below threshold):

```bash
pluro conversation list --ide vscode-copilot --min-project-confidence medium --format summary
```

Both scan and list tables now include project confidence (`high|medium|low`) and fallback project grouping when exact project path cannot be inferred.

Inject one discovered conversation into Pluro store:

```bash
pluro conversation inject <conversation-id>
```

Pick from discovered conversations interactively (when no id is passed):

```bash
pluro conversation inject --ide cursor
```

Pick by index in scripts/non-interactive terminals:

```bash
pluro conversation inject --ide cursor --select 1 --format summary
```

Filter picker candidates by confidence and source:

```bash
pluro conversation inject --ide vscode-copilot --project-confidence high --project-source metadata --select 1
```

Gate scan results by minimum confidence (fails with exit code 1 if any discovered conversation is below threshold):

```bash
pluro conversation scan --ide cursor --min-project-confidence medium --format summary
```

Inject and immediately export to a target profile adapter (for cross-IDE delivery):

```bash
pluro conversation inject <conversation-id> --target-profile vscode-copilot-file
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
pluro connector bootstrap --sync-mode file-sync
```

List only primary IDE profiles:

```bash
pluro connector list --focus primary
```

List only primary IDE MCP profiles:

```bash
pluro connector list --focus primary --sync-mode mcp
```

Check primary IDE adapter health at a glance:

```bash
pluro connector status --focus primary
```

Render adapter health as a table:

```bash
pluro connector status --focus primary --format table
```

Emit adapter health as a one-line summary:

```bash
pluro connector status --focus primary --format summary
```

Fail CI when connector status has errors:

```bash
pluro connector status --focus primary --format summary --fail-on-error
```

Check one adapter file explicitly:

```bash
pluro connector status <path-to-adapter-json>
```

Run one-shot bidirectional sync:

```bash
pluro connector sync <path-to-adapter-json> --direction bidirectional
```

Run continuous sync watch mode:

```bash
pluro connector watch <path-to-adapter-json> --direction bidirectional
```

Tune reliability behavior for active agent loops:

```bash
pluro connector watch <path-to-adapter-json> --direction import --max-retries 3 --retry-base-ms 200
```

Watch mode listens for:

- inbound snapshot file writes for import direction
- SQLite `context.db` and WAL/SHM sidecar file activity for export direction

If an inbound snapshot is invalid JSON/schema, watch mode retries and then quarantines the bad file under `.pluro-invalid` (unless `--no-quarantine-invalid` is set).

## Global Options

- `--data-dir <path>`: root directory for runtime state
- `--db-path <path>`: override SQLite file path
- `--passphrase <value>`: fallback encryption key material
- `--disable-keychain`: skip OS keychain lookup

Environment variable alternative:

- `PLURO_DISABLE_KEYCHAIN=1` disables keychain lookups in headless/CI environments.

## Commands

- `context add|get|list|update|delete`
- `snapshot export|import`
- `history`
- `conversation scan|list|inject`
- `connector list|status|bootstrap|init|sync|watch`
- `daemon run|status|mcp`

Daemon connector status endpoint:

- `GET /connectors/status?focus=primary|all&syncMode=file-sync|mcp&compact=1`
- `adapterFile` query param can be repeated to inspect explicit adapter files.

Daemon conversation endpoints:

- `POST /conversations/scan` with body `{ ide, roots?, recursive?, projectPath?, minProjectConfidence?, maxFiles?, maxFileSizeBytes?, includeSessionLogs? }`
- `GET /conversations?ide=cursor|vscode-copilot|antigravity&projectPath=<path>&projectConfidence=high|medium|low&projectSource=<source>&minProjectConfidence=high|medium|low&limit=<n>`
- `POST /conversations/inject` with body `{ conversationId, policy?, skipUnchanged?, scope?, tags?, projectPath? }`

Daemon and MCP conversation confidence filtering notes:

- `minProjectConfidence` is filter mode (rows below the threshold are excluded).
- For scan operations, `minProjectConfidence` filters response rows and `discovered` count while `indexedDiscovered` keeps the full indexed total.

Conversation inject picker behavior:

- If `conversationId` is omitted, Pluro can pick from discovered conversations.
- Use `--ide`, `--project-filter`, and `--limit` to narrow picker candidates.
- Use `--select <number>` for non-interactive shells/automation.

Conversation list CI gating flags:

- `--fail-on-low-confidence` exits with code `1` when any listed conversation has `low` confidence.
- `--fail-on-unresolved-project` exits with code `1` when any listed conversation has no resolved `projectPath`.

Project inference behavior:

- `high`: explicit `--project` override or project/workspace path found in conversation metadata.
- `medium`: inferred from nearby Git root.
- `low`: inferred from IDE path markers or workspace-storage fallback grouping.

Status command output formats:

- `--format json` (default)
- `--format table` for a compact terminal-friendly view
- `--format summary` for machine-friendly one-line scripting output

Status command failure flags:

- `--fail-on-error` exits with code `1` when any errors are detected
- `--fail-on-warning` exits with code `1` when warnings or errors are detected

## Verification

- `npm test`: build + unit/integration tests
- `npm run verify:mcp`: standalone MCP handshake and tool-call conformance smoke check
- `npm run verify:ci`: CI-equivalent local gate (`typecheck`, `test`, `verify:mcp`)
- `npm run verify:release-tag -- vX.Y.Z`: ensure pushed release tag matches package version

## Versioning and Stability

Pluro follows [Semantic Versioning](https://semver.org/) for public interfaces.

- Patch releases (`x.y.Z`) are for fixes and should not intentionally break existing workflows.
- Minor releases (`x.Y.z`) may add commands, flags, endpoints, and output fields in a backward-compatible way.
- Major releases (`X.y.z`) may include breaking changes.

Public interface commitments within a major version:

- CLI command names and documented flags.
- Daemon HTTP endpoint paths and documented request/response fields.
- MCP tool names and documented payload fields.
- `--format summary` machine-readable output remains backward-compatible; new fields may be added.

When possible, breaking removals are preceded by a deprecation notice in release notes before the next major release.

## Security

For supported versions and responsible vulnerability reporting, see [SECURITY.md](SECURITY.md).

## Publishing

1. Create an npm token in npm account settings with publish permissions and 2FA bypass for publishing.
   - For granular tokens, enable package publish permission and bypass package publishing 2FA.
   - Otherwise npm publish from GitHub Actions may fail with `E403`.
2. Add repository secret `NPM_TOKEN` in GitHub:
	- GitHub repository Settings -> Secrets and variables -> Actions -> New repository secret
	- Name: `NPM_TOKEN`
	- Value: npm token string from step 1
3. Ensure package version in `package.json` matches your release tag version.
4. Create and push a semver tag in format `vMAJOR.MINOR.PATCH`.

Example:

```bash
npm version patch
git push origin main
git push origin --tags
```

Tag push triggers the Release workflow and publishes to npm.

Manual release trigger is also supported, but requires entering the tag input (for example `v0.2.1`).

GitHub Actions runs the CI gate on push and pull request via [.github/workflows/ci.yml](.github/workflows/ci.yml).
Releases run from tags via [.github/workflows/release.yml](.github/workflows/release.yml).

## Contributing

Contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md).

## Architecture

- `src/core`: data model, conflict handling, storage, encryption, service layer
- `src/cli`: command-line interface
- `src/daemon`: daemon protocol and server
- `src/adapters`: tool adapter profiles and file-sync helpers
- `src/sdk`: programmatic client wrapper

## Extending Pluro

Pluro is designed so most new IDE/tool integrations start with adapter profiles, not core changes.

Recommended extension pattern:

1. Define or update profile templates in `src/adapters/profiles.ts`.
2. Keep profile metadata explicit (`syncMode`, inbound/outbound snapshot locations, and notes).
3. Validate profile health with `pluro connector status` before adding new behavior.
4. Add or update tests under `src/tests` for command routing and integration behavior.
5. Run `npm run verify:ci` and `npm run verify:mcp` before submitting changes.

## Notes

- Encryption key resolution order: OS keychain first, then passphrase.
- For environments where keychain is not available, set `PLURO_PASSPHRASE` or pass `--passphrase`.
- In CI/headless Linux, set `PLURO_DISABLE_KEYCHAIN=1` to avoid keychain provider issues.
- File-sync adapters include inbound and outbound snapshot files plus profile notes.
- MCP mode is exposed over stdio so it can be registered in MCP-capable clients.
- Generic and terminal profiles remain available to add new IDEs/tools without breaking core flows.
