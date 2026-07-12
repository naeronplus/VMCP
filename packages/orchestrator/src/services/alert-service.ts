import type { AlertSeverity } from '@vibrato/shared';
import { getEnv } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { sendSmtpMail, type SendSmtpMailFn } from './smtp-client.js';

export type SendAlertOpts = {
  title: string;
  severity: AlertSeverity;
  body: string;
  code?: string;
  projectId?: string;
  jobId?: string;
  /**
   * M-03 / H-14: explicit email recipients (project `admin_contacts`).
   * Accepts a single address or list. ADMIN_EMAIL is always fallback CC
   * (or sole recipient when no contacts are provided).
   */
  to?: string | string[];
  /**
   * When false, still audit + webhook but skip SMTP/console email.
   * Used so job-service can emit an immediate audit event while the
   * dead-letter consumer owns enriched contact email (avoids double mail).
   */
  notifyEmail?: boolean;
}

export type AlertMailDeps = {
  sendMail?: SendSmtpMailFn;
  fetchWebhook?: typeof fetch;
  /** Override env for tests */
  adminEmail?: string;
  smtpUrl?: string;
  slackWebhook?: string;
  alertWebhook?: string;
  /** Skip audit insert when testing without DB */
  persistAudit?: boolean;
};

/**
 * Normalize `string | string[]` contact lists into unique trimmed emails.
 */
export function normalizeEmailList(to?: string | string[] | null): string[] {
  if (to == null) return [];
  const arr = Array.isArray(to) ? to : [to];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    const email = String(raw ?? '').trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

/**
 * Resolve primary recipients + ADMIN_EMAIL fallback CC (6.4.2 / 6.4.4).
 *
 * - contacts present → primary = contacts, cc = ADMIN_EMAIL (if not already primary)
 * - no contacts → primary = ADMIN_EMAIL only (fallback)
 */
export function resolveAlertRecipients(
  to: string | string[] | undefined,
  adminEmail: string | undefined,
): { primary: string[]; cc: string[] } {
  const contacts = normalizeEmailList(to);
  const admin = (adminEmail ?? '').trim();
  if (contacts.length === 0) {
    return { primary: admin ? [admin] : [], cc: [] };
  }
  const adminKey = admin.toLowerCase();
  const alreadyPrimary = admin
    ? contacts.some((c) => c.toLowerCase() === adminKey)
    : true;
  return {
    primary: contacts,
    cc: admin && !alreadyPrimary ? [admin] : [],
  };
}

/**
 * Resolve mail/webhook settings. When tests supply adminEmail + smtpUrl,
 * skip getEnv() so unit tests need no full process.env.
 */
function loadAlertEnv(deps: AlertMailDeps): {
  ADMIN_EMAIL: string;
  SMTP_URL: string;
  SLACK_WEBHOOK_URL: string;
  ALERT_WEBHOOK_URL: string;
} {
  if (deps.adminEmail !== undefined && deps.smtpUrl !== undefined) {
    return {
      ADMIN_EMAIL: deps.adminEmail,
      SMTP_URL: deps.smtpUrl,
      SLACK_WEBHOOK_URL: deps.slackWebhook ?? '',
      ALERT_WEBHOOK_URL: deps.alertWebhook ?? '',
    };
  }
  const env = getEnv();
  return {
    ADMIN_EMAIL: deps.adminEmail ?? env.ADMIN_EMAIL,
    SMTP_URL: deps.smtpUrl ?? env.SMTP_URL,
    SLACK_WEBHOOK_URL: deps.slackWebhook ?? env.SLACK_WEBHOOK_URL,
    ALERT_WEBHOOK_URL: deps.alertWebhook ?? env.ALERT_WEBHOOK_URL,
  };
}

export async function sendAlert(
  opts: SendAlertOpts,
  deps: AlertMailDeps = {},
): Promise<void> {
  const env = loadAlertEnv(deps);
  const payload = {
    ...opts,
    to: normalizeEmailList(opts.to),
    at: new Date().toISOString(),
  };

  const persistAudit = deps.persistAudit !== false;
  if (persistAudit) {
    // Persist for dashboard
    await getPool().query(
      `INSERT INTO audit_logs (action, resource_type, resource_id, detail)
       VALUES ('alert.emitted', 'alert', $1, $2)`,
      [opts.code ?? opts.title, JSON.stringify(payload)],
    );
  }

  const webhook = env.SLACK_WEBHOOK_URL || env.ALERT_WEBHOOK_URL;
  if (webhook) {
    try {
      const doFetch = deps.fetchWebhook ?? fetch;
      await doFetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `[${opts.severity.toUpperCase()}] ${opts.title}: ${opts.body}`,
          ...payload,
        }),
      });
    } catch (err) {
      console.error('alert webhook failed', err);
    }
  }

  const shouldEmail =
    opts.notifyEmail !== false &&
    (opts.severity === 'high' || opts.severity === 'critical');
  if (!shouldEmail) return;

  const adminEmail = env.ADMIN_EMAIL;
  const smtpUrl = env.SMTP_URL;
  const { primary, cc } = resolveAlertRecipients(opts.to, adminEmail);
  const allRecipients = [...primary, ...cc];

  if (allRecipients.length === 0) {
    return;
  }

  if (smtpUrl) {
    try {
      const sendMail = deps.sendMail ?? sendSmtpMail;
      // From must be a configured mailbox; prefer ADMIN_EMAIL, else first recipient.
      const from = (adminEmail || primary[0] || allRecipients[0])!;
      await sendMail({
        smtpUrl,
        from,
        to: primary.length > 0 ? primary : allRecipients,
        cc: cc.length > 0 ? cc : undefined,
        subject: `[PGOS ${opts.severity}] ${opts.title}`,
        text: opts.body,
      });
    } catch (err) {
      console.error('SMTP alert failed', err);
    }
  } else {
    console.info(
      `[email-alert] to=${primary.join(',') || '(none)'} cc=${cc.join(',') || '(none)'} ${opts.title} (SMTP_URL not configured)`,
    );
  }
}

