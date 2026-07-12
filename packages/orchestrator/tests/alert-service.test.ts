import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeadLetterEnteredBody,
  escalateDeadLetter,
  normalizeEmailList,
  resolveAlertRecipients,
  sendAlert,
  type AlertMailDeps,
} from '../src/services/alert-service.js';
import type { SendSmtpMailOpts } from '../src/services/smtp-client.js';

describe('normalizeEmailList / resolveAlertRecipients (M-03)', () => {
  it('accepts string | string[] and dedupes case-insensitively', () => {
    assert.deepEqual(normalizeEmailList('a@x.com'), ['a@x.com']);
    assert.deepEqual(
      normalizeEmailList(['a@x.com', ' A@x.com ', 'b@y.com', '']),
      ['a@x.com', 'b@y.com'],
    );
    assert.deepEqual(normalizeEmailList(null), []);
    assert.deepEqual(normalizeEmailList(undefined), []);
  });

  it('uses ADMIN_EMAIL as sole fallback when no contacts', () => {
    const r = resolveAlertRecipients(undefined, 'admin@pgos.example');
    assert.deepEqual(r.primary, ['admin@pgos.example']);
    assert.deepEqual(r.cc, []);
  });

  it('puts contacts in primary and ADMIN_EMAIL as CC', () => {
    const r = resolveAlertRecipients(
      ['ops@proj.example', 'lead@proj.example'],
      'admin@pgos.example',
    );
    assert.deepEqual(r.primary, ['ops@proj.example', 'lead@proj.example']);
    assert.deepEqual(r.cc, ['admin@pgos.example']);
  });

  it('does not duplicate ADMIN_EMAIL when already a contact', () => {
    const r = resolveAlertRecipients(
      ['admin@pgos.example', 'ops@proj.example'],
      'admin@pgos.example',
    );
    assert.deepEqual(r.primary, ['admin@pgos.example', 'ops@proj.example']);
    assert.deepEqual(r.cc, []);
  });

  it('returns empty when neither contacts nor ADMIN_EMAIL', () => {
    const r = resolveAlertRecipients([], '');
    assert.deepEqual(r.primary, []);
    assert.deepEqual(r.cc, []);
  });
});

describe('sendAlert email transport (H-14 / M-03)', () => {
  it('emails each project contact and CCs ADMIN_EMAIL via mock transport', async () => {
    const sent: SendSmtpMailOpts[] = [];
    const deps: AlertMailDeps = {
      persistAudit: false,
      adminEmail: 'admin@pgos.example',
      smtpUrl: 'smtp://user:pass@localhost:1025',
      sendMail: async (opts) => {
        sent.push(opts);
      },
    };

    await sendAlert(
      {
        title: 'Job moved to dead-letter queue',
        severity: 'high',
        body: 'enriched body',
        code: 'E020',
        jobId: 'job-1',
        to: ['ops@proj.example', 'lead@proj.example'],
      },
      deps,
    );

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.to, ['ops@proj.example', 'lead@proj.example']);
    assert.deepEqual(sent[0]!.cc, ['admin@pgos.example']);
    assert.match(sent[0]!.subject, /E020|dead-letter|high/i);
    assert.equal(sent[0]!.text, 'enriched body');
    assert.equal(sent[0]!.from, 'admin@pgos.example');
  });

  it('falls back to ADMIN_EMAIL alone when to is empty', async () => {
    const sent: SendSmtpMailOpts[] = [];
    await sendAlert(
      {
        title: 'Alert',
        severity: 'critical',
        body: 'body',
        code: 'E020',
      },
      {
        persistAudit: false,
        adminEmail: 'admin@pgos.example',
        smtpUrl: 'smtp://localhost',
        sendMail: async (opts) => {
          sent.push(opts);
        },
      },
    );
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.to, ['admin@pgos.example']);
    assert.equal(sent[0]!.cc, undefined);
  });

  it('accepts a single string recipient', async () => {
    const sent: SendSmtpMailOpts[] = [];
    await sendAlert(
      {
        title: 'Alert',
        severity: 'high',
        body: 'x',
        to: 'only@proj.example',
      },
      {
        persistAudit: false,
        adminEmail: 'admin@pgos.example',
        smtpUrl: 'smtp://localhost',
        sendMail: async (opts) => {
          sent.push(opts);
        },
      },
    );
    assert.deepEqual(sent[0]!.to, ['only@proj.example']);
    assert.deepEqual(sent[0]!.cc, ['admin@pgos.example']);
  });

  it('skips SMTP when notifyEmail is false', async () => {
    const sent: SendSmtpMailOpts[] = [];
    await sendAlert(
      {
        title: 'Audit only',
        severity: 'high',
        body: 'x',
        to: ['ops@proj.example'],
        notifyEmail: false,
      },
      {
        persistAudit: false,
        adminEmail: 'admin@pgos.example',
        smtpUrl: 'smtp://localhost',
        sendMail: async (opts) => {
          sent.push(opts);
        },
      },
    );
    assert.equal(sent.length, 0);
  });

  it('does not email low/medium severity', async () => {
    const sent: SendSmtpMailOpts[] = [];
    await sendAlert(
      {
        title: 'Info',
        severity: 'medium',
        body: 'x',
        to: ['ops@proj.example'],
      },
      {
        persistAudit: false,
        adminEmail: 'admin@pgos.example',
        smtpUrl: 'smtp://localhost',
        sendMail: async (opts) => {
          sent.push(opts);
        },
      },
    );
    assert.equal(sent.length, 0);
  });
});

