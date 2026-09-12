"""One-time integration of reviewed source edits. CI commits the resulting files.
Fails rather than overriding any unrecognized source version. Removed once applied.
"""
from pathlib import Path
import hashlib
root=Path(__file__).resolve().parent.parent
expected={
'rust/Cargo.toml':'f6972d0844b44b171c56ed2fa85bc855f8586329',
'rust/src/api.rs':'59f1259de8ab89572365c742b462ccc0f4b4d8df',
'rust/src/lib.rs':'cb3f20abe5372e9d980d7ade4e36ea823cc1e541',
'rust/src/main.rs':'2fb4d688e4bd3576f2c10afe8f8e2ae856f34eab',
'src/lib/server/pi.ts':'d396a939d5d59bb6dee53bfed90777f23cbdffa0',
}
for name, sha in expected.items():
    b=(root/name).read_bytes()
    actual=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
    if actual!=sha: raise SystemExit('Source changed: '+name)
def edit(name, old, new):
    p=root/name;s=p.read_text()
    if old not in s:raise SystemExit('Missing source anchor: '+name)
    p.write_text(s.replace(old,new))
edit('rust/Cargo.toml','"signal", "macros"','"signal", "macros", "process"')
edit('rust/src/api.rs','async fn local_media(','pub(crate) async fn local_media(')
edit('rust/src/api.rs','async fn image_proxy(','pub(crate) async fn image_proxy(')
edit('rust/src/lib.rs','pub mod api;','pub mod api;\npub mod hybrid;')
edit('rust/src/lib.rs','pub struct App {','pub struct App {\n    pub bridge: Option<Arc<hybrid::Bridge>>,')
edit('rust/src/lib.rs','Ok(Arc::new(Self{db,client','let bridge = if std::env::var("VTBM_NATIVE_EXPERIMENTAL").as_deref() == Ok("1") { None } else { Some(hybrid::Bridge::new()?) };\n        Ok(Arc::new(Self{bridge,db,client')
edit('rust/src/main.rs','forecast,monitor,limits,App','forecast,monitor,hybrid,limits,App')
edit('rust/src/main.rs','let predictions=if enabled {','let predictions=if enabled && app.bridge.is_none() {')
edit('rust/src/main.rs','api::router(app.clone())','if app.bridge.is_some(){hybrid::router(app.clone())}else{api::router(app.clone())}')
edit('rust/src/main.rs','api::management_router(app.clone())','if app.bridge.is_some(){hybrid::management_router(app.clone())}else{api::management_router(app.clone())}')
edit('rust/src/main.rs','        Ok::<(),anyhow::Error>(())','        if let Some(bridge) = &app.bridge { bridge.shutdown().await; }\n        Ok::<(),anyhow::Error>(())')
edit('rust/src/engine.rs','    let entity=strv(job,"entity_id");','    if let Some(bridge) = &app.bridge {\n        if ["rs_analyze_dynamic", "pi_analyze", "pi_revision", "recognize_schedule"].contains(&strv(job, "type")) {\n            return bridge.run_job(app, job).await;\n        }\n    }\n    let entity=strv(job,"entity_id");')
edit('rust/src/hybrid.rs','let api_permit = app.api_slots.clone().try_acquire_owned().map_err(|_|anyhow::anyhow!("BUSY: request capacity"))?;', 'let api_permit = tokio::time::timeout(Duration::from_secs(15), app.api_slots.clone().acquire_owned()).await\n        .context("BUSY: request admission deadline")?.context("request admission closed")?;')
edit('src/hooks.server.ts',"import { startScheduler, stopScheduler } from '$lib/server/scheduler';", "import { registerHybridPi } from '$lib/server/hybrid-pi';\nlet schedulerModule: typeof import('$lib/server/scheduler') | undefined;")
edit('src/hooks.server.ts','  await ensureInitialAdmin();','  registerHybridPi();\n  await ensureInitialAdmin();')
edit('src/hooks.server.ts',"if (process.env.RUN_SCHEDULER === '1' && process.env.DISABLE_SCHEDULER !== '1') startScheduler();", "if (process.env.RUN_SCHEDULER === '1' && process.env.DISABLE_SCHEDULER !== '1') {\n    schedulerModule = await import('$lib/server/scheduler');\n    schedulerModule.startScheduler();\n  }")
edit('src/hooks.server.ts','() => stopScheduler()','() => schedulerModule?.stopScheduler()')
edit('src/lib/server/config.ts',"const mediaDir = resolve(dataDir, 'media');", "const mediaDir = resolve(process.env.MEDIA_DIR ?? resolve(dataDir, 'media'));")
edit('src/lib/server/config.ts',"databasePath: resolve(dataDir, 'vtb-monitor.sqlite')", "databasePath: resolve(process.env.DATABASE_PATH ?? resolve(dataDir, 'vtb-monitor.sqlite'))")
edit('src/lib/server/db.ts','PRAGMA temp_store = MEMORY;',"PRAGMA temp_store = ${process.env.VTBM_HYBRID_CHILD === '1' ? 'FILE' : 'MEMORY'};")
p=root/'src/lib/server/pi.ts';s=p.read_text()
a=s.index('export interface PiProfile {');b=s.index('let activeRuns = 0;',a)
profile="import { getSecret, getSetting } from './store';\n\n"+s[a:b].replace('const DEFAULT_PROFILE','export const DEFAULT_PROFILE')
profile+="export const piRuntime = { activeRuns: 0 };\n\nexport function getPiStatus(): { configured: boolean; profile: PiProfile; activeRuns: number } {\n  const profile = getSetting<PiProfile>('pi_profile', DEFAULT_PROFILE);\n  return { configured: Boolean(getSecret(profile.apiKeySecret ?? 'pi_api_key')), profile, activeRuns: piRuntime.activeRuns };\n}\n"
(root/'src/lib/server/pi-profile.ts').write_text(profile)
s=s[:a]+"import { DEFAULT_PROFILE, piRuntime, getPiStatus, type PiProfile } from './pi-profile';\nexport { getPiStatus };\nexport type { PiProfile };\n"+s[b:].replace('let activeRuns = 0;\n','',1)
a=s.index('export function getPiStatus():');b=s.index('function markPiConnectionValid',a);s=s[:a]+s[b:]
s=s.replace('activeRuns += 1','piRuntime.activeRuns += 1').replace('activeRuns -= 1','piRuntime.activeRuns -= 1').replace('if (activeRuns > 0)','if (piRuntime.activeRuns > 0)')
a=s.index('export interface AdminPiConversationSummary');b=s.index('export async function runAdminPiPrompt',a)
(root/'src/lib/server/pi-history.ts').write_text("import { getDb } from './db';\ntype Row = Record<string, any>;\n\n"+s[a:b])
s=s[:a]+"export { listAdminPiConversations, getAdminPiConversation } from './pi-history';\nexport type { AdminPiConversationSummary, AdminPiDisplayMessage } from './pi-history';\n\n"+s[b:]
s=s.replace("  try {\n    if (signal?.aborted)","  piRuntime.activeRuns += 1;\n  try {\n    if (signal?.aborted)")
s=s.replace("  } finally {\n    signal?.removeEventListener('abort', abort);","  } finally {\n    piRuntime.activeRuns -= 1;\n    signal?.removeEventListener('abort', abort);")
s=s.replace("import { readFile } from 'node:fs/promises';","import { readFile, stat } from 'node:fs/promises';")
s=s.replace('count + batch.images.length','count + batch.positions.length')
s=s.replace('      const batch = scheduleBatch.images;',"      const batch = await loadDraftImages(scheduleBatch.urls);\n      if (batch.length !== scheduleBatch.urls.length) throw new Error('图片证据不完整，识别草稿未提交');")
s=s.replace("    const content = await readFile(resolve(config.mediaDir, String(row.local_path)));\n    if (bytes + content.length > 10 * 1024 * 1024) break;", "    const path = resolve(config.mediaDir, String(row.local_path));\n    const info = await stat(path);\n    if (bytes + info.size > 10 * 1024 * 1024) throw new Error('图片超出单批 10 MiB 限制，需要切片或人工审核；未跳过证据');\n    const content = await readFile(path);\n    if (bytes + content.length > 10 * 1024 * 1024) throw new Error('图片在读取期间变化，识别未提交');")
a=s.index('async function loadScheduleImageBatches');b=s.index('function forceInitialScheduleTool',a)
s=s[:a]+'''async function loadScheduleImageBatches(urls: string[]): Promise<Array<{ urls: string[]; positions: number[] }>> {
  // Plan using metadata only. The caller loads ONE batch just before invoking Pi.
  const batches: Array<{ urls: string[]; positions: number[]; bytes: number }> = [];
  for (const [position, url] of urls.entries()) {
    const row = getDb().prepare(`SELECT m.local_path FROM media_assets m WHERE m.state='stored' AND
      (m.source_url=? OR EXISTS(SELECT 1 FROM media_source_aliases a WHERE a.media_id=m.id AND a.source_url=?)) LIMIT 1`)
      .get(url, url) as Row | undefined;
    if (!row) continue;
    const { size } = await stat(resolve(config.mediaDir, String(row.local_path)));
    if (size > 10 * 1024 * 1024) throw new Error('周表单图超过 10 MiB，需要切片或人工审核；未跳过证据');
    let batch = batches.at(-1);
    if (!batch || batch.urls.length >= 4 || batch.bytes + size > 10 * 1024 * 1024) {
      batch = { urls: [], positions: [], bytes: 0 };
      batches.push(batch);
    }
    batch.urls.push(url); batch.positions.push(position); batch.bytes += size;
  }
  return batches.map(({ urls, positions }) => ({ urls, positions }));
}

'''+s[b:]
s=s.replace('JSON.stringify(message), new Date().toISOString()', "JSON.stringify(message, (_key, value) => value && typeof value === 'object' && value.type === 'image'\n      ? { type: 'text', text: '[图片保存在媒体归档中，不重复写入对话历史]' } : value), new Date().toISOString()")
p.write_text(s)
edit('src/routes/admin/+page.server.ts',"import { getPiStatus } from '$lib/server/pi';", "import { getPiStatus } from '$lib/server/pi-profile';")
edit('src/routes/admin/pi/history/+server.ts',"from '$lib/server/pi'", "from '$lib/server/pi-history'")
print('Original UI and TypeScript Pi integration applied; no .svelte or CSS file was changed.')
