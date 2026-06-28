// Load backend/.env (if present) before anything reads process.env.
// Node 20.6+/24 ships process.loadEnvFile; guard for older runtimes.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

try {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, '../../.env'); // backend/.env
  if (existsSync(envPath) && typeof (process as any).loadEnvFile === 'function') {
    (process as any).loadEnvFile(envPath);
  }
} catch {
  /* ignore — env vars can still come from the shell */
}
