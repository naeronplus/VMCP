/**
 * Policy-enforcing isolated runner for /v1/execute.
 * Worker-thread path (dev) or Firecracker launcher (when FIRECRACKER_SOCKET set).
 */
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export type RunIsolatedOpts = {
  extensionId: string;
  inputs: Record<string, unknown>;
  network: boolean;
  approvedDomains: string[];
  timeoutMs: number;
  memoryLimit: number;
};

/** Convert request memory bytes → V8 resourceLimits maxOldGenerationSizeMb (min 64). */
export function memoryLimitToMb(memoryLimitBytes: number): number {
  return Math.max(64, Math.ceil(memoryLimitBytes / (1024 * 1024)));
}

export function resolveExtensionWorkerPath(
  fromDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string {
  return path.join(fromDir, 'extension-worker.js');
}

/**
 * Run extension payload under network / timeout / memory policy.
 * When FIRECRACKER_SOCKET is set, delegates to FIRECRACKER_LAUNCHER.
 */
export async function runIsolated(
  opts: RunIsolatedOpts,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  if (env.FIRECRACKER_SOCKET) {
    return runFirecracker(opts, env);
  }
  return runWorkerThread(opts);
}

export async function runWorkerThread(opts: RunIsolatedOpts): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const workerPath = resolveExtensionWorkerPath();
    const useInline = !fs.existsSync(workerPath);

    const memoryMb = memoryLimitToMb(opts.memoryLimit);
    const workerOptions = {
      workerData: opts,
      resourceLimits: {
        maxOldGenerationSizeMb: memoryMb,
        maxYoungGenerationSizeMb: Math.min(64, memoryMb),
        codeRangeSizeMb: 16,
      },
    };

    const worker = useInline
      ? new Worker(inlineWorkerSource(), { eval: true, ...workerOptions })
      : new Worker(workerPath, workerOptions);

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };

    timer = setTimeout(() => {
      void worker.terminate();
      settle(() => reject(new Error('TIMEOUT: extension killed after limit')));
    }, opts.timeoutMs);

    worker.on('message', (msg: { error?: string; ok?: boolean }) => {
      void worker.terminate();
      settle(() => {
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg);
      });
    });
    worker.on('error', (err) => {
      const message = err?.message ?? String(err);
      const code = (err as NodeJS.ErrnoException)?.code;
      settle(() => {
        if (
          code === 'ERR_WORKER_OUT_OF_MEMORY' ||
          /heap|memory|ERR_WORKER_OUT_OF_MEMORY|resource.?limit/i.test(message)
        ) {
          reject(new Error(`MEMORY_LIMIT: ${message}`));
          return;
        }
        reject(err);
      });
    });
    worker.on('exit', (code) => {
      // After timeout terminate(), exit is expected; ignore if already settled
      if (settled) return;
      if (code !== 0 && code !== null) {
        settle(() =>
          reject(new Error(`MEMORY_LIMIT: worker exited with code ${code}`)),
        );
      }
    });
  });
}

/** Minimal inline worker when extension-worker.js is not beside the module (edge cases). */
function inlineWorkerSource(): string {
  return `
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
  `;
}

export async function runFirecracker(
  opts: RunIsolatedOpts,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const socket = env.FIRECRACKER_SOCKET;
  const launcher = env.FIRECRACKER_LAUNCHER;
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
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } },
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
