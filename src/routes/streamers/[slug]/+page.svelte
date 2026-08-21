<script lang="ts">
  import { ArrowLeft, CalendarDays, Clock3, ExternalLink, MessageSquare, Radio, RefreshCw, History, Image as ImageIcon } from '@lucide/svelte';
  import { confidenceClass, formatDateTime, relativeTime, sourceLabel, richTextHtml } from '$lib/format';
  let { data } = $props();
  const weekdays = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
</script>

<svelte:head><title>{data.streamer.name} · 监控室老大爷</title></svelte:head>

<section class="page">
  <a class="back" href="/"><ArrowLeft size={16} /> 返回监控台</a>
  <div class="streamer-header">
    {#if data.streamer.avatarUrl}<img src={data.streamer.avatarUrl} alt="" />{/if}
    <div class="streamer-title">
      <h1>{data.streamer.name}</h1>
      <span>UID {data.streamer.biliUid} · 房间 {data.streamer.roomId}</span>
    </div>
    <div class="header-actions"><form method="POST" action="?/refresh"><button class="button" type="submit"><RefreshCw size={15} /> 刷新半年动态</button></form><a class="button" href={`https://live.bilibili.com/${data.streamer.roomId}`} target="_blank" rel="noreferrer">直播间 <ExternalLink size={15} /></a></div>
  </div>

  <div class="status-band">
    <div class="status-primary">
      <span class={`badge ${data.streamer.liveStatus}`}>{data.streamer.liveStatus === 'live' ? '正在直播' : data.streamer.liveStatus === 'rotating' ? '轮播中' : '未开播'}</span>
      <strong>{data.streamer.liveTitle || '直播间当前没有标题'}</strong>
    </div>
    <div class="forecast-block">
      <span>预计下次开播</span>
      {#if data.streamer.liveStatus === 'live'}
        <strong class="live-text"><Radio size={21} /> 已开播</strong>
      {:else if data.streamer.predictedStartAt}
        <strong><Clock3 size={20} /> {formatDateTime(data.streamer.predictedStartAt)}</strong>
        <small><span class={`badge ${confidenceClass(data.streamer.confidence)}`}>{data.streamer.confidence}%</span> {sourceLabel(data.streamer.forecastSource)}</small>
      {:else}<strong class="muted">分析中</strong>{/if}
    </div>
    <div class="reason"><span>判断依据</span><p>{data.streamer.forecastReason || '等待 Pi 完成首次分析。'}</p></div>
  </div>

  <div class="detail-grid">
    <section class="content-column">
      <div class="section-heading"><div><h2>历史动态</h2><p>保存原图、正文和完整评论区</p></div><History size={19} /></div>
      {#if data.dynamics.length === 0}
        <div class="panel empty">尚未抓取到动态</div>
      {:else}
        <div class="dynamic-list">
          {#each data.dynamics as dynamic}
            <article class="dynamic panel">
              <div class="dynamic-meta">
                <time>{formatDateTime(dynamic.publishedAt)}</time>
                {#if dynamic.state !== 'visible'}<span class="badge low">源内容{dynamic.state === 'deleted' ? '已删除' : '不可见'}</span>{/if}
                <span>{relativeTime(dynamic.updatedAt)}同步</span>
              </div>
              {#if dynamic.text}<p class="rich-text">{@html richTextHtml(dynamic.text, dynamic.emojiMap)}</p>{:else}<p>此动态没有文字正文。</p>{/if}
              {#if dynamic.media.length > 0}
                <div class="media-strip">
                  {#each dynamic.media.slice(0, 4) as media}
                    {#if media.localUrl}<img src={media.localUrl} alt="动态图片" loading="lazy" />
                    {:else}<span class="media-missing"><ImageIcon size={18} /> {media.state === 'failed' ? '图片下载失败' : media.state === 'quota_exceeded' ? '媒体配额已满' : '图片待下载'}</span>{/if}
                  {/each}
                </div>
              {/if}
              <footer>
                <span><MessageSquare size={15} /> {dynamic.commentCount} 条评论</span>
                <a href={`/dynamics/${dynamic.id}`}>查看动态与评论 <ExternalLink size={14} /></a>
              </footer>
            </article>
          {/each}
        </div>
      {/if}
    </section>

    <aside>
      <section class="side-section">
        <div class="section-heading"><div><h2>固定周表</h2><p>人工设置与 Pi 图片识别</p></div><CalendarDays size={18} /></div>
        <div class="panel schedule-list">
          {#if data.scheduleRules.length === 0}<div class="empty small">暂无固定周表</div>{/if}
          {#each data.scheduleRules as rule}
            <div class="schedule-row"><strong>{weekdays[Number(rule.weekday)]}</strong><time>{rule.local_time}</time><span>{rule.title || '直播'}</span></div>
          {/each}
        </div>
      </section>
      <section class="side-section">
        <div class="section-heading"><div><h2>近期直播</h2><p>以 30 秒轮询观测</p></div><Radio size={18} /></div>
        <div class="panel sessions">
          {#if data.liveSessions.length === 0}<div class="empty small">暂无直播记录</div>{/if}
          {#each data.liveSessions as session}
            <div><strong>{formatDateTime(String(session.observed_start_at))}</strong><span>{session.observed_end_at ? `结束于 ${formatDateTime(String(session.observed_end_at))}` : '仍在直播'}</span></div>
          {/each}
        </div>
      </section>
    </aside>
  </div>
</section>

<style>
  .back { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 18px; color: var(--muted); font-size: 13px; }
  .streamer-header { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 14px; margin-bottom: 20px; }
  .streamer-header img { width: 58px; height: 58px; border-radius: 50%; object-fit: cover; }
  .streamer-title h1 { margin: 0 0 5px; font-size: 25px; }
  .streamer-title span { color: var(--muted); font-size: 13px; }
  .header-actions { display: flex; align-items: center; gap: 8px; }
  .status-band { display: grid; grid-template-columns: 1fr 1fr 1.5fr; min-height: 116px; margin-bottom: 30px; color: white; background: #181b1e; border: 1px solid #292e32; border-radius: 7px; }
  .status-band > div { min-width: 0; display: grid; align-content: center; gap: 8px; padding: 18px 22px; border-right: 1px solid #303438; }
  .status-band > div:last-child { border-right: 0; }
  .status-band span, .status-band small { color: #aeb5b8; font-size: 12px; }
  .status-band strong { display: flex; align-items: center; gap: 7px; font-size: 19px; overflow-wrap: anywhere; }
  .status-primary strong { font-size: 14px; color: #d9dcde; }
  .live-text { color: #ff7373; }
  .reason p { margin: 0; color: #d6d9db; font-size: 13px; line-height: 1.65; }
  .detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 28px; align-items: start; }
  .section-heading { display: flex; align-items: center; justify-content: space-between; margin: 0 0 11px; }
  .section-heading h2 { margin: 0; font-size: 17px; }
  .section-heading p { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
  .dynamic-list { display: grid; gap: 12px; }
  .dynamic { padding: 17px; }
  .dynamic-meta { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; }
  .dynamic p { margin: 14px 0; line-height: 1.72; white-space: pre-wrap; overflow-wrap: anywhere; }
  .rich-text :global(.inline-emoji) { width: 1.6em; height: 1.6em; vertical-align: -0.35em; object-fit: contain; }
  .media-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 12px 0; }
  .media-strip img, .media-missing { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 4px; background: #edf0f1; }
  .media-missing { display: grid; place-items: center; color: var(--muted); font-size: 11px; }
  .dynamic footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid var(--line); padding-top: 12px; color: var(--muted); font-size: 12px; }
  .dynamic footer span, .dynamic footer a { display: inline-flex; align-items: center; gap: 5px; }
  .dynamic footer a { color: var(--blue); }
  aside { display: grid; gap: 26px; }
  .schedule-list, .sessions { overflow: hidden; }
  .schedule-row { display: grid; grid-template-columns: 48px 54px 1fr; gap: 8px; padding: 11px 13px; border-bottom: 1px solid var(--line); font-size: 13px; }
  .schedule-row:last-child { border-bottom: 0; }
  .schedule-row time { font-weight: 700; font-variant-numeric: tabular-nums; }
  .schedule-row span { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sessions > div:not(.empty) { display: grid; gap: 4px; padding: 11px 13px; border-bottom: 1px solid var(--line); }
  .sessions > div:last-child { border-bottom: 0; }
  .sessions strong { font-size: 13px; }
  .sessions span { color: var(--muted); font-size: 12px; }
  .empty.small { padding: 24px 12px; }
  @media (max-width: 850px) { .detail-grid { grid-template-columns: 1fr; } .status-band { grid-template-columns: 1fr; } .status-band > div { border-right: 0; border-bottom: 1px solid #303438; } }
  @media (max-width: 520px) { .streamer-header { grid-template-columns: auto 1fr; } .streamer-header .button { grid-column: 1 / -1; } .media-strip { grid-template-columns: repeat(2, 1fr); } }
</style>
