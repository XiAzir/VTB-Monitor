<script lang="ts">
  import { ArrowLeft, CalendarCheck, ExternalLink, RefreshCw, Save, X } from '@lucide/svelte';
  import { formatDateTime } from '$lib/format';
  import { proxyBilibiliImage } from '$lib/image';
  let { data, form } = $props();
  const statusLabel = (status: string) => ({ pending: '待识别', processing: '识别中', review: '待审核', failed: '失败', confirmed: '已确认', rejected: '已拒绝' })[status] ?? status;
</script>

<svelte:head><title>周表审核 · VTB Monitor</title></svelte:head>
<section class="page schedule-admin">
  <a class="back" href="/admin"><ArrowLeft size={16} /> 返回后台</a>
  <div class="page-heading"><div><h1>周表审核</h1><p>图片识别结果确认后才进入正式单周安排</p></div></div>
  {#if form?.formError}<div class="notice error">{form.formError}</div>{/if}{#if form?.saved}<div class="notice">{form.saved}</div>{/if}
  <nav class="status-tabs"><a href="/admin/schedules">全部</a><a href="/admin/schedules?status=review">待审核</a><a href="/admin/schedules?status=failed">识别失败</a><a href="/admin/schedules?status=confirmed">已确认</a></nav>
  <div class="schedule-layout">
    <div class="draft-list panel">{#if data.drafts.length === 0}<div class="empty">暂无周表草稿</div>{/if}{#each data.drafts as draft}<a class:active={data.selected?.id === draft.id} href={`/admin/schedules?status=${data.status}&draft=${draft.id}`}><strong>{draft.streamerName}</strong><span>{statusLabel(draft.status)} · {formatDateTime(draft.createdAt)}</span><p>{draft.dynamicText || '无正文动态'}</p></a>{/each}</div>
    {#if data.selected}<section class="draft-editor panel"><header><div><strong>{data.selected.streamerName}</strong><span>{statusLabel(data.selected.status)}</span></div><a class="icon-button" href={`/dynamics/${data.selected.dynamicId}`} title="查看来源动态" aria-label="查看来源动态"><ExternalLink size={16} /></a></header>
      <div class="draft-images">{#each data.selected.mediaUrls as url}<img src={proxyBilibiliImage(url)} alt="候选周表" />{/each}</div>
      <p class="source-text">{data.selected.dynamicText}</p>
      {#if data.selected.error}<div class="notice error">{data.selected.error}</div>{/if}
      <form method="POST" action="?/save"><input type="hidden" name="id" value={data.selected.id} /><label for="entries">结构化条目 JSON</label><textarea id="entries" name="entries" rows="16" readonly={data.selected.status === 'confirmed' || data.selected.status === 'rejected'}>{JSON.stringify(data.selected.entries, null, 2)}</textarea>{#if data.selected.status !== 'confirmed' && data.selected.status !== 'rejected'}<button class="button" type="submit"><Save size={15} /> 保存草稿</button>{/if}</form>
      {#if data.selected.status !== 'confirmed' && data.selected.status !== 'rejected'}<div class="review-actions"><form method="POST" action="?/confirm"><input type="hidden" name="id" value={data.selected.id} /><label for="monday">只有星期时所对应的周一</label><input id="monday" name="monday" type="date" /><button class="button primary" type="submit"><CalendarCheck size={15} /> 确认周表</button></form><form method="POST" action="?/retry"><input type="hidden" name="id" value={data.selected.id} /><button class="button" type="submit"><RefreshCw size={15} /> 重新识别</button></form><form method="POST" action="?/reject"><input type="hidden" name="id" value={data.selected.id} /><button class="button danger" type="submit"><X size={15} /> 拒绝</button></form></div>{/if}
    </section>{:else}<div class="panel empty">选择一条草稿开始审核</div>{/if}
  </div>
</section>

<style>
  .back { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13.5px; }
  .back:hover { color: var(--pink-ink); }
  .status-tabs { display: flex; gap: 6px; margin: 14px 0; font-size: 13.5px; }
  .status-tabs a { height: 34px; display: inline-flex; align-items: center; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line); background: #fff; color: var(--muted); }
  .status-tabs a:hover { color: var(--pink-ink); border-color: var(--pink-soft); background: var(--pink-tint); }
  .schedule-layout { display: grid; grid-template-columns: 320px minmax(0,1fr); gap: 16px; align-items: start; }
  .draft-list { overflow: hidden; }
  .draft-list a { display: grid; gap: 4px; padding: 14px 18px; border-bottom: 1px solid var(--line-soft); }
  .draft-list a:last-child { border-bottom: 0; }
  .draft-list a.active { background: var(--pink-tint); }
  .draft-list span, .draft-list p { color: var(--muted-2); font-size: 11.5px; }
  .draft-list p { margin: 3px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .draft-editor { padding: 20px 22px; }
  .draft-editor header { display: flex; justify-content: space-between; align-items: center; }
  .draft-editor header > div { display: grid; gap: 4px; }
  .draft-editor header span { color: var(--muted); font-size: 12.5px; }
  .draft-images { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; margin: 16px 0; }
  .draft-images img { width: 100%; max-height: 420px; object-fit: contain; border-radius: var(--r-sm); background: var(--surface-muted); }
  .source-text { white-space: pre-wrap; line-height: 1.75; }
  .draft-editor label { display: block; margin: 10px 0 6px; color: var(--muted); font-size: 12px; font-weight: 600; }
  .draft-editor textarea { width: 100%; resize: vertical; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-sm); font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12.5px; outline: none; }
  .draft-editor textarea:focus { border-color: var(--pink); box-shadow: 0 0 0 3px rgb(251 114 153 / 16%); }
  .draft-editor input[type='date'] { min-height: 36px; padding: 0 12px; border: 1px solid var(--line); border-radius: var(--r-sm); background: #fff; }
  .draft-editor form > .button { margin-top: 10px; }
  .review-actions { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; margin-top: 16px; }
  .review-actions form:first-child { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; margin-right: auto; }
  @media (max-width: 780px) { .schedule-layout { grid-template-columns: 1fr; } .draft-images { grid-template-columns: 1fr; } }
</style>
