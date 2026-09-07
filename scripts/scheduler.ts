import { ensureInitialAdmin } from '../src/lib/server/store';
import { startScheduler, stopScheduler } from '../src/lib/server/scheduler';

await ensureInitialAdmin();
startScheduler();
console.log(JSON.stringify({ level: 'info', event: 'scheduler-started', processId: process.pid }));

function shutdown(signal: string): void {
  console.log(JSON.stringify({ level: 'info', event: 'scheduler-stopping', signal }));
  stopScheduler();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
