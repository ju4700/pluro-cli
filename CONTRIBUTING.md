# Contributing to pluro-cli

Thanks for contributing.

## Prerequisites

- Node.js 22+
- npm 10+
- Git

## Local Setup

1. Install dependencies:

   npm install

2. Build once:

   npm run build

3. Run the CLI locally:

   npm run dev -- --help

## Quality Gate

Before opening a pull request, run:

1. Full local gate:

   npm run verify:ci

2. Optional MCP-only check:

   npm run verify:mcp

## Pull Request Guidelines

- Keep changes focused and small when possible.
- Add tests for behavior changes.
- Update README when command behavior or workflows change.
- Preserve backward compatibility for documented CLI/daemon/MCP interfaces unless a breaking change is explicitly planned for a major release.
- Ensure verify:ci passes locally.

## Extension Workflow

For adding IDE/tool integrations, prefer extending adapter profiles before changing core services.

1. Start with profile updates in `src/adapters/profiles.ts`.
2. Verify behavior with `pluro connector status` and targeted tests.
3. Add integration coverage in `src/tests` when behavior crosses CLI/daemon/MCP boundaries.
4. Re-run the full local quality gate (`npm run verify:ci`).

## Release Process

1. Bump package version in package.json.
2. Push the version bump commit to main.
3. Create and push a matching tag:

   git tag vX.Y.Z
   git push origin vX.Y.Z

4. GitHub Actions Release workflow runs:

- verify:ci
- verify:release-tag
- npm publish

Release tags are validated against package.json version using scripts/verify-release-tag.cjs.

## Security and Secrets

- Never commit credentials.
- GitHub Actions release requires NPM_TOKEN secret in repository settings.
- Report vulnerabilities through the private GitHub Security advisory flow described in `SECURITY.md`.
