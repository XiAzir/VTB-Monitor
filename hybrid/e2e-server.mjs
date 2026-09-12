import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
const env = { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '4313', MANAGEMENT_PORT: '4314',
  ORIGIN: 'http://127.0.0.1:4313', DISABLE_SCHEDULER: '1', DATA_DIR: join(tmpdir(), `vtbm-hybrid-${randomUUID()}`),
  ADMIN_INITIAL_PASSWORD: 'E2E-Review-2026!', VTBM_SIDECAR_IDLE_MS: '3000', VTBM_APP_ROOT: process.cwd() };
delete env.DATABASE_PATH; delete env.MEDIA_DIR; delete env.VTBM_NATIVE_EXPERIMENTAL;
const seeded = spawnSync(process.execPath, ['--import','tsx','scripts/e2e-seed.ts'], { stdio: 'inherit', env });
if (seeded.status !== 0) process.exit(seeded.status ?? 1);
const child = spawn('rust/target/release/vtb-monitor-rs', [], { stdio: 'inherit', env });
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
