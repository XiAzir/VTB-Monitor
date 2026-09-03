import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getPiStatus } from '$lib/server/pi';
import {
  acknowledgeAlert, acknowledgeAllAlerts, changeAdminPassword, createAdminSession, createApiToken, createStreamer, deleteAdminSession, enqueueJob,
  findAdminByUsername, getDashboardStats, getSetting, listAdminStreamers, listAlerts, listApiTokens,
  deleteSecret, listAudit, listJobs, listSecretMetadata, putSecret, queuePiManualAnalysis, replaceManualScheduleRules, revokeApiToken, setForecast, setSetting, updateStreamer
} from '$lib/server/store';
import { verifyPassword } from '$lib/server/security';
import type { PiProfile } from '$lib/server/pi';
import { createHash } from 'node:crypto';
import { bilibiliCookiePoolKey } from '$lib/server/bilibili-cookie-pool';

interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from: string;
  to: string;
}

export const load: PageServerLoad = ({ locals }) => {
  if (!locals.adminSession) return { authenticated: false as const };
  return {
    authenticated: true as const,
    admin: locals.adminSession,
    stats: getDashboardStats(),
    streamers: listAdminStreamers(),
    alerts: listAlerts(),
    jobs: listJobs(30),
    audit: listAudit(30),
    secrets: listSecretMetadata(),
    tokens: listApiTokens(),
    pi: getPiStatus(),
    bilibiliProxyUrl: getSetting<string>('bilibili_proxy_url', ''),
    smtp: getSetting<SmtpSettings | null>('smtp', null)
  };
};

