/**
 * L-05: ORCHESTRATOR_CACHE_DIR — local orchestrator-only cache (never worker artifacts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getEnv } from '../config/env.js';

/** Resolved absolute cache directory; created if missing. */
export function ensureOrchestratorCacheDir(): string {
  const raw = getEnv().ORCHESTRATOR_CACHE_DIR;
  const abs = path.resolve(raw);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

/** Subpath under the orchestrator cache dir (created). */
export function orchestratorCachePath(...segments: string[]): string {
  const base = ensureOrchestratorCacheDir();
  const full = path.join(base, ...segments);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}
