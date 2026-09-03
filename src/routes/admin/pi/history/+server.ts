import { error, json } from '@sveltejs/kit';
import { getAdminPiConversation, listAdminPiConversations } from '$lib/server/pi';

const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const GET = ({ url, locals }) => {
  if (!locals.adminSession) error(401, '未登录');
  if (locals.adminSession.forcePasswordChange) error(403, '请先修改初始化管理员密码');
  const conversationId = url.searchParams.get('id')?.trim();
  if (!conversationId) return json({ conversations: listAdminPiConversations(locals.adminSession.adminId) });
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) error(400, '会话 ID 格式无效');
  const messages = getAdminPiConversation(locals.adminSession.adminId, conversationId);
  if (!messages) error(404, '会话不存在');
  return json({ messages });
};