describe('escalateDeadLetter (M-03)', () => {
  it('24h is high severity and emails contacts + ADMIN CC', async () => {
    const sent: SendSmtpMailOpts[] = [];
    await escalateDeadLetter(
      'job-dlq-1',
      24,
      ['ops@proj.example'],
      {
        persistAudit: false,
        adminEmail: 'admin@pgos.example',
        smtpUrl: 'smtp://localhost',
        sendMail: async (opts) => {
          sent.push(opts);
        },
      },
    );
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.to, ['ops@proj.example']);
    assert.deepEqual(sent[0]!.cc, ['admin@pgos.example']);
    assert.match(sent[0]!.subject, /high/i);
    assert.match(sent[0]!.subject, /24h/);
    assert.match(sent[0]!.text, /ops@proj\.example/);
  });

  it('72h is critical severity and includes contacts', async () => {
    const sent: SendSmtpMailOpts[] = [];
    await escalateDeadLetter(
      'job-dlq-2',
      72,
      ['lead@proj.example', 'ops@proj.example'],
      {
        persistAudit: false,
        adminEmail: 'admin@pgos.example',
        smtpUrl: 'smtp://localhost',
        sendMail: async (opts) => {
          sent.push(opts);
        },
      },
    );
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.to, ['lead@proj.example', 'ops@proj.example']);
    assert.deepEqual(sent[0]!.cc, ['admin@pgos.example']);
    assert.match(sent[0]!.subject, /critical/i);
    assert.match(sent[0]!.subject, /72h/);
  });

  it('with empty contacts falls back to ADMIN_EMAIL', async () => {
    const sent: SendSmtpMailOpts[] = [];
    await escalateDeadLetter(
      'job-dlq-3',
      24,
      [],
      {
        persistAudit: false,
        adminEmail: 'admin@pgos.example',
        smtpUrl: 'smtp://localhost',
        sendMail: async (opts) => {
          sent.push(opts);
        },
      },
    );
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.to, ['admin@pgos.example']);
    assert.match(sent[0]!.text, /No project admin_contacts/i);
  });
});

describe('buildDeadLetterEnteredBody (H-14 enrichment)', () => {
  it('includes job, project, error, attempts, and contacts', () => {
    const body = buildDeadLetterEnteredBody({
      jobId: 'j1',
      projectId: 'p1',
      projectName: 'Demo',
      projectSlug: 'demo',
      status: 'DEAD_LETTER',
      errorCode: 'E002',
      errorDetail: 'reimport failed',
      reason: 'POST_COMMIT_VERIFY failed',
      attempts: 3,
      maxAttempts: 3,
      tier: 'A',
      godotVersion: '4.3.1',
      createdAt: '2026-07-12T00:00:00.000Z',
      contacts: ['ops@proj.example'],
    });
    assert.match(body, /j1/);
    assert.match(body, /Demo/);
    assert.match(body, /demo/);
    assert.match(body, /E002/);
    assert.match(body, /reimport failed/);
    assert.match(body, /POST_COMMIT_VERIFY/);
    assert.match(body, /3\/3/);
    assert.match(body, /ops@proj\.example/);
    assert.match(body, /dead-letter/);
  });
});
