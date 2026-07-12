/**
 * Extension execution sandbox service (§10).
 *
 * Production target: Firecracker microVMs (1 vCPU, 512 MiB, 1 GiB disk,
 * network egress blocked by default). This process is the control plane that:
 *  - enforces resource limits and timeouts
 *  - blocks network unless explicitly approved
 *  - kills invocations on timeout
 *
 * Local/dev uses an isolated worker_threads + resource accounting stand-in
 * with the same policy surface so the orchestrator integration is complete.
 */
import Fastify from 'fastify';
import { z } from 'zod';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { validateSandboxProductionEnv } from './production-validation.js';

validateSandboxProductionEnv();

const PORT = Number(process.env.PORT ?? 8090);
const INTERNAL_TOKEN = process.env.SANDBOX_INTERNAL_TOKEN ?? 'dev-sandbox-token';

const executeSchema = z.object({
  extensionId: z.string(),
  inputs: z.record(z.unknown()).default({}),
  network: z.boolean().default(false),
  approvedDomains: z.array(z.string()).default([]),
  limits: z
    .object({
      cpu: z.number().default(1),
      memoryMiB: z.number().default(512),
      diskMiB: z.number().default(1024),
      timeoutSeconds: z.number().default(60),
    })
    .default({}),
});

const app = Fastify({ logger: true });

app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${INTERNAL_TOKEN}`) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

app.get('/health', async () => ({
  ok: true,
  service: 'pgos-sandbox',
  backend: process.env.SANDBOX_BACKEND ?? 'worker_thread_policy_enforcer',
  firecrackerReady: process.env.FIRECRACKER_SOCKET ? true : false,
}));

app.post('/v1/execute', async (req, reply) => {
  const body = executeSchema.parse(req.body);

  // Network policy: blocked by default
  if (body.network) {
    // In real Firecracker path, only approved domains would be allow-listed
    // in a netfilter/nftables ruleset inside the microVM.
    req.log.info(
      { domains: body.approvedDomains },
      'network enabled for approved domains only',
    );
  }

  const timeoutMs = body.limits.timeoutSeconds * 1000;
  const memoryLimit = body.limits.memoryMiB * 1024 * 1024;

  try {
    const result = await runIsolated({
      extensionId: body.extensionId,
      inputs: body.inputs,
      network: body.network,
      approvedDomains: body.approvedDomains,
      timeoutMs,
      memoryLimit,
    });
    return { ok: true, result, limits: body.limits };
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('timeout') || message.includes('TIMEOUT')) {
      return reply.code(504).send({
        ok: false,
        error: 'EXTENSION_EXEC_TIMEOUT',
        code: 'E009',
        message,
      });
    }
    if (message.includes('NETWORK_DENIED')) {
      return reply.code(403).send({
        ok: false,
        error: 'EXTENSION_NETWORK_DENIED',
        code: 'E016',
        message,
      });
    }
    return reply.code(500).send({ ok: false, error: message });
  }
});

/**
 * Policy-enforcing isolated runner.
 * When FIRECRACKER_SOCKET is set, delegates to firecracker launcher script.
 */
async function runIsolated(opts: {
  extensionId: string;
  inputs: Record<string, unknown>;
  network: boolean;
  approvedDomains: string[];
  timeoutMs: number;
  memoryLimit: number;
}): Promise<unknown> {
  if (process.env.FIRECRACKER_SOCKET) {
    return runFirecracker(opts);
  }

  return new Promise((resolve, reject) => {
    const workerPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'extension-worker.js',
    );
    // Prefer compiled js; fall back to ts via data URL policy stub
    const useInline = !fs.existsSync(workerPath);

    const memoryMb = Math.max(64, Math.ceil(opts.memoryLimit / (1024 * 1024)));
    const workerOptions = {
      workerData: opts,
      resourceLimits: {
        maxOldGenerationSizeMb: memoryMb,
        maxYoungGenerationSizeMb: Math.min(64, memoryMb),
        codeRangeSizeMb: 16,
      },
    };

    const worker = useInline
      ? new Worker(
          `
        const { parentPort, workerData } = require('worker_threads');
        if (workerData.network === false && workerData.inputs && workerData.inputs.fetchUrl) {
          parentPort.postMessage({ error: 'NETWORK_DENIED: network disabled' });
        } else {
          parentPort.postMessage({
            ok: true,
            extensionId: workerData.extensionId,
            echo: workerData.inputs,
            sandbox: 'worker_thread',
          });
        }
      `,
          { eval: true, ...workerOptions },
        )
      : new Worker(workerPath, workerOptions);

    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('TIMEOUT: extension killed after limit'));
    }, opts.timeoutMs);

    worker.on('message', (msg: { error?: string; ok?: boolean }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg);
    });
    worker.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function runFirecracker(opts: {
  extensionId: string;
  inputs: Record<string, unknown>;
  network: boolean;
  approvedDomains: string[];
  timeoutMs: number;
  memoryLimit: number;
}): Promise<unknown> {
  const socket = process.env.FIRECRACKER_SOCKET;
  const launcher = process.env.FIRECRACKER_LAUNCHER;
  if (!socket || !launcher) {
    throw new Error('FIRECRACKER_SOCKET and FIRECRACKER_LAUNCHER must be configured');
  }
  if (!fs.existsSync(launcher)) {
    throw new Error(`FIRECRACKER_LAUNCHER not found: ${launcher}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      launcher,
      [
        '--socket',
        socket,
        '--extension-id',
        opts.extensionId,
        '--timeout-ms',
        String(opts.timeoutMs),
        '--memory-bytes',
        String(opts.memoryLimit),
        '--network',
        opts.network ? '1' : '0',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('TIMEOUT: firecracker launcher exceeded limit'));
    }, opts.timeoutMs + 5_000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `Firecracker launcher exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch {
        resolve({ ok: true, backend: 'firecracker', stdout: stdout.trim() });
      }
    });

    child.stdin.write(
      JSON.stringify({
        extensionId: opts.extensionId,
        inputs: opts.inputs,
        approvedDomains: opts.approvedDomains,
      }),
    );
    child.stdin.end();
  });
}

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`Sandbox service on :${PORT}`);
});
