import { closeDb, getDb } from '../src/lib/server/db';
import { ensureInitialAdmin, setForecast, updateScheduleDraftEntries, upsertDynamic, createStreamer, createManualScheduleDraft } from '../src/lib/server/store';
import { downloadMediaAsset } from '../src/lib/server/media';

const streamerId = createStreamer({ slug: 'e2e-streamer', name: '端到端测试主播', biliUid: '42424242', roomId: '424242' });
const baseTime = new Date('2026-08-20T12:00:00.000Z').getTime();
for (let index = 0; index < 31; index += 1) {
  const id = `e2e-dynamic-${String(index).padStart(2, '0')}`;
  upsertDynamic({ id, streamerId, type: index === 0 ? 'DYNAMIC_TYPE_DRAW' : 'DYNAMIC_TYPE_WORD',
    text: index === 0 ? '目标周表动态 第一版' : `归档动态 ${index}`,
    sourceUrl: `https://www.bilibili.com/opus/${id}`, publishedAt: new Date(baseTime - index * 60_000).toISOString(),
    mediaUrls: index === 0 ? ['data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='] : [] });
}
upsertDynamic({ id: 'e2e-dynamic-00', streamerId, type: 'DYNAMIC_TYPE_DRAW', text: '目标周表动态 第二版',
  sourceUrl: 'https://www.bilibili.com/opus/e2e-dynamic-00', publishedAt: new Date(baseTime).toISOString(),
  mediaUrls: ['data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='] });
const aliasBase = { id: 'e2e-media-alias', streamerId, type: 'DYNAMIC_TYPE_DRAW',
  sourceUrl: 'https://www.bilibili.com/opus/e2e-media-alias', publishedAt: new Date(baseTime + 60_000).toISOString() };
const aliasImage = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
upsertDynamic({ ...aliasBase, text: '别名第一版', mediaUrls: [`${aliasImage}#first`] });
let aliasMedia = getDb().prepare('SELECT media_id FROM dynamic_media WHERE dynamic_id=?').get(aliasBase.id) as { media_id: string };
await downloadMediaAsset(aliasMedia.media_id);
upsertDynamic({ ...aliasBase, text: '别名第二版', mediaUrls: [`${aliasImage}#second`] });
aliasMedia = getDb().prepare('SELECT media_id FROM dynamic_media WHERE dynamic_id=?').get(aliasBase.id) as { media_id: string };
await downloadMediaAsset(aliasMedia.media_id);
upsertDynamic({ ...aliasBase, text: '别名第三版', mediaUrls: [] });
const onePixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
upsertDynamic({ id: 'e2e-video-card', streamerId, type: 'DYNAMIC_TYPE_AV', text: '',
  sourceUrl: 'https://www.bilibili.com/opus/e2e-video-card', publishedAt: new Date(baseTime + 120_000).toISOString(),
  mediaUrls: [onePixel], rawExcerpt: JSON.stringify({ card: { kind: 'video', title: '投稿视频完整卡片', description: '合作投稿简介',
    url: 'https://www.bilibili.com/video/BV1e2e', coverUrl: onePixel, durationText: '03:48', badge: '合作视频',
    viewCount: '2.2万', danmakuCount: '16' } }) });
let cardMedia = getDb().prepare('SELECT media_id FROM dynamic_media WHERE dynamic_id=?').get('e2e-video-card') as { media_id: string };
await downloadMediaAsset(cardMedia.media_id);
const bilibiliEmoji = 'https://i0.hdslb.com/bfs/garb/8968722a8a28574b90980790383526db201b20e5.png';
upsertDynamic({ id: 'e2e-forward-card', streamerId, type: 'DYNAMIC_TYPE_FORWARD', text: '外层正文[外层表情]',
  sourceUrl: 'https://www.bilibili.com/opus/e2e-forward-card', publishedAt: new Date(baseTime + 180_000).toISOString(),
  emojiMap: { '[外层表情]': bilibiliEmoji }, mediaUrls: [onePixel], rawExcerpt: JSON.stringify({ card: { kind: 'forward', authorName: '原动态作者',
    authorUid: '10086', authorAvatarUrl: null, text: '原动态正文[原文表情]', emojiMap: { '[原文表情]': bilibiliEmoji },
    sourceUrl: 'https://www.bilibili.com/opus/e2e-original', originalType: 'DYNAMIC_TYPE_DRAW', mediaUrls: [onePixel],
    video: null, unavailable: false } }) });
cardMedia = getDb().prepare('SELECT media_id FROM dynamic_media WHERE dynamic_id=?').get('e2e-forward-card') as { media_id: string };
await downloadMediaAsset(cardMedia.media_id);
const draftId = createManualScheduleDraft('e2e-dynamic-00');
updateScheduleDraftEntries(draftId, [{ occurrenceDate: null, weekday: 3, localTime: '20:00', status: 'scheduled',
  title: '端到端直播', confidence: 95, sourceText: '周三 20:00 端到端直播' }]);
setForecast({ streamerId, predictedStartAt: new Date(Date.now() + 2 * 3600_000).toISOString(), confidence: 60,
  source: 'manual', reason: '端到端测试预测', evidence: [{ type: 'dynamic', id: 'e2e-dynamic-00' }], uncertaintyMinutes: 45 }, 'e2e');
await ensureInitialAdmin();
getDb().prepare('UPDATE admins SET force_password_change=0').run();
closeDb();
