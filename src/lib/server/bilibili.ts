import { createHash } from 'node:crypto';
import type { LiveStatus } from '$lib/types';
import type { NormalizedCommentInput, NormalizedDynamicInput } from './store';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

type JsonObject = Record<string, any>;

export interface LiveRoomTarget {
  /** The value entered by the operator, which may be a real room id or a short id. */
  roomId: string;
  /** The Bilibili UID is the stable identity used to disambiguate room aliases. */
  biliUid?: string;
}

export interface LiveStateResult {
  status: LiveStatus;
  title: string | null;
  uid: string | null;
}

export class BilibiliError extends Error {
  constructor(message: string, public readonly code?: number, public readonly status?: number) {
    super(message);
    this.name = 'BilibiliError';
  }
}

export class BilibiliClient {
  private mixinKey: string | null = null;
  private mixinKeyExpiresAt = 0;

  constructor(private readonly cookie: string | null = null) {}

  async validateCookie(): Promise<{ valid: boolean; loggedIn: boolean; message: string }> {
    const data = await this.fetchJson('https://api.bilibili.com/x/web-interface/nav', {}, false);
    return {
      valid: data.code === 0,
      loggedIn: Boolean(data.data?.isLogin),
      message: data.code === 0 ? (data.data?.isLogin ? 'Cookie 有效' : '当前为匿名状态') : String(data.message ?? '验证失败')
    };
  }

  async fetchSpaceDynamics(biliUid: string, limit = 30, since?: string): Promise<{
    items: NormalizedDynamicInput[];
    complete: boolean;
  }> {
    const items: JsonObject[] = [];
    let offset = '';
    let complete = false;
    let previousOffset = '';
    while (items.length < limit) {
      const url = new URL('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space');
      url.searchParams.set('host_mid', biliUid);
      if (offset) url.searchParams.set('offset', offset);
      const data = await this.fetchJson(url.toString(), { referer: `https://space.bilibili.com/${biliUid}/dynamic` }, false);
      if (data.code !== 0) throw new BilibiliError(String(data.message ?? '动态接口失败'), Number(data.code));
      const pageItems: JsonObject[] = Array.isArray(data.data?.items) ? data.data.items as JsonObject[] : [];
      items.push(...pageItems);
      if (since && pageItems.length > 0 && pageItems.every((item) => dynamicPublishedAt(item) < since)) {
        complete = true;
        break;
      }
      if (!data.data?.has_more || !data.data?.offset || pageItems.length === 0) {
        complete = true;
        break;
      }
      previousOffset = offset;
      offset = String(data.data.offset);
      if (offset === previousOffset) break;
    }
    return {
      items: items.slice(0, limit).map((item) => normalizeDynamic(item, biliUid))
        .filter((item) => !since || item.publishedAt >= since),
      complete
    };
  }

  async fetchDynamicDetail(dynamicId: string): Promise<Pick<NormalizedDynamicInput, 'text' | 'mediaUrls' | 'commentOid' | 'commentType' | 'emojiMap'>> {
    const response = await this.fetchResponse(`https://www.bilibili.com/opus/${dynamicId}`, {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      referer: 'https://www.bilibili.com/'
    });
    const state = extractInitialState(await response.text());
    const detail = state.detail ?? {};
    const modules = Array.isArray(detail.modules) ? detail.modules : [];
    if (!detail.basic || modules.length === 0) throw new BilibiliError('动态已删除或不可见', 404, 404);
    const paragraphs: string[] = [];
    const mediaUrls: string[] = [];
    const emojiMap: Record<string, string> = {};
    for (const module of modules) {
      const content = module?.module_content;
      if (Array.isArray(content?.paragraphs)) {
        for (const paragraph of content.paragraphs) {
          const parts = Array.isArray(paragraph?.text?.nodes) ? paragraph.text.nodes.map((node: JsonObject) => {
            const emoji = node?.rich?.emoji;
            if (emoji?.text && emoji?.icon_url) emojiMap[String(emoji.text)] = normalizeImageUrl(String(emoji.icon_url));
            return node?.word?.words ?? node?.rich?.orig_text ?? node?.text ?? '';
          }).filter(Boolean) : [];
          if (parts.length) paragraphs.push(parts.join(''));
          collectImageUrls(paragraph, mediaUrls);
        }
      }
      collectImageUrls(module?.module_top?.display?.album?.pics, mediaUrls);
    }
    const basic = detail.basic ?? {};
    return { text: paragraphs.join('\n').trim(), mediaUrls: normalizeImageUrls(mediaUrls), emojiMap,
      commentOid: basic.comment_id_str ? String(basic.comment_id_str) : null,
      commentType: basic.comment_type != null ? String(basic.comment_type) : null };
  }

