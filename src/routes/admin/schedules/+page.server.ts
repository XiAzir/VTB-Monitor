import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  confirmScheduleDraft, getScheduleDraft, listScheduleDrafts, rejectScheduleDraft, requeueScheduleDraft,
  updateScheduleDraftEntries
} from '$lib/server/store';
import type { ScheduleDraftEntry } from '$lib/types';

export const load: PageServerLoad = ({ locals, url }) => {
  if (!locals.adminSession) redirect(303, '/admin');
  if (locals.adminSession.forcePasswordChange) redirect(303, '/admin');
  const status = url.searchParams.get('status') ?? 'all';
  const selectedId = url.searchParams.get('draft');
  return { drafts: listScheduleDrafts(status), selected: selectedId ? getScheduleDraft(selectedId) : null, status };
};

export const actions: Actions = {
  save: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    try {
      updateScheduleDraftEntries(String(form.get('id')), parseEntries(String(form.get('entries') ?? '[]')));
      return { saved: '识别草稿已保存' };
    } catch (reason) { return fail(400, { formError: formatError(reason) }); }
  },
  confirm: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    try {
      const count = confirmScheduleDraft(String(form.get('id')), String(form.get('monday') ?? '').trim() || null,
        `admin:${locals.adminSession!.adminId}`);
      return { saved: `已确认 ${count} 条单周安排` };
    } catch (reason) { return fail(400, { formError: formatError(reason) }); }
  },
  reject: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    rejectScheduleDraft(String(form.get('id')), `admin:${locals.adminSession!.adminId}`);
    return { saved: '周表草稿已拒绝' };
  },
  retry: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    requeueScheduleDraft(String(form.get('id')));
    return { saved: '周表识别已重新加入队列' };
  }
};

function parseEntries(value: string): ScheduleDraftEntry[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('条目必须是 JSON 数组');
  return parsed as ScheduleDraftEntry[];
}

function requireAdmin(session: App.Locals['adminSession']): void {
  if (!session) redirect(303, '/admin');
  if (session.forcePasswordChange) error(403, '请先修改初始化管理员密码');
}

function formatError(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
