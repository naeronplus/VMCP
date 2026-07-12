import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const rootWorkflows = join(root, '.github', 'workflows');
const mirrorWorkflows = join(root, 'workers', '.github', 'workflows');

const rootFiles = readdirSync(rootWorkflows).filter((f) => f.endsWith('.yml'));
const mirrorFiles = readdirSync(mirrorWorkflows).filter((f) => f.endsWith('.yml'));

const workerOnly = new Set(['godot_worker.yml', 'godot_health.yml', 'nightly_perf.yml', 'parity_canary.yml']);

let failed = false;
for (const file of workerOnly) {
  if (!rootFiles.includes(file)) {
    console.error(`Missing root workflow: ${file}`);
    failed = true;
    continue;
  }
  if (!mirrorFiles.includes(file)) {
    console.error(`Missing mirror workflow: ${file}`);
    failed = true;
    continue;
  }
  const rootContent = readFileSync(join(rootWorkflows, file), 'utf8');
  const mirrorContent = readFileSync(join(mirrorWorkflows, file), 'utf8');
  const normalize = (s) => s.replace(/\r\n/g, '\n').trimEnd();
  if (normalize(rootContent) !== normalize(mirrorContent)) {
    console.error(`Workflow drift detected: ${file}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log('Workflow mirrors are in sync');