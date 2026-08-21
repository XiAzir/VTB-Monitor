import { access, constants, statfs } from 'node:fs/promises';
import { config, getEncryptionKey } from '../src/lib/server/config';
import { closeDb, getDb } from '../src/lib/server/db';

const results: Array<{ check: string; ok: boolean; detail: string }> = [];
try { getEncryptionKey(); results.push({ check: 'encryption-key', ok: true, detail: 'valid 32-byte key' }); }
catch (error) { results.push({ check: 'encryption-key', ok: false, detail: error instanceof Error ? error.message : String(error) }); }
try {
  await access(config.dataDir, constants.R_OK | constants.W_OK);
  const fs = await statfs(config.dataDir);
  results.push({ check: 'data-directory', ok: true, detail: `${Math.round(Number(fs.bavail * fs.bsize) / 1024 / 1024)} MiB free` });
} catch (error) { results.push({ check: 'data-directory', ok: false, detail: String(error) }); }
try {
  const row = getDb().prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
  results.push({ check: 'sqlite', ok: row.integrity_check === 'ok', detail: String(row.integrity_check) });
} catch (error) { results.push({ check: 'sqlite', ok: false, detail: String(error) }); }
finally { closeDb(); }
for (const result of results) console.log(`${result.ok ? 'OK' : 'FAIL'} ${result.check}: ${result.detail}`);
if (results.some((result) => !result.ok)) process.exitCode = 1;
