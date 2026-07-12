import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcLua = join(root, 'src', 'lua');
const destLua = join(root, 'dist', 'lua');
if (existsSync(srcLua)) {
  mkdirSync(destLua, { recursive: true });
  cpSync(srcLua, destLua, { recursive: true });
}
const srcMig = join(root, 'src', 'db', 'migrations');
const destMig = join(root, 'dist', 'db', 'migrations');
if (existsSync(srcMig)) {
  mkdirSync(destMig, { recursive: true });
  cpSync(srcMig, destMig, { recursive: true });
}
const srcDocs = join(root, '..', '..', 'docs', 'errors');
const destDocs = join(root, 'dist', 'docs', 'errors');
if (existsSync(srcDocs)) {
  mkdirSync(destDocs, { recursive: true });
  cpSync(srcDocs, destDocs, { recursive: true });
}
console.log('Copied lua scripts, migrations, and error docs to dist/');
