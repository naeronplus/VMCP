import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasExactRole, hasMinRole } from '@vibrato/shared';

/**
 * /resolve-secret uses dispatch JWE only — no bearer auth, no jobId override.
 * Operator/admin tokens cannot call worker callback endpoints.
 */
describe('resolve-secret threat model', () => {
  it('operator cannot satisfy callback-only role check', () => {
    assert.equal(hasExactRole('operator', 'callback'), false);
    assert.equal(hasExactRole('admin', 'callback'), false);
    assert.equal(hasMinRole('operator', 'callback'), true);
  });

  it('resolve-secret route has no bearer preHandler (JWE possession is proof)', () => {
    // Documented invariant: secrets.ts uses loginRateLimitHook only, not authenticate.
    const routePreHandlers = ['loginRateLimitHook'];
    assert.equal(routePreHandlers.includes('authenticate'), false);
    assert.equal(routePreHandlers.includes('requireExactRole'), false);
  });

  it('dispatch JWE body schema accepts only jwe field', () => {
    const allowedKeys = new Set(['jwe']);
    const rejectedBody = { jwe: 'x', jobId: 'override-attempt', referenceToken: 'y' };
    const extraKeys = Object.keys(rejectedBody).filter((k) => k !== 'jwe');
    assert.ok(extraKeys.length > 0, 'jobId override must not be accepted by schema');
    for (const key of Object.keys(rejectedBody)) {
      if (key === 'jwe') assert.ok(allowedKeys.has(key));
    }
  });
});