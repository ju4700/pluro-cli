import type { ContextEntry } from "./types";

export type ConflictPolicy = "lww" | "keep-both";

export interface ConflictDecision {
  winner: "existing" | "incoming";
  reason: string;
  duplicateIncoming: boolean;
}

function toEpochMillis(value: string): number {
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? 0 : epoch;
}

export function resolveConflict(
  existing: ContextEntry,
  incoming: ContextEntry,
  policy: ConflictPolicy
): ConflictDecision {
  if (policy === "keep-both") {
    return {
      winner: "incoming",
      reason: "policy_keep_both",
      duplicateIncoming: true
    };
  }

  const existingTime = toEpochMillis(existing.updatedAt);
  const incomingTime = toEpochMillis(incoming.updatedAt);

  if (incomingTime > existingTime) {
    return {
      winner: "incoming",
      reason: "incoming_is_newer",
      duplicateIncoming: false
    };
  }

  if (incomingTime < existingTime) {
    return {
      winner: "existing",
      reason: "existing_is_newer",
      duplicateIncoming: false
    };
  }

  if (incoming.version > existing.version) {
    return {
      winner: "incoming",
      reason: "higher_version",
      duplicateIncoming: false
    };
  }

  if (incoming.version < existing.version) {
    return {
      winner: "existing",
      reason: "higher_version",
      duplicateIncoming: false
    };
  }

  return {
    winner: incoming.id.localeCompare(existing.id) > 0 ? "incoming" : "existing",
    reason: "deterministic_tie_breaker",
    duplicateIncoming: false
  };
}
