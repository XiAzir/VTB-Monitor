import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const child = spawn(process.execPath, ['server/index.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '4313',
    MANAGEMENT_HOST: '127.0.0.1',
    MANAGEMENT_PORT: '4314',
    DATA_DIR: join(tmpdir(), `vtb-monitor-e2e-${randomUUID()}`)
  }
});

const shutdown = () => child.kill('SIGTERM');
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
