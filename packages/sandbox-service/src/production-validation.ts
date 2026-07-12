const INSECURE_SANDBOX_DEFAULT = 'dev-sandbox-token';

export function validateSandboxProductionEnv(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const errors: string[] = [];
  const token = process.env.SANDBOX_INTERNAL_TOKEN ?? INSECURE_SANDBOX_DEFAULT;

  if (token === INSECURE_SANDBOX_DEFAULT) {
    errors.push('SANDBOX_INTERNAL_TOKEN must be changed from the dev default');
  }

  if (!process.env.FIRECRACKER_SOCKET) {
    errors.push(
      'FIRECRACKER_SOCKET must be set in production — worker_thread backend is not production-safe',
    );
  }

  if (!process.env.FIRECRACKER_LAUNCHER) {
    errors.push(
      'FIRECRACKER_LAUNCHER must point to an executable microVM launcher script',
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Sandbox production validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }
}