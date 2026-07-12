const INSECURE_SANDBOX_DEFAULT = 'dev-sandbox-token';

export type FirecrackerLauncherMode = 'stub' | 'real';

export function getFirecrackerLauncherMode(
  env: NodeJS.ProcessEnv = process.env,
): FirecrackerLauncherMode {
  const raw = (env.FIRECRACKER_LAUNCHER_MODE ?? 'stub').toLowerCase();
  return raw === 'real' ? 'real' : 'stub';
}

/**
 * Production must not run with stub Firecracker while advertising hypervisor readiness.
 * Fail-closed when FIRECRACKER_SOCKET is set with mode=stub, or when production
 * requires Firecracker but mode is not real.
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
  } else {
    // production + stub without socket is only OK if explicitly using worker_thread backend
    const backend = env.SANDBOX_BACKEND ?? 'worker_thread_policy_enforcer';
    if (backend.includes('firecracker') || socket) {
      errors.push(
        'Production Firecracker path requires FIRECRACKER_LAUNCHER_MODE=real and a non-stub launcher',
      );
    }
  }

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
} {
  const mode = getFirecrackerLauncherMode(env);
  const socket = env.FIRECRACKER_SOCKET;
  if (mode === 'stub') {
    return {
      firecrackerReady: false,
      backend: 'firecracker-stub',
      launcherMode: 'stub',
    };
  }
  // real mode: ready only when socket path is configured (connectivity probe left to ops)
  return {
    firecrackerReady: Boolean(socket),
    backend: env.SANDBOX_BACKEND ?? 'firecracker',
    launcherMode: 'real',
  };
}
