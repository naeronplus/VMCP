import type { AlertSeverity } from '@vibrato/shared';
import { getEnv } from '../config/env.js';
import { getPool } from '../db/pool.js';

export async function sendAlert(opts: {
  title: string;
  severity: AlertSeverity;
  body: string;
  code?: string;
  projectId?: string;
  jobId?: string;
}): Promise<void> {
  const env = getEnv();
  const payload = {
    ...opts,
    at: new Date().toISOString(),
  };

  // Persist for dashboard
  await getPool().query(
    `INSERT INTO audit_logs (action, resource_type, resource_id, detail)
     VALUES ('alert.emitted', 'alert', $1, $2)`,
    [opts.code ?? opts.title, JSON.stringify(payload)],
  );

  const webhook = env.SLACK_WEBHOOK_URL || env.ALERT_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
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

  if (
    env.ADMIN_EMAIL &&
    env.SMTP_URL &&
    (opts.severity === 'high' || opts.severity === 'critical')
  ) {
    try {
      const { sendSmtpMail } = await import('./smtp-client.js');
      await sendSmtpMail({
        smtpUrl: env.SMTP_URL,
        from: env.ADMIN_EMAIL,
        to: env.ADMIN_EMAIL,
        subject: `[PGOS ${opts.severity}] ${opts.title}`,
        text: opts.body,
      });
    } catch (err) {
      console.error('SMTP alert failed', err);
    }
  } else if (env.ADMIN_EMAIL && (opts.severity === 'high' || opts.severity === 'critical')) {
    console.info(`[email-alert] to=${env.ADMIN_EMAIL} ${opts.title} (SMTP_URL not configured)`);
  }
}

export async function escalateDeadLetter(
  jobId: string,
  hours: 24 | 72,
  contacts: string[],
): Promise<void> {
  await sendAlert({
    title: `Dead-letter job unresolved (${hours}h)`,
    severity: hours === 72 ? 'critical' : 'high',
    body: `Job ${jobId} remains in dead-letter queue. Contacts: ${contacts.join(', ')}`,
    code: 'E020',
    jobId,
  });
}