  async fetchDynamicCommentContext(dynamicId: string): Promise<{ oid: string; type: string }> {
    const response = await this.fetchResponse(`https://www.bilibili.com/opus/${dynamicId}`, {
      referer: 'https://www.bilibili.com/'
    });
    const html = await response.text();
    const state = extractInitialState(html);
    const oid = state?.detail?.basic?.comment_id_str;
    const type = state?.detail?.basic?.comment_type;
    if (!oid || !type) throw new BilibiliError('无法从动态页解析评论区标识');
    return { oid: String(oid), type: String(type) };
  }

  async fetchCommentPage(oid: string, type: string, offset = ''): Promise<{
    comments: NormalizedCommentInput[];
    topReplies: JsonObject[];
    nextOffset: string;
    isEnd: boolean;
  }> {
    const params: Record<string, string> = { mode: '2', oid, plat: '1', type, web_location: '1315875' };
    if (offset) params.pagination_str = JSON.stringify({ offset });
    const data = await this.fetchWbi('https://api.bilibili.com/x/v2/reply/wbi/main', params);
    if (data.code !== 0) throw new BilibiliError(String(data.message ?? '评论接口失败'), Number(data.code));
    const replies = Array.isArray(data.data?.replies) ? data.data.replies : [];
    const comments: NormalizedCommentInput[] = [];
    for (const reply of replies) {
      comments.push(normalizeComment(reply, null));
      for (const child of Array.isArray(reply.replies) ? reply.replies : []) {
        comments.push(normalizeComment(child, String(reply.rpid_str ?? reply.rpid)));
      }
    }
    return {
      comments,
      topReplies: replies,
      nextOffset: String(data.data?.cursor?.pagination_reply?.next_offset ?? ''),
      isEnd: Boolean(data.data?.cursor?.is_end)
    };
  }

  async fetchSubReplies(oid: string, type: string, rootId: string, page: number): Promise<NormalizedCommentInput[]> {
    const data = await this.fetchWbi('https://api.bilibili.com/x/v2/reply/reply', {
      oid, type, root: rootId, pn: String(page), ps: '20'
    });
    if (data.code !== 0) throw new BilibiliError(String(data.message ?? '楼中楼接口失败'), Number(data.code));
    return (Array.isArray(data.data?.replies) ? data.data.replies : []).map((reply: JsonObject) => normalizeComment(reply, rootId));
  }

