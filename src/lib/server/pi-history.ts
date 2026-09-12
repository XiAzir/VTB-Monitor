import { getDb } from './db';
type Row = Record<string, any>;

export interface AdminPiConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface AdminPiDisplayMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

export function listAdminPiConversations(adminId: string): AdminPiConversationSummary[] {
  const prefix = `admin_v2:${adminId}:`;
  const rows = getDb().prepare(`SELECT kind,title,updated_at FROM pi_conversations
    WHERE streamer_id IS NULL AND kind LIKE ? ORDER BY updated_at DESC LIMIT 50`).all(`${prefix}%`) as Row[];
  return rows.map((row) => ({ id: String(row.kind).slice(prefix.length), title: String(row.title), updatedAt: String(row.updated_at) }));
}

export function getAdminPiConversation(adminId: string, conversationId: string): AdminPiDisplayMessage[] | null {
  const conversation = getDb().prepare('SELECT id FROM pi_conversations WHERE streamer_id IS NULL AND kind=?')
    .get(`admin_v2:${adminId}:${conversationId}`) as Row | undefined;
  if (!conversation) return null;
  const rows = getDb().prepare(`SELECT role,content_json,created_at FROM pi_messages WHERE conversation_id=?
    AND role IN ('user','assistant') ORDER BY created_at,id LIMIT 200`).all(String(conversation.id)) as Row[];
  return rows.flatMap((row) => {
    try {
      const message = JSON.parse(String(row.content_json)) as Row;
      const text = typeof message.content === 'string' ? message.content
        : Array.isArray(message.content) ? message.content
          .filter((block: Row) => block?.type === 'text' && typeof block.text === 'string')
          .map((block: Row) => String(block.text)).join('') : '';
      const role = String(row.role);
      return text && (role === 'user' || role === 'assistant')
        ? [{ role, text, createdAt: String(row.created_at) } as AdminPiDisplayMessage] : [];
    } catch { return []; }
  });
}

