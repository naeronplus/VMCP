/**
 * M-13: Error catalog completeness — CI must fail on catalog/docs drift.
 *
 * Plan §7.3:
 *   7.3.1 Every ERROR_CATALOG key has docs/errors/{code}.md
 *   7.3.2 Every doc maps back to catalog
 *   7.3.3 Codes contiguous E001–E021 (after E021 landed)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ERROR_CATALOG,
  errorPayload,
  getError,
  type ErrorCode,
  type ErrorDefinition,
  type AlertSeverity,
} from './errors.js';

const here = dirname(fileURLToPath(import.meta.url));
/** monorepo root docs/errors relative to packages/shared/src */
const docsErrorsDir = join(here, '../../../docs/errors');

/** Canonical range after E021 landed (plan §7.3.3). */
const FIRST_CODE = 1;
const LAST_CODE = 21;

const SEVERITIES = new Set<AlertSeverity>(['low', 'medium', 'high', 'critical']);

function codeFromNumber(n: number): string {
  return `E${String(n).padStart(3, '0')}`;
}

function parseCodeNumber(code: string): number | null {
  const m = /^E(\d{3})$/.exec(code);
  if (!m) return null;
  return Number(m[1]);
}

function listDocCodes(): string[] {
  assert.ok(existsSync(docsErrorsDir), `missing docs dir: ${docsErrorsDir}`);
  return readdirSync(docsErrorsDir)
    .filter((f) => /^E\d{3}\.md$/.test(f))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

function catalogCodes(): ErrorCode[] {
  return Object.keys(ERROR_CATALOG).sort() as ErrorCode[];
}

// ---------------------------------------------------------------------------
// M-13 — catalog completeness & docs parity
// ---------------------------------------------------------------------------
describe('ERROR_CATALOG completeness (M-13)', () => {
  it('docs/errors directory exists and is a directory', () => {
    assert.ok(existsSync(docsErrorsDir), `missing ${docsErrorsDir}`);
    assert.ok(statSync(docsErrorsDir).isDirectory(), `${docsErrorsDir} is not a directory`);
  });

  it('7.3.3 codes are contiguous E001–E021 with no gaps or extras in catalog', () => {
    const expected = Array.from({ length: LAST_CODE - FIRST_CODE + 1 }, (_, i) =>
      codeFromNumber(FIRST_CODE + i),
    );
    const actual = catalogCodes();

    assert.deepEqual(
      actual,
      expected,
      `catalog keys must be exactly ${expected[0]}…${expected[expected.length - 1]} (contiguous).\n` +
        `expected (${expected.length}): ${expected.join(', ')}\n` +
        `actual   (${actual.length}): ${actual.join(', ')}`,
    );

    // Explicit gap detection with readable message
    for (let n = FIRST_CODE; n <= LAST_CODE; n++) {
      const code = codeFromNumber(n) as ErrorCode;
      assert.ok(
        code in ERROR_CATALOG,
        `gap in ERROR_CATALOG: missing ${code} (contiguous E001–E021 required)`,
      );
    }

    // No codes outside the range
    for (const code of actual) {
      const num = parseCodeNumber(code);
      assert.ok(num !== null, `invalid catalog key shape: ${code}`);
      assert.ok(
        num >= FIRST_CODE && num <= LAST_CODE,
        `catalog has out-of-range code ${code} (allowed E001–E021 only until range is extended with matching docs)`,
      );
    }

    assert.equal(actual.length, LAST_CODE - FIRST_CODE + 1);
  });

  it('7.3.1 every ERROR_CATALOG key has docs/errors/{code}.md', () => {
    const docCodes = new Set(listDocCodes());
    const missing: string[] = [];

    for (const code of catalogCodes()) {
      const file = `${code}.md`;
      if (!docCodes.has(code)) {
        missing.push(code);
        continue;
      }
      const path = join(docsErrorsDir, file);
      assert.ok(existsSync(path), `missing doc file for ${code}: ${path}`);
      const body = readFileSync(path, 'utf8');
      assert.ok(body.trim().length > 0, `empty doc for ${code}`);
      // Title must name the code (operators / deep-link pages)
      assert.match(
        body,
        new RegExp(`^#\\s*${code}\\b`, 'm'),
        `${file} must start with an H1 containing ${code}`,
      );
    }

    assert.equal(
      missing.length,
      0,
      `ERROR_CATALOG codes missing docs/errors/*.md: ${missing.join(', ')}`,
    );
  });

  it('7.3.2 every docs/errors/E*.md maps back to ERROR_CATALOG', () => {
    const catalog = new Set(catalogCodes());
    const orphans: string[] = [];

    for (const code of listDocCodes()) {
      if (!catalog.has(code as ErrorCode)) {
        orphans.push(code);
      }
    }

    assert.equal(
      orphans.length,
      0,
      `orphan error docs (no ERROR_CATALOG entry): ${orphans.join(', ')}. ` +
        `Add the code to packages/shared/src/errors.ts or remove the doc.`,
    );
  });

  it('catalog keys and doc files are exact sets of each other (bidirectional parity)', () => {
    const fromCatalog = catalogCodes();
    const fromDocs = listDocCodes();
    assert.deepEqual(
      fromDocs,
      fromCatalog,
      `catalog/docs drift:\n` +
        `  only in catalog: ${fromCatalog.filter((c) => !fromDocs.includes(c)).join(', ') || '(none)'}\n` +
        `  only in docs:    ${fromDocs.filter((c) => !(fromCatalog as string[]).includes(c)).join(', ') || '(none)'}`,
    );
  });

  it('each ErrorDefinition has required fields and consistent code/docsPath', () => {
    const classes = new Set<string>();
    const codes = new Set<string>();

    for (const key of catalogCodes()) {
      const def: ErrorDefinition = ERROR_CATALOG[key];

      // Key ↔ code field
      assert.equal(def.code, key, `ERROR_CATALOG.${key}.code must equal key`);
      assert.match(def.code, /^E\d{3}$/, `code shape: ${def.code}`);

      // Required string fields
      assert.equal(typeof def.class, 'string');
      assert.ok(def.class.trim().length > 0, `${key}.class empty`);
      assert.equal(typeof def.operatorAction, 'string');
      assert.ok(def.operatorAction.trim().length > 0, `${key}.operatorAction empty`);

      // Severity enum
      assert.ok(
        SEVERITIES.has(def.severity),
        `${key}.severity=${def.severity} not in ${[...SEVERITIES].join('|')}`,
      );

      // HTTP status
      assert.equal(typeof def.httpStatus, 'number');
      assert.ok(
        Number.isInteger(def.httpStatus) && def.httpStatus >= 100 && def.httpStatus <= 599,
        `${key}.httpStatus invalid: ${def.httpStatus}`,
      );

      // Deep-link path used by API / dashboard
      assert.equal(
        def.docsPath,
        `/api/v1/docs/errors/${key}`,
        `${key}.docsPath must be /api/v1/docs/errors/${key}`,
      );

      // Uniqueness
      assert.ok(!codes.has(def.code), `duplicate code field: ${def.code}`);
      codes.add(def.code);
      assert.ok(!classes.has(def.class), `duplicate class name: ${def.class}`);
      classes.add(def.class);
    }
  });

  it('getError and errorPayload cover every catalog code', () => {
    for (const code of catalogCodes()) {
      const def = getError(code);
      assert.equal(def.code, code);
      assert.equal(def, ERROR_CATALOG[code]);

      const payload = errorPayload(code);
      assert.equal(payload.error.code, code);
      assert.equal(payload.error.class, def.class);
      assert.equal(payload.error.severity, def.severity);
      assert.equal(payload.error.operatorAction, def.operatorAction);
      assert.equal(payload.error.docsUrl, def.docsPath);
      assert.equal(payload.error.message, def.class);

      const withDetail = errorPayload(code, 'operator detail');
      assert.equal(withDetail.error.message, 'operator detail');
      assert.equal(withDetail.error.docsUrl, `/api/v1/docs/errors/${code}`);
    }
  });

  it('doc body references the error class name from the catalog', () => {
    // Soft structural check: class token appears in doc (operators can find it).
    // Allows punctuation differences via substring of class tokens.
    const weak: string[] = [];
    for (const code of catalogCodes()) {
      const def = ERROR_CATALOG[code];
      const body = readFileSync(join(docsErrorsDir, `${code}.md`), 'utf8');
      // Class is SCREAMING_SNAKE — require full class string in doc
      if (!body.includes(def.class)) {
        weak.push(`${code} (missing class ${def.class})`);
      }
    }
    assert.equal(
      weak.length,
      0,
      `docs must mention catalog class name:\n  ${weak.join('\n  ')}`,
    );
  });

  it('rejects accidental non-E*.md pollution only by not treating them as catalog docs', () => {
    // Non-matching files are allowed (README, etc.) but must not break listDocCodes.
    const all = readdirSync(docsErrorsDir);
    const eFiles = all.filter((f) => /^E\d{3}\.md$/.test(f));
    assert.equal(eFiles.length, LAST_CODE - FIRST_CODE + 1);
    // Every E###.md is accounted for above; extra non-matching files OK
    for (const f of eFiles) {
      assert.match(f, /^E\d{3}\.md$/);
    }
  });
});

// ---------------------------------------------------------------------------
// M-02 — E019 vs E021 semantics (kept so M-13 file remains the catalog suite)
// ---------------------------------------------------------------------------
describe('ERROR_CATALOG E019 vs E021 (M-02)', () => {
  it('E019 is SCRIPT_OVERRIDE_REQUIRES_ADMIN with 403', () => {
    const e = getError('E019');
    assert.equal(e.class, 'SCRIPT_OVERRIDE_REQUIRES_ADMIN');
    assert.equal(e.httpStatus, 403);
    assert.equal(e.docsPath, '/api/v1/docs/errors/E019');
  });

  it('E021 is INVALID_STATUS_TRANSITION with 409', () => {
    const e = getError('E021');
    assert.equal(e.class, 'INVALID_STATUS_TRANSITION');
    assert.equal(e.httpStatus, 409);
    assert.equal(e.docsPath, '/api/v1/docs/errors/E021');
  });

  it('E019 and E021 are distinct codes and classes', () => {
    assert.notEqual(ERROR_CATALOG.E019.code, ERROR_CATALOG.E021.code);
    assert.notEqual(ERROR_CATALOG.E019.class, ERROR_CATALOG.E021.class);
  });

  it('E021 doc distinguishes from E019', () => {
    const body = readFileSync(join(docsErrorsDir, 'E021.md'), 'utf8');
    assert.match(body, /INVALID_STATUS_TRANSITION/);
    assert.match(body, /E019/);
    assert.match(body, /409/);
  });

  it('E019 doc states FSM transitions are E021', () => {
    const body = readFileSync(join(docsErrorsDir, 'E019.md'), 'utf8');
    assert.match(body, /SCRIPT_OVERRIDE/);
    assert.match(body, /E021/);
  });
});
