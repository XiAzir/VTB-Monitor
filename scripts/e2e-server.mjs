import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const dataDir = join(tmpdir(), `vtb-monitor-e2e-${randomUUID()}`);
const env = {
  ...process.env,
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: '4313',
  MANAGEMENT_HOST: '127.0.0.1',
  MANAGEMENT_PORT: '4314',
  DATA_DIR: dataDir,
  ADMIN_INITIAL_PASSWORD: 'E2E-Review-2026!'
};
const seeded = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/e2e-seed.ts'], { stdio: 'inherit', env });
if (seeded.status !== 0) process.exit(seeded.status ?? 1);

const child = spawn(process.execPath, ['server/index.js'], {
  stdio: 'inherit',
  env
});

const shutdown = () => child.kill('SIGTERM');
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
