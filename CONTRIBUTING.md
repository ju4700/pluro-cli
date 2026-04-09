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
- Ensure verify:ci passes locally.

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