  async fetchLiveStates(targets: Array<string | LiveRoomTarget>): Promise<Map<string, LiveStateResult>> {
    const result = new Map<string, LiveStateResult>();
    if (targets.length === 0) return result;
    const normalizedTargets = targets.map((target) => {
      const input = typeof target === 'string' ? { roomId: target } : target;
      return {
        key: String(input.roomId).trim(),
        roomId: normalizeNumericId(input.roomId),
        biliUid: input.biliUid ? normalizeNumericId(input.biliUid) : null
      };
    }).filter((target): target is { key: string; roomId: string; biliUid: string | null } =>
      target.key.length > 0 && target.roomId !== null);
    if (normalizedTargets.length === 0) return result;

    const url = new URL('https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo');
    for (const roomId of [...new Set(normalizedTargets.map((target) => target.roomId))]) {
      url.searchParams.append('room_ids', roomId);
    }
    for (const biliUid of [...new Set(normalizedTargets.map((target) => target.biliUid).filter(Boolean))]) {
      url.searchParams.append('uids', biliUid!);
    }
    url.searchParams.set('req_biz', 'web_room_componet');
    const data = await this.fetchJson(url.toString(), { referer: 'https://live.bilibili.com/' }, false);
    if (data.code !== 0) throw new BilibiliError(String(data.message ?? '直播状态接口失败'), Number(data.code));
    const roomsByRoomId = asJsonObject(data.data?.by_room_ids);
    const roomsByUid = asJsonObject(data.data?.by_uids);
    for (const target of normalizedTargets) {
      // UID results are preferred because room_id and short_id are aliases, not identities.
      const uidRoom = target.biliUid ? resolveUidRecord(roomsByUid, target.biliUid) : undefined;
      const room = (uidRoom && matchesRoomAlias('', uidRoom, target.roomId) ? uidRoom : undefined)
        ?? resolveRoomRecord(roomsByRoomId, target.roomId, target.biliUid || undefined);
      if (!room) {
        result.set(target.key, { status: 'unknown', title: null, uid: null });
        continue;
      }
      const status: LiveStatus = Number(room.live_status) === 1 ? 'live' : Number(room.live_status) === 2 ? 'rotating' : 'offline';
      result.set(target.key, { status, title: room.title ? String(room.title) : null, uid: room.uid ? String(room.uid) : null });
    }
    return result;
  }

  private async fetchWbi(url: string, params: Record<string, string>): Promise<JsonObject> {
    const key = await this.getMixinKey();
    const withTimestamp: Record<string, string> = { ...params, wts: String(Math.floor(Date.now() / 1000)) };
    const query = Object.keys(withTimestamp).sort().map((name) => {
      const value = withTimestamp[name].replace(/[!'()*]/g, '');
      return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
    }).join('&');
    const signature = createHash('md5').update(query + key).digest('hex');
    return this.fetchJson(`${url}?${query}&w_rid=${signature}`, { referer: 'https://www.bilibili.com/' }, false);
  }

  private async getMixinKey(): Promise<string> {
    if (this.mixinKey && this.mixinKeyExpiresAt > Date.now()) return this.mixinKey;
    const data = await this.fetchJson('https://api.bilibili.com/x/web-interface/nav', {}, false);
    if (data.code !== 0 || !data.data?.wbi_img) throw new BilibiliError(String(data.message ?? '无法获取 WBI 密钥'), Number(data.code));
    const imgKey = basenameWithoutExtension(String(data.data.wbi_img.img_url));
    const subKey = basenameWithoutExtension(String(data.data.wbi_img.sub_url));
    const raw = imgKey + subKey;
    this.mixinKey = MIXIN_KEY_ENC_TAB.map((position) => raw[position]).join('').slice(0, 32);
    this.mixinKeyExpiresAt = Date.now() + 60 * 60 * 1000;
    return this.mixinKey;
  }

  private async fetchJson(url: string, extraHeaders: Record<string, string>, throwOnApiError = true): Promise<JsonObject> {
    const response = await this.fetchResponse(url, extraHeaders);
    let data: JsonObject;
    try { data = await response.json() as JsonObject; }
    catch { throw new BilibiliError('B站返回了非 JSON 响应', undefined, response.status); }
    if (throwOnApiError && data.code !== 0) throw new BilibiliError(String(data.message ?? data.msg ?? 'B站接口失败'), Number(data.code), response.status);
    return data;
  }

  private async fetchResponse(url: string, extraHeaders: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      ...extraHeaders
    };
    if (this.cookie) headers.cookie = this.cookie;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new BilibiliError(`B站 HTTP ${response.status}`, response.status, response.status);
    return response;
  }
}

export function extractInitialState(html: string): JsonObject {
  const marker = 'window.__INITIAL_STATE__';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new BilibiliError('动态页不包含初始状态');
  const start = html.indexOf('{', html.indexOf('=', markerIndex + marker.length) + 1);
  if (start < 0) throw new BilibiliError('动态页初始状态格式无效');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return JSON.parse(html.slice(start, index + 1));
  }
  throw new BilibiliError('动态页初始状态不完整');
}

