import { error } from '@sveltejs/kit';
import { runAdminPiPrompt } from '$lib/server/pi';

export const POST = async ({ request, locals }) => {
  if (!locals.adminSession) error(401, '未登录');
  if (locals.adminSession.forcePasswordChange) error(403, '请先修改初始化管理员密码');
  const body = await request.json() as { prompt?: string };
  const prompt = body.prompt?.trim();
  if (!prompt || prompt.length > 4000) error(400, '提示词不能为空且不能超过 4000 字符');
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      void runAdminPiPrompt(prompt, (delta) => controller.enqueue(encoder.encode(delta)))
        .then(() => controller.close())
        .catch((reason) => {
          const message = reason instanceof Error ? reason.message : String(reason);
          controller.enqueue(encoder.encode(`\n[Pi 错误] ${message}`));
          controller.close();
        });
    }
  });
  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
};
