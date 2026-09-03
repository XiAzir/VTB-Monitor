import { building } from '$app/environment';
import type { Handle, ServerInit } from '@sveltejs/kit';
import { ensureInitialAdmin, resolveAdminSession } from '$lib/server/store';
import { startScheduler, stopScheduler } from '$lib/server/scheduler';

export const init: ServerInit = async () => {
  if (building) return;
  await ensureInitialAdmin();
  if (process.env.DISABLE_SCHEDULER !== '1') startScheduler();
};

if (import.meta.hot) import.meta.hot.dispose(() => stopScheduler());

export const handle: Handle = async ({ event, resolve }) => {
  const token = event.cookies.get('vtbm_session');
  event.locals.adminSession = resolveAdminSession(token);
  return resolve(event, {
    filterSerializedResponseHeaders: (name) => name === 'content-type' || name === 'content-length'
  });
};
