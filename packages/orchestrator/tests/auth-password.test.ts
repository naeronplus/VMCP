import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from '../src/services/auth-service.js';

describe('password hashing', () => {
  it('round-trips scrypt hashes with timing-safe verify', () => {
    const hash = hashPassword('admin-change-me');
    assert.ok(hash.startsWith('scrypt$'));
    assert.equal(verifyPassword('admin-change-me', hash), true);
    assert.equal(verifyPassword('wrong', hash), false);
  });

  it('accepts legacy sha256 hex for migration', () => {
    const legacy = crypto.createHash('sha256').update('admin-change-me').digest('hex');
    assert.equal(verifyPassword('admin-change-me', legacy), true);
    assert.equal(verifyPassword('nope', legacy), false);
  });
});