export const actions: Actions = {
  login: async ({ request, cookies }) => {
    const form = await request.formData();
    const username = String(form.get('username') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const admin = findAdminByUsername(username);
    if (!admin || !(await verifyPassword(password, String(admin.password_hash)))) return fail(400, { loginError: '用户名或密码错误' });
    const token = createAdminSession(String(admin.id));
    cookies.set('vtbm_session', token, { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 3600 });
    redirect(303, '/admin');
  },
  logout: ({ cookies }) => {
    const token = cookies.get('vtbm_session');
    if (token) deleteAdminSession(token);
    cookies.delete('vtbm_session', { path: '/' });
    redirect(303, '/admin');
  },
  changePassword: async ({ request, locals, cookies }) => {
    requireAdmin(locals.adminSession, true);
    const form = await request.formData();
    const password = String(form.get('password') ?? '');
    const confirm = String(form.get('confirm') ?? '');
    if (password !== confirm) return fail(400, { formError: '两次输入的密码不一致' });
    try {
      await changeAdminPassword(locals.adminSession!.adminId, password, `admin:${locals.adminSession!.adminId}`);
    } catch (error) { return fail(400, { formError: formatError(error) }); }
    cookies.delete('vtbm_session', { path: '/' });
    redirect(303, '/admin');
  },
  createStreamer: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    try {
      const id = createStreamer({
        name: String(form.get('name') ?? ''), slug: String(form.get('slug') ?? ''),
        biliUid: String(form.get('biliUid') ?? ''), roomId: String(form.get('roomId') ?? ''),
        dynamicUrl: String(form.get('dynamicUrl') ?? '').trim() || undefined,
        liveUrl: String(form.get('liveUrl') ?? '').trim() || undefined
      }, `admin:${locals.adminSession!.adminId}`);
      return { createdStreamerId: id };
    } catch (error) { return fail(400, { formError: formatError(error) }); }
  },
  updateStreamer: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    try {
      updateStreamer(String(form.get('id')), {
        name: String(form.get('name') ?? ''), slug: String(form.get('slug') ?? ''),
        biliUid: String(form.get('biliUid') ?? ''), roomId: String(form.get('roomId') ?? ''),
        dynamicUrl: String(form.get('dynamicUrl') ?? ''), liveUrl: String(form.get('liveUrl') ?? ''),
        enabled: form.get('enabled') === 'on', livePollSeconds: Number(form.get('livePollSeconds')),
        dynamicPollSeconds: Number(form.get('dynamicPollSeconds'))
      }, Number(form.get('version')), `admin:${locals.adminSession!.adminId}`);
      return { saved: '主播配置已更新' };
    } catch (error) { return fail(400, { formError: formatError(error) }); }
  },
  setManualForecast: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    try {
      const predicted = new Date(String(form.get('predictedStartAt') ?? ''));
      setForecast({ streamerId: String(form.get('streamerId')), predictedStartAt: predicted.toISOString(),
        confidence: Number(form.get('confidence') ?? 100), source: 'manual',
        reason: String(form.get('reason') ?? '').trim() || '管理员人工设置', evidence: [] }, `admin:${locals.adminSession!.adminId}`);
      return { saved: '人工预测已锁定' };
    } catch (error) { return fail(400, { formError: formatError(error) }); }
  },
  saveManualSchedule: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    try {
      const rules = String(form.get('rules') ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const match = line.match(/^([1-7])\s+([0-2]\d:[0-5]\d)(?:\s+(.+))?$/);
        if (!match) throw new Error(`周表行格式错误：${line}`);
        return { weekday: Number(match[1]), localTime: match[2], title: match[3] };
      });
      replaceManualScheduleRules(String(form.get('streamerId')), rules, `admin:${locals.adminSession!.adminId}`);
      return { saved: rules.length ? '人工周表已保存并锁定' : '人工周表已清空' };
    } catch (error) { return fail(400, { formError: formatError(error) }); }
  },
  saveCookie: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    const cookieInput = String(form.get('cookie') ?? '').trim();
    if (!cookieInput) return fail(400, { formError: 'Cookie 不能为空' });
    const cookies = cookieInput.split(/\r?\n\s*\r?\n/).map((value) => value.trim()).filter(Boolean);
    const actor = `admin:${locals.adminSession!.adminId}`;
    if (cookies.length === 1) {
      putSecret('bilibili_cookie', cookies[0], actor);
    } else {
      for (const cookie of cookies) {
        const id = createHash('sha256').update(cookie).digest('hex').slice(0, 12);
        putSecret(bilibiliCookiePoolKey(id), cookie, actor);
      }
    }
    enqueueJob('validate_cookie', null, {}, 1, new Date().toISOString(), `validate-cookie:${Date.now()}`);
    return { saved: cookies.length > 1 ? `已加密保存 ${cookies.length} 个 B站 Cookie` : 'B站 Cookie 已加密保存' };
  },
  deleteCookie: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const key = String((await request.formData()).get('key') ?? '').trim();
    if (!key.startsWith('bilibili_cookie_pool:')) return fail(400, { formError: '只能删除 Cookie 池条目' });
    deleteSecret(key, `admin:${locals.adminSession!.adminId}`);
    return { saved: 'Cookie 池条目已删除' };
  },
  saveBilibiliProxy: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    const value = String(form.get('proxyUrl') ?? '').trim();
    if (value) {
      let parsed: URL;
      try { parsed = new URL(value); } catch { return fail(400, { formError: 'B站代理 URL 格式无效' }); }
      if (!['http:', 'https:'].includes(parsed.protocol)) return fail(400, { formError: 'B站代理仅支持 HTTP 或 HTTPS' });
    }
    setSetting('bilibili_proxy_url', value || null, `admin:${locals.adminSession!.adminId}`);
    enqueueJob('validate_cookie', null, {}, 1, new Date().toISOString(), `validate-cookie:proxy:${Date.now()}`);
    return { saved: value ? 'B站代理已保存并开始验证' : 'B站代理已清空' };
  },
  savePi: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    const provider = String(form.get('provider') ?? 'openai');
    const modelId = String(form.get('modelId') ?? '').trim();
    if (!modelId) return fail(400, { formError: '模型 ID 不能为空' });
    const input: PiProfile['input'] = form.get('supportsImage') === 'on' ? ['text', 'image'] : ['text'];
    setSetting('pi_profile', { provider, modelId, baseUrl: String(form.get('baseUrl') ?? '').trim() || undefined,
      apiKeySecret: 'pi_api_key', thinkingLevel: String(form.get('thinkingLevel') ?? 'low'), input, output: ['text'],
      reasoning: form.get('reasoning') === 'on', sessionAffinity: form.get('sessionAffinity') === 'on' }, `admin:${locals.adminSession!.adminId}`);
    const apiKey = String(form.get('apiKey') ?? '').trim();
    if (apiKey) putSecret('pi_api_key', apiKey, `admin:${locals.adminSession!.adminId}`);
    return { saved: 'Pi 配置已保存' };
  },
  saveSmtp: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    setSetting('smtp', { host: String(form.get('host') ?? '').trim(), port: Number(form.get('port') ?? 587),
      secure: form.get('secure') === 'on', username: String(form.get('username') ?? '').trim(),
      from: String(form.get('from') ?? '').trim(), to: String(form.get('to') ?? '').trim() }, `admin:${locals.adminSession!.adminId}`);
    const password = String(form.get('password') ?? '').trim();
    if (password) putSecret('smtp_password', password, `admin:${locals.adminSession!.adminId}`);
    return { saved: 'SMTP 配置已保存' };
  },
  createToken: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    const scopes = form.getAll('scope').map(String);
    const created = createApiToken(String(form.get('name') ?? 'server-agent'), scopes, `admin:${locals.adminSession!.adminId}`);
    return { apiToken: created.token };
  },
  revokeToken: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    try {
      revokeApiToken(String(form.get('tokenId') ?? ''), `admin:${locals.adminSession!.adminId}`);
      return { saved: '管理 API 令牌已撤销' };
    } catch (reason) { return fail(400, { formError: formatError(reason) }); }
  },
  runOperation: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    const streamerId = String(form.get('streamerId') ?? '');
    const operation = String(form.get('operation') ?? 'sync');
    if (operation === 'refresh' || operation === 'sync') enqueueJob('sync_streamer', streamerId,
      operation === 'refresh' ? { fullSync: true } : {}, 5, new Date().toISOString(), `admin:${operation}:${streamerId}:${Date.now()}`);
    else queuePiManualAnalysis(streamerId, operation);
    return { saved: '任务已加入队列' };
  },
  acknowledge: async ({ request, locals }) => {
    requireAdmin(locals.adminSession);
    const form = await request.formData();
    acknowledgeAlert(String(form.get('alertId')), `admin:${locals.adminSession!.adminId}`);
    return { saved: '告警已确认' };
  }
  ,acknowledgeAll: async ({ locals }) => {
    requireAdmin(locals.adminSession);
    const count = acknowledgeAllAlerts(`admin:${locals.adminSession!.adminId}`);
    return { saved: count ? `已确认 ${count} 条告警` : '当前没有待处理告警' };
  }
};

function requireAdmin(session: App.Locals['adminSession'], allowPasswordChange = false): void {
  if (!session) redirect(303, '/admin');
  if (session.forcePasswordChange && !allowPasswordChange) error(403, '请先修改初始化管理员密码');
}
function formatError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
