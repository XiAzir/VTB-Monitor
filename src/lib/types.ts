export type SourceKind = 'manual' | 'dynamic' | 'schedule_confirmed' | 'weekly_schedule' | 'pi' | 'fallback';
export type LiveStatus = 'offline' | 'live' | 'rotating' | 'unknown';
export type SourceState = 'visible' | 'suspected_deleted' | 'deleted' | 'unavailable';
export type ForecastStatus = 'live' | 'cancelled_today' | 'exact' | 'range' | 'insufficient' | 'stale';
export type RoomMappingStatus = 'unverified' | 'verified' | 'conflict';

export interface StreamerSummary {
  id: string;
  slug: string;
  name: string;
  biliUid: string;
  roomId: string;
  resolvedRoomId: string | null;
  roomShortId: string | null;
  roomMappingStatus: RoomMappingStatus;
  avatarUrl: string | null;
  liveStatus: LiveStatus;
  liveTitle: string | null;
  predictedStartAt: string | null;
  confidence: number | null;
  forecastSource: SourceKind | null;
  forecastReason: string | null;
  forecastStale: boolean;
  forecastStatus: ForecastStatus;
  uncertaintyMinutes: number | null;
  lastCheckedAt: string | null;
}

export interface DynamicRecord {
  id: string;
  streamerId: string;
  type: string;
  text: string;
  sourceUrl: string;
  state: SourceState;
  publishedAt: string;
  updatedAt: string;
  commentCount: number;
  likeCount: number;
  media: MediaAsset[];
  emojiMap?: Record<string, string>;
}

export interface MediaAsset {
  id: string;
  sha256: string | null;
  sourceUrl: string;
  localUrl: string | null;
  mimeType: string | null;
  byteSize: number | null;
  state: 'pending' | 'stored' | 'failed' | 'quota_exceeded';
}

export interface CommentRecord {
  id: string;
  dynamicId: string;
  rootId: string | null;
  parentId: string | null;
  authorUid: string;
  authorName: string;
  avatarUrl: string | null;
  message: string;
  likeCount: number;
  replyCount: number;
  isPinned: boolean;
  isStreamer: boolean;
  state: SourceState;
  publishedAt: string;
  media: MediaAsset[];
}

export interface ForecastRecord {
  id: string;
  streamerId: string;
  predictedStartAt: string;
  confidence: number;
  source: SourceKind;
  reason: string;
  evidence: Array<{ type: string; id: string; excerpt?: string }>;
  stale: boolean;
  uncertaintyMinutes: number | null;
  createdAt: string;
}

export interface ScheduleDraftEntry {
  occurrenceDate: string | null;
  weekday: number | null;
  localTime: string | null;
  status: 'scheduled' | 'delayed' | 'cancelled';
  title: string;
  confidence: number;
  sourceText: string;
}

export interface ArchiveCursor {
  publishedAt: string;
  id: string;
}
