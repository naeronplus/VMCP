/**
 * Complete PGOS error classification (§8.1).
 * Each code deep-links to docs under /api/v1/docs/errors/{code}
 */

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ErrorDefinition {
  code: string;
  class: string;
  severity: AlertSeverity;
  operatorAction: string;
  docsPath: string;
  httpStatus: number;
}

export const ERROR_CATALOG = {
  E001: {
    code: 'E001',
    class: 'DISPATCH_TIMEOUT',
    severity: 'high' as const,
    operatorAction:
      'Check GitHub runner availability, possibly fallback tier.',
    docsPath: '/api/v1/docs/errors/E001',
    httpStatus: 504,
  },
  E002: {
    code: 'E002',
    class: 'REIMPORT_FAILED',
    severity: 'medium' as const,
    operatorAction:
      'Inspect reimport_failure.log, check Godot version compatibility.',
    docsPath: '/api/v1/docs/errors/E002',
    httpStatus: 422,
  },
  E003: {
    code: 'E003',
    class: 'VALIDATION_FAILED',
    severity: 'medium' as const,
    operatorAction: 'Review validation report, fix scene errors.',
    docsPath: '/api/v1/docs/errors/E003',
    httpStatus: 422,
  },
  E004: {
    code: 'E004',
    class: 'COMMIT_FAILED',
    severity: 'high' as const,
    operatorAction:
      'Investigate possible stale lock; manually reclaim lock if safe.',
    docsPath: '/api/v1/docs/errors/E004',
    httpStatus: 409,
  },
  E005: {
    code: 'E005',
    class: 'LOCK_STALE_RECOVERED',
    severity: 'low' as const,
    operatorAction: 'Automatic recovery; monitor for patterns.',
    docsPath: '/api/v1/docs/errors/E005',
    httpStatus: 200,
  },
  E006: {
    code: 'E006',
    class: 'EXPORT_TEMPLATE_MISMATCH',
    severity: 'high' as const,
    operatorAction:
      'Update export templates to match Godot editor version.',
    docsPath: '/api/v1/docs/errors/E006',
    httpStatus: 422,
  },
  E007: {
    code: 'E007',
    class: 'UID_DUPLICATE_AUTO_FIXED',
    severity: 'low' as const,
    operatorAction: 'Review auto-fix log, verify no side-effects.',
    docsPath: '/api/v1/docs/errors/E007',
    httpStatus: 200,
  },
  E008: {
    code: 'E008',
    class: 'UID_DUPLICATE_MANUAL',
    severity: 'medium' as const,
    operatorAction: 'Manually resolve conflicting UIDs via dashboard.',
    docsPath: '/api/v1/docs/errors/E008',
    httpStatus: 409,
  },
  E009: {
    code: 'E009',
    class: 'EXTENSION_EXEC_TIMEOUT',
    severity: 'medium' as const,
    operatorAction:
      'Check extension resource limits, possibly increase.',
    docsPath: '/api/v1/docs/errors/E009',
    httpStatus: 504,
  },
  E010: {
    code: 'E010',
    class: 'PARITY_FAILURE',
    severity: 'high' as const,
    operatorAction: 'Compare tier outputs, disable tier if necessary.',
    docsPath: '/api/v1/docs/errors/E010',
    httpStatus: 500,
  },
  E011: {
    code: 'E011',
    class: 'DEP_FAILED',
    severity: 'medium' as const,
    operatorAction:
      'Blocked job depended on a failed generation; re-evaluate inputs.',
    docsPath: '/api/v1/docs/errors/E011',
    httpStatus: 422,
  },
  E012: {
    code: 'E012',
    class: 'GODOT_EDITOR_LOCK',
    severity: 'medium' as const,
    operatorAction:
      'Close Godot editor holding project.godot.lock, then retry.',
    docsPath: '/api/v1/docs/errors/E012',
    httpStatus: 423,
  },
  E013: {
    code: 'E013',
    class: 'FENCING_TOKEN_REJECTED',
    severity: 'high' as const,
    operatorAction:
      'Token is stale after reclaim/failover; re-acquire lock and redispatch.',
    docsPath: '/api/v1/docs/errors/E013',
    httpStatus: 403,
  },
  E014: {
    code: 'E014',
    class: 'PATH_TRAVERSAL',
    severity: 'high' as const,
    operatorAction: 'Reject request; audit caller token and inputs.',
    docsPath: '/api/v1/docs/errors/E014',
    httpStatus: 400,
  },
  E015: {
    code: 'E015',
    class: 'TOKEN_REVOKED',
    severity: 'high' as const,
    operatorAction: 'Client must obtain a new API token.',
    docsPath: '/api/v1/docs/errors/E015',
    httpStatus: 401,
  },
  E016: {
    code: 'E016',
    class: 'EXTENSION_NETWORK_DENIED',
    severity: 'medium' as const,
    operatorAction:
      'Request admin network approval for the extension domains.',
    docsPath: '/api/v1/docs/errors/E016',
    httpStatus: 403,
  },
  E017: {
    code: 'E017',
    class: 'EXTENSION_VERSION_INCOMPATIBLE',
    severity: 'medium' as const,
    operatorAction:
      'Use an extension compatible with the project Godot version.',
    docsPath: '/api/v1/docs/errors/E017',
    httpStatus: 422,
  },
  E018: {
    code: 'E018',
    class: 'RATE_LIMITED',
    severity: 'low' as const,
    operatorAction: 'Back off and retry after the rate-limit window.',
    docsPath: '/api/v1/docs/errors/E018',
    httpStatus: 429,
  },
  E019: {
    code: 'E019',
    class: 'SCRIPT_OVERRIDE_REQUIRES_ADMIN',
    severity: 'medium' as const,
    operatorAction:
      'Override introduces executable script changes; requires admin scope.',
    docsPath: '/api/v1/docs/errors/E019',
    httpStatus: 403,
  },
  E020: {
    code: 'E020',
    class: 'DEAD_LETTER',
    severity: 'high' as const,
    operatorAction:
      'Job failed 3 times; inspect dead-letter queue and retry or archive.',
    docsPath: '/api/v1/docs/errors/E020',
    httpStatus: 500,
  },
  /** M-02: invalid job FSM transitions — never reuse E019 for this. */
  E021: {
    code: 'E021',
    class: 'INVALID_STATUS_TRANSITION',
    severity: 'medium' as const,
    operatorAction:
      'Requested job status is not allowed from the current state; check worker callback order and FSM.',
    docsPath: '/api/v1/docs/errors/E021',
    httpStatus: 409,
  },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export function getError(code: ErrorCode): ErrorDefinition {
  return ERROR_CATALOG[code];
}

export function errorPayload(code: ErrorCode, detail?: string) {
  const def = ERROR_CATALOG[code];
  return {
    error: {
      code: def.code,
      class: def.class,
      severity: def.severity,
      message: detail ?? def.class,
      operatorAction: def.operatorAction,
      docsUrl: def.docsPath,
    },
  };
}
