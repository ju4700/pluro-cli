import test from "node:test";
import assert from "node:assert/strict";

import { resolveConflict } from "../core/conflict-resolution";
import type { ContextEntry } from "../core/types";

function entry(overrides: Partial<ContextEntry>): ContextEntry {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    content: "value",
    encrypted: false,
    sourceTool: "test",
    scope: "global",
    tags: [],
    metadata: {},
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

test("lww chooses newer updatedAt", () => {
  const existing = entry({ updatedAt: "2026-01-01T00:00:00.000Z" });
  const incoming = entry({
    id: "22222222-2222-2222-2222-222222222222",
    updatedAt: "2026-01-02T00:00:00.000Z"
  });

  const decision = resolveConflict(existing, incoming, "lww");
  assert.equal(decision.winner, "incoming");
  assert.equal(decision.duplicateIncoming, false);
});

test("keep-both duplicates incoming", () => {
  const existing = entry({});
  const incoming = entry({ id: "33333333-3333-3333-3333-333333333333" });

  const decision = resolveConflict(existing, incoming, "keep-both");
  assert.equal(decision.winner, "incoming");
  assert.equal(decision.duplicateIncoming, true);
});
