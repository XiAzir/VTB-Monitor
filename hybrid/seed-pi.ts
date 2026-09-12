/** Deterministic integration fixture. No Bilibili traffic: polling timestamps
 * are in the future, while the explicitly enqueued Pi job remains enabled.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { config } from '../src/lib/server/config';
import { closeDb, getDb } from '../src/lib/server/db';
import { ensureInitialAdmin, createStreamer, upsertDynamic, putSecret, setSetting, createManualScheduleDraft } from '../src/lib/server/store';
if (!process.env.VTBM_TEST_MODE || !process.env.DATA_DIR?.includes('hybrid-test-')) throw new Error('Test fixture requires an isolated directory');
const sid = createStreamer({ name: '原版 Pi 兼容性测试', slug: 'hybrid-pi', biliUid: '969696', roomId: '969696', enabled: true });
const future = new Date(Date.now() + 365 * 86400000).toISOString();
getDb().prepare('UPDATE streamers SET last_dynamic_sync_at=?,last_dynamic_full_sync_at=? WHERE id=?').run(future, future, sid);
getDb().prepare("UPDATE live_state SET status='offline',checked_at=? WHERE streamer_id=?").run(future, sid);
const imageUrl = 'https://i0.hdslb.com/hybrid-nine-mib.gif';
upsertDynamic({ id: 'hybrid-pi-source', streamerId: sid, type: 'DYNAMIC_TYPE_DRAW', text: '直播周表：明天20点直播',
  sourceUrl: 'https://www.bilibili.com/opus/hybrid-pi-source', publishedAt: new Date().toISOString(), mediaUrls: [imageUrl] });
const asset = getDb().prepare('SELECT id FROM media_assets WHERE source_url=?').get(imageUrl) as { id: string };
mkdirSync(config.mediaDir, { recursive: true });
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const image = Buffer.alloc(9 * 1024 * 1024, 0); gif.copy(image);
writeFileSync(join(config.mediaDir, 'hybrid.gif'), image);
getDb().prepare("UPDATE media_assets SET local_path='hybrid.gif',mime_type='image/gif',byte_size=?,sha256=?,state='stored' WHERE id=?")
  .run(image.length, createHash('sha256').update(image).digest('hex'), asset.id);
const draftId = createManualScheduleDraft('hybrid-pi-source');
putSecret('pi_api_key', 'local-fixture-not-a-real-key');
setSetting('pi_profile', { provider: 'anthropic', modelId: 'claude-haiku-4-5', baseUrl: process.env.MOCK_PI_ORIGIN,
  apiKeySecret: 'pi_api_key', thinkingLevel: 'off', reasoning: false, input: ['text','image'], output: ['text'] });
await ensureInitialAdmin();
getDb().prepare('UPDATE admins SET force_password_change=0').run();
getDb().prepare('DELETE FROM jobs').run();
console.log(JSON.stringify({ streamerId: sid, draftId, mediaId: asset.id }));
closeDb();