export function normalizeDynamic(item: JsonObject, streamerId: string): NormalizedDynamicInput {
  const id = String(item.id_str ?? item.id ?? '');
  const modules = item.modules ?? {};
  const dynamic = modules.module_dynamic ?? {};
  const major = dynamic.major ?? {};
  const desc = dynamic.desc?.text ?? item.orig?.modules?.module_dynamic?.desc?.text ?? '';
  const mediaUrls: string[] = [];
  if (Array.isArray(major.draw?.items)) mediaUrls.push(...major.draw.items.map((entry: JsonObject) => entry.src).filter(Boolean));
  if (major.archive?.cover) mediaUrls.push(major.archive.cover);
  if (major.article?.covers) mediaUrls.push(...major.article.covers);
  if (major.opus?.pics) mediaUrls.push(...major.opus.pics.map((entry: JsonObject) => entry.url).filter(Boolean));
  const publishedTs = Number(modules.module_author?.pub_ts ?? item.pub_ts ?? 0);
  const rawAvatarUrl = modules.module_author?.face ? String(modules.module_author.face) : null;
  return {
    id,
    streamerId,
    type: String(item.type ?? 'DYNAMIC_TYPE_UNKNOWN'),
    text: String(desc),
    sourceUrl: `https://www.bilibili.com/opus/${id}`,
    publishedAt: new Date(publishedTs > 0 ? publishedTs * 1000 : Date.now()).toISOString(),
    commentOid: item.basic?.comment_id_str ? String(item.basic.comment_id_str) : null,
    commentType: item.basic?.comment_type != null ? String(item.basic.comment_type) : null,
    commentCount: Number(modules.module_stat?.comment?.count ?? 0),
    likeCount: Number(modules.module_stat?.like?.count ?? 0),
    mediaUrls: normalizeImageUrls(mediaUrls.map(String)),
    rawExcerpt: JSON.stringify({ author: { mid: modules.module_author?.mid, name: modules.module_author?.name }, majorType: major.type }),
    avatarUrl: rawAvatarUrl ? normalizeImageUrl(rawAvatarUrl) : null
  };
}

function dynamicPublishedAt(item: JsonObject): string {
  const ts = Number(item.modules?.module_author?.pub_ts ?? item.pub_ts ?? 0);
  return new Date(ts > 0 ? ts * 1000 : 0).toISOString();
}