export async function escalateDeadLetter(
  jobId: string,
  hours: 24 | 72,
  contacts: string[],
  deps: AlertMailDeps = {},
  extra?: { projectId?: string; bodyDetail?: string },
): Promise<void> {
  const contactList = normalizeEmailList(contacts);
  const detail =
    extra?.bodyDetail ??
    `Job ${jobId} remains in dead-letter queue after ${hours}h.`;
  const contactLine =
    contactList.length > 0
      ? `Project contacts notified: ${contactList.join(', ')}`
      : 'No project admin_contacts configured; using ADMIN_EMAIL fallback.';

  await sendAlert(
    {
      title: `Dead-letter job unresolved (${hours}h)`,
      severity: hours === 72 ? 'critical' : 'high',
      body: `${detail}\n${contactLine}`,
      code: 'E020',
      jobId,
      projectId: extra?.projectId,
      // 6.4.3: escalation emails admin_contacts (ADMIN_EMAIL is CC/fallback via sendAlert)
      to: contactList,
    },
    deps,
  );
}

/**
 * Build enriched body for H-14 dead-letter consumer notifications.
 */
export function buildDeadLetterEnteredBody(ctx: {
  jobId: string;
  projectId: string;
  projectName?: string | null;
  projectSlug?: string | null;
  status?: string | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  reason?: string | null;
  attempts?: number | null;
  maxAttempts?: number | null;
  tier?: string | null;
  godotVersion?: string | null;
  createdAt?: string | number | null;
  contacts: string[];
}): string {
  const lines = [
    `Job ${ctx.jobId} entered the dead-letter queue (E020).`,
    `Project: ${ctx.projectName ?? ctx.projectId}${ctx.projectSlug ? ` (${ctx.projectSlug})` : ''}`,
    `Status: ${ctx.status ?? 'DEAD_LETTER'}`,
    `Error: ${ctx.errorCode ?? 'E020'}${ctx.errorDetail ? ` — ${ctx.errorDetail}` : ''}`,
    `DLQ reason: ${ctx.reason ?? ctx.errorDetail ?? 'unknown'}`,
    `Attempts: ${ctx.attempts ?? '?'}/${ctx.maxAttempts ?? '?'}`,
    `Tier: ${ctx.tier ?? 'n/a'}`,
    `Godot: ${ctx.godotVersion ?? 'n/a'}`,
    `Entered at: ${ctx.createdAt ? new Date(ctx.createdAt).toISOString() : new Date().toISOString()}`,
    `admin_contacts: ${ctx.contacts.length > 0 ? ctx.contacts.join(', ') : '(none — ADMIN_EMAIL fallback)'}`,
    '',
    'Operator actions: inspect GET /api/v1/dead-letter, retry via POST /api/v1/dead-letter/:jobId/retry, or archive after remediation.',
  ];
  return lines.join('\n');
}
