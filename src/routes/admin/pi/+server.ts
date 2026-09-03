import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { runAdminPiPrompt } from '$lib/server/pi';

const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const POST = async ({ request, locals }) => {
  if (!locals.adminSession) error(401, '未登录');
  if (locals.adminSession.forcePasswordChange) error(403, '请先修改初始化管理员密码');
  const body = await request.json() as { prompt?: string; conversationId?: string };
  const prompt = body.prompt?.trim();
  if (!prompt || prompt.length > 4000) error(400, '提示词不能为空且不能超过 4000 字符');
  const conversationId = body.conversationId?.trim() || randomUUID();
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) error(400, '会话 ID 格式无效');
  const conversationKey = `admin_v2:${locals.adminSession.adminId}:${conversationId}`;
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
          abortController.abort();
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };
      const handleRequestAbort = () => {
        closed = true;
        abortController.abort();
      };
      request.signal.addEventListener('abort', handleRequestAbort, { once: true });

      void runAdminPiPrompt(prompt, conversationKey, write, abortController.signal)
        .then(close)
        .catch((reason) => {
          const message = reason instanceof Error ? reason.message : String(reason);
          write(`\n[Pi 错误] ${message}`);
          close();
        })
        .finally(() => request.signal.removeEventListener('abort', handleRequestAbort));
    },
    cancel() {
      closed = true;
      abortController.abort();
    }
  });
  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
};
