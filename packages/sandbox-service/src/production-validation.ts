const INSECURE_SANDBOX_DEFAULT = 'dev-sandbox-token';

export type FirecrackerLauncherMode = 'stub' | 'real';

/** Normalized production sandbox backend policy (H-08). */
export type SandboxBackendPolicy =
  | 'worker_thread'
  | 'worker_thread_policy_enforcer'
  | 'firecracker'
  | 'firecracker-stub'
  | string;

export function getFirecrackerLauncherMode(
  env: NodeJS.ProcessEnv = process.env,
): FirecrackerLauncherMode {
  const raw = (env.FIRECRACKER_LAUNCHER_MODE ?? 'stub').toLowerCase();
  return raw === 'real' ? 'real' : 'stub';
}

/**
 * H-08 Path B: Railway/container default is worker_thread isolation
 * (no Firecracker hypervisor required).
 */
export function isWorkerThreadBackend(
  backend: string | undefined | null,
): boolean {
  if (!backend) return true;
  const b = backend.toLowerCase();
  return (
    b === 'worker_thread' ||
    b === 'worker_thread_policy_enforcer' ||
    b.startsWith('worker_thread')
  );
}

export function resolveSandboxBackendName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.SANDBOX_BACKEND?.trim()) {
    return env.SANDBOX_BACKEND.trim();
  }
  // Documented production default (H-08 Path B)
  return 'worker_thread';
}

/**
 * Production must not run with stub Firecracker while advertising hypervisor readiness.
 *
 * H-08 Path B: `SANDBOX_BACKEND=worker_thread` (or worker_thread_policy_enforcer)
 * is the **documented production default** and does **not** require FIRECRACKER_*.
 */
export function validateSandboxProductionEnv(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== 'production') return;

  const errors: string[] = [];
  const token = env.SANDBOX_INTERNAL_TOKEN ?? INSECURE_SANDBOX_DEFAULT;

  if (token === INSECURE_SANDBOX_DEFAULT) {
    errors.push('SANDBOX_INTERNAL_TOKEN must be changed from the dev default');
  }

  const mode = getFirecrackerLauncherMode(env);
  const socket = env.FIRECRACKER_SOCKET;
  const launcher = env.FIRECRACKER_LAUNCHER;
  const backend = resolveSandboxBackendName(env);
  const workerThreadPolicy = isWorkerThreadBackend(backend);

  if (socket && mode === 'stub') {
    errors.push(
      'FIRECRACKER_LAUNCHER_MODE=stub is not allowed when FIRECRACKER_SOCKET is set (fail-closed; use real or unset socket)',
    );
  }

  if (mode === 'real') {
    if (!socket) {
      errors.push('FIRECRACKER_SOCKET must be set when FIRECRACKER_LAUNCHER_MODE=real');
    }
    if (!launcher) {
      errors.push(
        'FIRECRACKER_LAUNCHER must point to an executable microVM launcher when mode=real',
      );
    }
  } else if (!workerThreadPolicy) {
    // production + stub without worker_thread policy requires real Firecracker
    if (backend.toLowerCase().includes('firecracker') || socket) {
      errors.push(
        'Production Firecracker path requires FIRECRACKER_LAUNCHER_MODE=real and a non-stub launcher (or set SANDBOX_BACKEND=worker_thread for Path B policy)',
      );
    }
  }
  // worker_thread policy + stub + no socket → OK (H-08 Path B)

  if (errors.length > 0) {
    throw new Error(
      `Sandbox production validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }
}

export function firecrackerHealth(
  env: NodeJS.ProcessEnv = process.env,
): {
  firecrackerReady: boolean;
  backend: string;
  launcherMode: FirecrackerLauncherMode;
  /** Explicit policy label for operators (H-08). */
  policy: 'worker_thread_only' | 'firecracker_real' | 'firecracker_stub' | 'unset';
} {
  const mode = getFirecrackerLauncherMode(env);
  const socket = env.FIRECRACKER_SOCKET;
  const backendName = resolveSandboxBackendName(env);
  const workerThread = isWorkerThreadBackend(backendName);

  // Path B / default: never claim Firecracker ready on stub or worker_thread
  if (mode === 'stub') {
    if (workerThread && !socket) {
      return {
        firecrackerReady: false,
        backend: backendName === 'worker_thread_policy_enforcer'
          ? 'worker_thread_policy_enforcer'
          : 'worker_thread',
        launcherMode: 'stub',
        policy: 'worker_thread_only',
      };
    }
    return {
      firecrackerReady: false,
      backend: 'firecracker-stub',
      launcherMode: 'stub',
      policy: 'firecracker_stub',
    };
  }

  // real mode: ready only when socket path is configured (connectivity probe left to ops)
  return {
    firecrackerReady: Boolean(socket),
    backend: env.SANDBOX_BACKEND ?? 'firecracker',
    launcherMode: 'real',
    policy: 'firecracker_real',
  };
}
