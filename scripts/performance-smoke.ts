import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'vtbm-performance-'));
process.env.DATA_DIR = dataDir;
const { closeDb, getDb } = await import('../src/lib/server/db');
const { listCommentsPage, listDynamicsPage } = await import('../src/lib/server/store');

const db = getDb();
const now = new Date().toISOString();
db.exec('BEGIN IMMEDIATE');
try {
  const insertStreamer = db.prepare(`INSERT INTO streamers(id,slug,name,bili_uid,room_id,dynamic_url,live_url,created_at,updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertDynamic = db.prepare(`INSERT INTO dynamics(id,streamer_id,type,text,source_url,published_at,updated_at,last_seen_at,content_hash)
    VALUES (?, ?, 'word', ?, ?, ?, ?, ?, ?)`);
  const insertComment = db.prepare(`INSERT INTO comments(id,dynamic_id,author_uid,author_name,message,content_hash,published_at,updated_at,last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let streamer = 0; streamer < 20; streamer += 1) {
    const streamerId = `perf-streamer-${streamer}`;
    insertStreamer.run(streamerId, `perf-${streamer}`, `性能主播 ${streamer}`, `10${streamer}`, `20${streamer}`,
      `https://space.bilibili.com/10${streamer}/dynamic`, `https://live.bilibili.com/20${streamer}`, now, now);
    for (let dynamic = 0; dynamic < 2500; dynamic += 1) {
      const dynamicId = `perf-dynamic-${streamer}-${dynamic}`;
      const published = new Date(Date.now() - dynamic * 60_000).toISOString();
      insertDynamic.run(dynamicId, streamerId, `性能动态 ${dynamic}`, `https://example.invalid/${dynamicId}`, published, now, now, dynamicId);
      for (let comment = 0; comment < 10; comment += 1) {
        const commentId = `perf-comment-${streamer}-${dynamic}-${comment}`;
        insertComment.run(commentId, dynamicId, String(comment), `用户 ${comment}`, `评论 ${comment}`, commentId, published, now, now);
      }
    }
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

const started = performance.now();
for (let index = 0; index < 100; index += 1) listDynamicsPage(`perf-streamer-${index % 20}`, 30, undefined, { q: '性能动态' });
for (let index = 0; index < 100; index += 1) listCommentsPage(`perf-dynamic-${index % 20}-${index % 2500}`, 50);
const elapsed = performance.now() - started;
const rssMb = process.memoryUsage().rss / 1024 / 1024;
const averageMs = elapsed / 200;
console.log(JSON.stringify({ streamers: 20, dynamics: 50_000, comments: 500_000,
  averageQueryMs: Math.round(averageMs * 10) / 10, rssMb: Math.round(rssMb), limits: { queryMs: 500, rssMb: 700 } }));
closeDb();
await rm(dataDir, { recursive: true, force: true });
if (averageMs >= 500 || rssMb >= 700) process.exitCode = 1;
