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
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateSandboxProductionEnv } from './production-validation.js';
import { buildSandboxApp } from './sandbox-app.js';

export { buildSandboxApp, executeSchema } from './sandbox-app.js';
export {
  runIsolated,
  runWorkerThread,
  runFirecracker,
  memoryLimitToMb,
} from './run-isolated.js';
export {
  validateSandboxProductionEnv,
  firecrackerHealth,
  getFirecrackerLauncherMode,
} from './production-validation.js';

function isExecutedAsMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // Fail-closed production gate (H-08 / production validation)
  validateSandboxProductionEnv();

  const PORT = Number(process.env.PORT ?? 8090);
  const app = buildSandboxApp({ logger: true });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Sandbox service on :${PORT}`);
}

if (isExecutedAsMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
