/**
 * Tier parity canary evaluation (H-12, H-13).
 *
 * - skipped reports (e.g. tier_a_unavailable) must never emit E010
 * - reimport failures and checksum mismatches fail with a distinct reason
 */

export type ParityReportInput = {
  tierAChecksum: string;
  tierBChecksum: string;
  tierADurationMs: number;
  tierBDurationMs: number;
  skipped?: boolean;
  reason?: string;
  diffS3Key?: string;
};

export type ParityEvaluation = {
  /** True only when both tiers ran and checksums match. */
  passed: boolean;
  /** True when comparison was intentionally skipped (no E010). */
  skipped: boolean;
  /** Machine-readable reason: tier_a_unavailable | reimport_failed_* | checksum_mismatch | null */
  reason: string | null;
  /** Whether the orchestrator should send an E010 parity-failure alert. */
  emitE010: boolean;
};

const REIMPORT_REASONS = new Set([
  'reimport_failed_a',
  'reimport_failed_b',
  'reimport_failed_both',
]);

/**
 * Evaluate a parity report body from the canary workflow.
 * Pure function — no I/O — so unit tests can cover skip vs fail semantics.
 */
export function evaluateParityReport(input: ParityReportInput): ParityEvaluation {
  if (input.skipped) {
    return {
      passed: false,
      skipped: true,
      reason: input.reason?.trim() || 'skipped',
      emitE010: false,
    };
  }

  const explicit = input.reason?.trim() || null;

  if (explicit && REIMPORT_REASONS.has(explicit)) {
    return {
      passed: false,
      skipped: false,
      reason: explicit,
      emitE010: true,
    };
  }

  if (explicit === 'tier_b_unavailable') {
    return {
      passed: false,
      skipped: false,
      reason: explicit,
      emitE010: true,
    };
  }

  // Defensive: never treat missing-a as a real mismatch when client forgot skipped flag
  if (
    input.tierAChecksum === 'missing-a' ||
    input.tierAChecksum === '' ||
    input.tierAChecksum === 'unavailable'
  ) {
    return {
      passed: false,
      skipped: true,
      reason: explicit || 'tier_a_unavailable',
      emitE010: false,
    };
  }

  const checksumsMatch = input.tierAChecksum === input.tierBChecksum;
  if (checksumsMatch) {
    return {
      passed: true,
      skipped: false,
      reason: null,
      emitE010: false,
    };
  }

  return {
    passed: false,
    skipped: false,
    reason: explicit || 'checksum_mismatch',
    emitE010: true,
  };
}
