import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('typescript/bin/tsc'))], { stdio: 'inherit' });
cpSync('src/idl', 'dist/idl', { recursive: true });
chmodSync('dist/index.js', 0o755);