function collectImageUrls(value: unknown, output: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const entry of value) collectImageUrls(entry, output); return; }
  const object = value as JsonObject;
  for (const key of ['url', 'src', 'img_src']) {
    if (typeof object[key] === 'string' && /^https?:\/\//.test(object[key]) &&
      (key !== 'url' || /\.(?:jpe?g|png|webp|gif|avif)(?:\?|$)/i.test(object[key]) || /hdslb\.com\/bfs\//i.test(object[key]))) output.push(object[key]);
  }
  for (const [key, child] of Object.entries(object)) {
    if (key === 'url' || key === 'src' || key === 'img_src') continue;
    if (typeof child === 'object') collectImageUrls(child, output);
  }
}

export function normalizeComment(reply: JsonObject, rootId: string | null): NormalizedCommentInput {
  const id = String(reply.rpid_str ?? reply.rpid ?? '');
  const inferredRoot = rootId ?? (Number(reply.root ?? 0) > 0 ? String(reply.root) : null);
  const pictures = Array.isArray(reply.content?.pictures) ? reply.content.pictures : [];
  const rawAvatarUrl = reply.member?.avatar ? String(reply.member.avatar) : null;
  return {
    id,
    dynamicId: '',
    rootId: inferredRoot,
    parentId: Number(reply.parent ?? 0) > 0 ? String(reply.parent) : null,
    authorUid: String(reply.member?.mid ?? '0'),
    authorName: String(reply.member?.uname ?? '未知用户'),
    avatarUrl: rawAvatarUrl ? normalizeImageUrl(rawAvatarUrl) : null,
    message: String(reply.content?.message ?? ''),
    likeCount: Number(reply.like ?? 0),
    replyCount: Number(reply.rcount ?? 0),
    isPinned: Boolean(reply.up_action?.like || reply.reply_control?.is_up_top),
    publishedAt: new Date(Number(reply.ctime ?? 0) * 1000 || Date.now()).toISOString(),
    mediaUrls: normalizeImageUrls(pictures.map((picture: JsonObject) => picture.img_src ?? picture.url ?? picture).filter(Boolean).map(String))
  };
}

/**
 * Resolve a submitted room alias against Bilibili's by_room_ids response.
 *
 * Bilibili normally keys this response by the real room_id even when the
 * request used a short_id. The optional UID prevents a room alias collision
 * from assigning another streamer's state to this streamer.
 */
export function resolveRoomRecord(rooms: JsonObject, roomId: string, expectedUid?: string): JsonObject | undefined {
  const requested = normalizeNumericId(roomId);
  if (!requested) return undefined;
  const candidates = Object.entries(rooms)
    .map(([key, value]) => ({ key, value }))
    .filter(({ value }) => value && typeof value === 'object') as Array<{ key: string; value: JsonObject }>;
  const aliasMatches = candidates.filter(({ key, value }) => matchesRoomAlias(key, value, requested));
  if (aliasMatches.length === 0) return undefined;

  const wantedUid = expectedUid ? normalizeNumericId(expectedUid) : null;
  if (!wantedUid) return aliasMatches[0]?.value;

  const uidMatches = aliasMatches.filter(({ value }) => normalizeNumericId(value.uid) === wantedUid);
  if (uidMatches.length > 0) return uidMatches[0].value;

  // Do not silently bind a known, different UID. Fixtures or future API
  // variants may omit uid, so an alias-only record is still usable then.
  const recordsWithUid = aliasMatches.some(({ value }) => normalizeNumericId(value.uid) !== null);
  return recordsWithUid ? undefined : aliasMatches[0]?.value;
}

function resolveUidRecord(rooms: JsonObject, uid: string): JsonObject | undefined {
  const wantedUid = normalizeNumericId(uid);
  if (!wantedUid) return undefined;
  return Object.entries(rooms).map(([key, value]) => ({ key, value }))
    .filter(({ value }) => value && typeof value === 'object')
    .find(({ key, value }) => normalizeNumericId(key) === wantedUid || normalizeNumericId(value.uid) === wantedUid)?.value;
}

function matchesRoomAlias(responseKey: string, room: JsonObject, requestedInput: unknown): boolean {
  const requested = normalizeNumericId(requestedInput);
  if (!requested) return false;
  return normalizeNumericId(responseKey) === requested
    || normalizeNumericId(room.room_id) === requested
    || normalizePositiveNumericId(room.short_id) === requested;
}

function normalizeNumericId(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  return text.replace(/^0+(?=\d)/, '');
}

function normalizePositiveNumericId(value: unknown): string | null {
  const normalized = normalizeNumericId(value);
  return normalized && normalized !== '0' ? normalized : null;
}

function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function basenameWithoutExtension(url: string): string {
  const part = url.slice(url.lastIndexOf('/') + 1);
  return part.slice(0, part.lastIndexOf('.'));
}

function normalizeImageUrl(url: string): string {
  // Handle protocol-relative URLs (//example.com/image.jpg)
  if (url.startsWith('//')) return `https:${url}`;
  // Upgrade http to https for hdslb.com domains
  if (/^http:\/\/.*\.hdslb\.com\//i.test(url)) return url.replace(/^http:/i, 'https:');
  return url;
}

function normalizeImageUrls(urls: string[]): string[] {
  return [...new Set(urls.map(normalizeImageUrl))];
}
