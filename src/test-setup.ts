import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = join(tmpdir(), `vtb-monitor-test-${randomUUID()}`);
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
