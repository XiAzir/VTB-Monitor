import { building } from '$app/environment';
import type { Handle, ServerInit } from '@sveltejs/kit';
import { ensureInitialAdmin, resolveAdminSession } from '$lib/server/store';
import { startScheduler } from '$lib/server/scheduler';

export const init: ServerInit = async () => {
  if (building) return;
  await ensureInitialAdmin();
  startScheduler();
};

export const handle: Handle = async ({ event, resolve }) => {
  const token = event.cookies.get('vtbm_session');
  event.locals.adminSession = resolveAdminSession(token);
  return resolve(event, {
    filterSerializedResponseHeaders: (name) => name === 'content-type' || name === 'content-length'
  });
};

