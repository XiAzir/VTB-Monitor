import { building } from '$app/environment';
import type { Handle, ServerInit } from '@sveltejs/kit';
import { ensureInitialAdmin, resolveAdminSession } from '$lib/server/store';
import { registerHybridPi } from '$lib/server/hybrid-pi';
let schedulerModule: typeof import('$lib/server/scheduler') | undefined;

export const init: ServerInit = async () => {
  if (building) return;
  registerHybridPi();
  await ensureInitialAdmin();
  if (process.env.RUN_SCHEDULER === '1' && process.env.DISABLE_SCHEDULER !== '1') {
    schedulerModule = await import('$lib/server/scheduler');
    schedulerModule.startScheduler();
  }
};

if (import.meta.hot) import.meta.hot.dispose(() => schedulerModule?.stopScheduler());

export const handle: Handle = async ({ event, resolve }) => {
  const token = event.cookies.get('vtbm_session');
  event.locals.adminSession = resolveAdminSession(token);
  return resolve(event, {
    filterSerializedResponseHeaders: (name) => name === 'content-type' || name === 'content-length'
  });
};

