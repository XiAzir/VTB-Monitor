<script lang="ts">
  import { ArrowLeft, CalendarDays, Clock3, ExternalLink, MessageSquare, Radio, RefreshCw, History, Search } from '@lucide/svelte';
  import { confidenceClass, formatDateTime, relativeTime, sourceLabel } from '$lib/format';
  import { proxyBilibiliImage } from '$lib/image';
  import DynamicContent from '$lib/components/DynamicContent.svelte';
  let { data } = $props();
  const weekdays = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const liveStatusLabel = (status: string) => status === 'live' ? '正在直播' : status === 'rotating' ? '轮播中' : status === 'offline' ? '未开播' : '状态未知';
</script>

<svelte:head><title>{data.streamer.name} · VTB Monitor</title></svelte:head>

<section class="page">
  <a class="back" href="/"><ArrowLeft size={16} /> 返回监控台</a>
  <div class="panel streamer-header">
    {#if data.streamer.avatarUrl}<img class:ring={data.streamer.liveStatus === 'live'} src={proxyBilibiliImage(data.streamer.avatarUrl)} alt="" />{:else}<span class:ring={data.streamer.liveStatus === 'live'} class="avatar-fallback">{data.streamer.name.slice(0, 1)}</span>{/if}
    <div class="streamer-title">
      <h1>{data.streamer.name} <span class={`badge ${data.streamer.liveStatus}`}><span class:live={data.streamer.liveStatus === 'live'} class="dot"></span> {liveStatusLabel(data.streamer.liveStatus)}</span></h1>
      <span>UID {data.streamer.biliUid} · 房间 {data.streamer.roomId}</span>
    </div>
    <div class="header-actions">{#if data.canRefresh}<form method="POST" action="?/refresh"><button class="button" type="submit"><RefreshCw size={15} /> 刷新半年动态</button></form>{:else}<a class="button" href="/admin"><RefreshCw size={15} /> 登录后刷新</a>{/if}<a class="button primary" href={`https://live.bilibili.com/${data.streamer.roomId}`} target="_blank" rel="noreferrer">进直播间 <ExternalLink size={15} /></a></div>
  </div>

  <div class="panel status-band">
    <div class="status-primary">
      <span class={`badge ${data.streamer.liveStatus}`}>{liveStatusLabel(data.streamer.liveStatus)}</span>
      <strong>{data.streamer.liveTitle || '直播间当前没有标题'}</strong>
    </div>
    <div class="forecast-block">
      <span>预计下次开播</span>
      {#if data.streamer.forecastStatus === 'live'}
        <strong class="live-text"><Radio size={21} /> 已开播</strong>
      {:else if data.streamer.forecastStatus === 'cancelled_today'}
        <strong class="cancelled-text">今日取消</strong><small>来自已确认日程变更</small>
      {:else if data.streamer.forecastStatus === 'exact' && data.streamer.predictedStartAt}
        <strong><Clock3 size={20} /> {formatDateTime(data.streamer.predictedStartAt)}</strong>
        <small><span class={`badge ${confidenceClass(data.streamer.confidence)}`}>{data.streamer.confidence}%</span> {sourceLabel(data.streamer.forecastSource)}</small>
      {:else if data.streamer.forecastStatus === 'range' && data.streamer.predictedStartAt}
        <strong><Clock3 size={20} /> {formatDateTime(data.streamer.predictedStartAt)} ± {data.streamer.uncertaintyMinutes ?? 30} 分钟</strong>
        <small><span class={`badge ${confidenceClass(data.streamer.confidence)}`}>{data.streamer.confidence}%</span> 时间范围</small>
      {:else if data.streamer.forecastStatus === 'stale'}<strong class="muted">预测待更新</strong>
      {:else}<strong class="muted">信息不足</strong>{/if}
    </div>
    <div class="reason"><span>判断依据</span><p>{data.streamer.forecastReason || '暂无足以形成可靠预测的证据。'}</p></div>
  </div>

  <div class="detail-grid">
    <section class="content-column">
      <div class="section-heading"><div><h2>历史动态</h2><p>保存原图、正文和完整评论区</p></div><History size={19} /></div>
      <form class="archive-filters" method="GET">
        <div class="search-field"><Search size={15} /><input name="q" value={data.filters.q} placeholder="搜索正文" /></div>
        <input name="from" type="date" value={data.filters.from} aria-label="起始日期" />
        <input name="to" type="date" value={data.filters.to} aria-label="结束日期" />
        <select name="type" aria-label="动态类型"><option value="">全部类型</option>{#each data.dynamicTypes as type}<option value={type} selected={data.filters.type === type}>{type}</option>{/each}</select>
        <select name="state" aria-label="动态状态"><option value="">全部状态</option><option value="visible" selected={data.filters.state === 'visible'}>正常</option><option value="suspected_deleted" selected={data.filters.state === 'suspected_deleted'}>疑似删除</option><option value="deleted" selected={data.filters.state === 'deleted'}>已删除</option><option value="unavailable" selected={data.filters.state === 'unavailable'}>暂时不可见</option></select>
        <label><input type="checkbox" name="hasMedia" value="1" checked={data.filters.hasMedia} /> 含图片</label>
        <label><input type="checkbox" name="changedOnly" value="1" checked={data.filters.changedOnly} /> 有修订</label>
        <button class="button" type="submit">筛选</button><a class="button" href={`/streamers/${data.streamer.slug}`}>重置</a>
      </form>
      {#if data.dynamics.length === 0}
        <div class="panel empty">尚未抓取到动态</div>
      {:else}
        <div class="dynamic-list">
          {#each data.dynamics as dynamic}
            <article class="dynamic panel">
              <div class="dynamic-meta">
                <time>{formatDateTime(dynamic.publishedAt)}</time>
                {#if dynamic.isPinned}<span class="badge medium">置顶</span>{/if}
                {#if dynamic.state !== 'visible'}<span class="badge low">{dynamic.state === 'deleted' ? '源内容已删除' : dynamic.state === 'suspected_deleted' ? '疑似已删除' : '暂时不可见'}</span>{/if}
                <span>{relativeTime(dynamic.updatedAt)}同步</span>
              </div>
              <DynamicContent text={dynamic.text} emojiMap={dynamic.emojiMap} card={dynamic.card} media={dynamic.media} compact />
              <footer>
                <span><MessageSquare size={15} /> {dynamic.commentCount} 条评论</span>
                <a href={`/dynamics/${dynamic.id}`}>查看动态与评论 <ExternalLink size={14} /></a>
              </footer>
            </article>
          {/each}
        </div>
        {#if data.nextHref}<nav class="archive-pages"><a class="button" href={data.nextHref}>加载更早动态</a></nav>{/if}
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
      {#if data.evaluation.ready}<section class="side-section"><div class="section-heading"><div><h2>预测表现</h2><p>最近 {data.evaluation.count} 场</p></div><Clock3 size={18} /></div><div class="panel evaluation"><div><strong>{data.evaluation.mae} 分钟</strong><span>平均误差</span></div><div><strong>{data.evaluation.within30}%</strong><span>30 分钟命中</span></div><div><strong>{data.evaluation.within60}%</strong><span>60 分钟命中</span></div></div><div class="panel source-performance">{#each Object.entries(data.evaluation.bySource) as [source, metrics]}<div><strong>{sourceLabel(source)}</strong><span>{metrics.count} 场 · 平均误差 {metrics.mae} 分钟 · 30/60 分钟 {Math.round(metrics.within30 / metrics.count * 100)}%/{Math.round(metrics.within60 / metrics.count * 100)}%</span></div>{/each}</div></section>{/if}
      <section class="side-section">
        <div class="section-heading"><div><h2>近期直播</h2><p>按后台间隔轮询观测</p></div><Radio size={18} /></div>
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
  .back { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 16px; color: var(--muted); font-size: 13.5px; }
  .back:hover { color: var(--pink-ink); }
  .streamer-header { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 18px; padding: 22px 24px; margin-bottom: 16px; }
  .streamer-header img, .avatar-fallback { width: 72px; height: 72px; border-radius: 50%; object-fit: cover; border: 3px solid #fff; background: #eef1f3; box-shadow: 0 3px 10px -3px rgb(24 25 28 / 22%); }
  .avatar-fallback { display: grid; place-items: center; color: #566067; font-size: 26px; font-weight: 700; }
  .streamer-header img.ring, .avatar-fallback.ring { box-shadow: 0 0 0 2px var(--pink), 0 3px 10px -3px rgb(251 114 153 / 40%); }
  .streamer-title h1 { margin: 0 0 8px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 24px; }
  .streamer-title span { color: var(--muted-2); font-size: 12.5px; }
  .header-actions { display: flex; align-items: center; gap: 9px; }
  .status-band { display: grid; grid-template-columns: 1.1fr 1fr 1.4fr; gap: 1px; overflow: hidden; margin-bottom: 30px; background: linear-gradient(120deg, #fff2f6, #fdfbfc 45%, #eef8fd); }
  .status-band > div { min-width: 0; display: grid; align-content: center; gap: 9px; padding: 20px 22px; background: rgb(255 255 255 / 55%); }
  .status-band > div > span:first-child, .status-band small { color: var(--muted); font-size: 12px; }
  .status-band strong { display: flex; align-items: center; gap: 7px; font-size: 20px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .status-primary strong { font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--text); }
  .live-text { color: var(--pink-ink); }
  .cancelled-text { color: var(--amber); }
  .reason p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.7; }
  .detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) 336px; gap: 24px; align-items: start; }
  .section-heading { display: flex; align-items: center; justify-content: space-between; margin: 0 0 12px; }
  .section-heading h2 { margin: 0; font-size: 18px; }
  .section-heading p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
  .dynamic-list { display: grid; gap: 14px; }
  .archive-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 14px; }
  .archive-filters input, .archive-filters select { min-height: 36px; border: 1px solid var(--line); border-radius: 999px; padding: 0 13px; background: #fff; color: inherit; font-size: 13.5px; }
  .archive-filters label { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 13px; border: 1px solid var(--line); border-radius: 999px; background: #fff; color: var(--muted); font-size: 13px; }
  .archive-filters label input { min-height: auto; accent-color: var(--pink); }
  .search-field { display: flex; align-items: center; gap: 7px; height: 36px; padding: 0 13px; border: 1px solid var(--line); border-radius: 999px; background: #fff; color: var(--muted-2); }
  .search-field input { border: 0; padding: 0; min-height: auto; width: 150px; }
  .archive-pages { display: flex; justify-content: center; margin-top: 18px; }
  .evaluation { display: grid; grid-template-columns: repeat(3,1fr); overflow: hidden; text-align: center; }
  .evaluation div { display: grid; gap: 4px; padding: 14px 12px; border-right: 1px solid var(--line-soft); }
  .evaluation div:last-child { border-right: 0; }
  .evaluation strong { font-size: 17px; }
  .evaluation span { color: var(--muted-2); font-size: 11.5px; }
  .source-performance { margin-top: 8px; overflow: hidden; }
  .source-performance div { display: grid; gap: 3px; padding: 12px 16px; border-bottom: 1px solid var(--line-soft); }
  .source-performance div:last-child { border-bottom: 0; }
  .source-performance strong { font-size: 12.5px; }
  .source-performance span { color: var(--muted-2); font-size: 11.5px; line-height: 1.55; }
  .dynamic { padding: 18px 20px; }
  .dynamic-meta { display: flex; align-items: center; gap: 10px; color: var(--muted-2); font-size: 12px; }
  .dynamic footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 15px; padding-top: 13px; border-top: 1px solid var(--line-soft); color: var(--muted-2); font-size: 12.5px; }
  .dynamic footer span, .dynamic footer a { display: inline-flex; align-items: center; gap: 5px; }
  .dynamic footer a { color: var(--blue); font-weight: 600; }
  aside { display: grid; gap: 18px; position: sticky; top: 84px; }
  .schedule-list, .sessions { overflow: hidden; }
  .schedule-row { display: grid; grid-template-columns: 46px 58px 1fr; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--line-soft); font-size: 13px; }
  .schedule-row:last-child { border-bottom: 0; }
  .schedule-row strong { color: var(--muted); font-weight: 600; }
  .schedule-row time { font-weight: 700; font-variant-numeric: tabular-nums; }
  .schedule-row span { color: var(--muted-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sessions > div:not(.empty) { display: grid; gap: 4px; padding: 12px 18px; border-bottom: 1px solid var(--line-soft); }
  .sessions > div:last-child { border-bottom: 0; }
  .sessions strong { font-size: 13px; font-variant-numeric: tabular-nums; }
  .sessions span { color: var(--muted-2); font-size: 12px; }
  @media (max-width: 1020px) { .detail-grid { grid-template-columns: 1fr; } aside { position: static; } .status-band { grid-template-columns: 1fr; } }
  @media (max-width: 520px) { .streamer-header { grid-template-columns: auto 1fr; } .header-actions { grid-column: 1 / -1; } }
</style>
