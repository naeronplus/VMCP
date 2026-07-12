import net from 'node:net';
import tls from 'node:tls';

/**
 * Minimal SMTP client for alert emails (AUTH LOGIN + DATA).
 */
export async function sendSmtpMail(opts: {
  smtpUrl: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const url = new URL(opts.smtpUrl);
  const host = url.hostname;
  const port = Number(url.port || (url.protocol === 'smtps:' ? 465 : 587));
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  const useTls = url.protocol === 'smtps:' || port === 465;

  const session = await openSmtpSession(host, port, useTls);
  try {
    await session.expect(220);
    await session.cmd(`EHLO ${host}`, 250);
    if (!useTls && port === 587) {
      await session.cmd('STARTTLS', 220);
      session.upgradeTls(host);
      await session.cmd(`EHLO ${host}`, 250);
    }
    if (user && pass) {
      await session.cmd('AUTH LOGIN', 334);
      await session.cmd(Buffer.from(user).toString('base64'), 334);
      await session.cmd(Buffer.from(pass).toString('base64'), 235);
    }
    await session.cmd(`MAIL FROM:<${opts.from}>`, 250);
    await session.cmd(`RCPT TO:<${opts.to}>`, 250);
    await session.cmd('DATA', 354);
    const payload = [
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      opts.text,
    ].join('\r\n');
    session.write(`${payload}\r\n.\r\n`);
    await session.expect(250);
    await session.cmd('QUIT', 221);
  } finally {
    session.close();
  }
}

type SmtpSession = {
  cmd(line: string, expectCode: number): Promise<void>;
  expect(expectCode: number): Promise<void>;
  write(data: string): void;
  upgradeTls(servername: string): void;
  close(): void;
};

async function openSmtpSession(
  host: string,
  port: number,
  secure: boolean,
): Promise<SmtpSession> {
  let socket: net.Socket | tls.TLSSocket = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });

  await new Promise<void>((resolve, reject) => {
    socket.once(secure ? 'secureConnect' : 'connect', () => resolve());
    socket.once('error', reject);
  });

  let buffer = '';

  const readLine = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const idx = buffer.indexOf('\r\n');
        if (idx >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          socket.off('data', onData);
          resolve(line);
        }
      };
      socket.on('data', onData);
      socket.once('error', reject);
    });

  const expect = async (expectCode: number): Promise<void> => {
    const line = await readLine();
    const code = Number(line.slice(0, 3));
    if (code !== expectCode) {
      throw new Error(`SMTP expected ${expectCode}, got ${line}`);
    }
  };

  const cmd = async (line: string, expectCode: number): Promise<void> => {
    socket.write(`${line}\r\n`);
    await expect(expectCode);
  };

  return {
    cmd,
    expect,
    write: (data: string) => socket.write(data),
    upgradeTls: (servername: string) => {
      socket = tls.connect({ socket: socket as net.Socket, servername });
    },
    close: () => socket.end(),
  };
}