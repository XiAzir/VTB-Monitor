import { backup } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/lib/server/config';
import { closeDb, getDb } from '../src/lib/server/db';

await mkdir(config.backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = join(config.backupDir, `vtb-monitor-${stamp}.sqlite`);
await backup(getDb(), destination);
closeDb();
console.log(destination);
