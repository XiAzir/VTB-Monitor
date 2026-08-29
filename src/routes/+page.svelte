<script lang="ts">
  import { Radio, RefreshCw, Clock3, ExternalLink, CircleDot } from '@lucide/svelte';
  import { confidenceClass, formatDateTime, relativeTime, sourceLabel } from '$lib/format';
  import { proxyBilibiliImage } from '$lib/image';
  let { data } = $props();

  function statusLabel(status: string) {
    return status === 'live' ? '正在直播' : status === 'rotating' ? '轮播中' : status === 'offline' ? '未开播' : '状态未知';
  }
</script>

<svelte:head><title>监控台 · 监控室老大爷</title></svelte:head>

<section class="page">
  <div class="page-heading">
    <div>
      <h1>主播监控台</h1>
      <p>直播状态按后台间隔刷新，动态与开播预测持续更新。</p>
    </div>
    <span class="updated"><RefreshCw size={14} /> 数据生成于 {relativeTime(data.generatedAt)}</span>
  </div>

  {#if data.streamers.length === 0}
    <div class="panel empty">
      <Radio size={32} />
      <p>尚未配置监控主播</p>
      <a class="button" href="/admin">进入后台配置</a>
    </div>
  {:else}
    <div class="monitor-grid">
      {#each data.streamers as streamer}
        <article class:live-card={streamer.liveStatus === 'live'} class="monitor-row panel">
          <a class="identity" href={`/streamers/${streamer.slug}`}>
            {#if streamer.avatarUrl}
              <img src={proxyBilibiliImage(streamer.avatarUrl)} alt="" loading="lazy" />
            {:else}
              <span class="avatar-fallback">{streamer.name.slice(0, 1)}</span>
            {/if}
            <span class="identity-text"><strong>{streamer.name}</strong><small>UID {streamer.biliUid}</small></span>
          </a>

          <div class="current-status">
            <span class:live={streamer.liveStatus === 'live'} class:rotating={streamer.liveStatus === 'rotating'} class="status-dot"><CircleDot size={15} /></span>
            <div><span class={`badge ${streamer.liveStatus}`}>{statusLabel(streamer.liveStatus)}</span>
              <small>{streamer.liveTitle || `检查于 ${relativeTime(streamer.lastCheckedAt)}`}</small></div>
          </div>

          <div class="forecast">
            {#if streamer.forecastStatus === 'live'}
              <span class="live-now"><Radio size={17} /> LIVE</span>
              <small>已由直播间状态确认</small>
            {:else if streamer.forecastStatus === 'cancelled_today'}
              <strong class="cancelled"><Clock3 size={17} /> 今日取消</strong><small>来自已确认日程变更</small>
            {:else if streamer.forecastStatus === 'exact' && streamer.predictedStartAt}
              <strong><Clock3 size={17} /> {formatDateTime(streamer.predictedStartAt, { month: undefined, day: undefined })}</strong>
              <span><span class={`badge ${confidenceClass(streamer.confidence)}`}>{streamer.confidence}%</span> {sourceLabel(streamer.forecastSource)}</span>
            {:else if streamer.forecastStatus === 'range' && streamer.predictedStartAt}
              <strong><Clock3 size={17} /> {formatDateTime(streamer.predictedStartAt, { month: undefined, day: undefined })} ± {streamer.uncertaintyMinutes ?? 30} 分</strong>
              <span><span class={`badge ${confidenceClass(streamer.confidence)}`}>{streamer.confidence}%</span> 时间范围</span>
            {:else if streamer.forecastStatus === 'stale'}
              <strong class="muted"><Clock3 size={17} /> 预测待更新</strong><small>旧预测已过期</small>
            {:else}
              <strong class="muted"><Clock3 size={17} /> 信息不足</strong><small>暂无可靠开播依据</small>
            {/if}
          </div>

          <a class="icon-button details" href={`/streamers/${streamer.slug}`} title="查看详情" aria-label={`查看 ${streamer.name} 详情`}><ExternalLink size={17} /></a>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .updated { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
  .monitor-grid { display: grid; gap: 9px; }
  .monitor-row { min-height: 88px; display: grid; grid-template-columns: minmax(210px, 1.25fr) minmax(230px, 1fr) minmax(190px, .8fr) 42px; align-items: center; gap: 18px; padding: 13px 14px; border-left: 3px solid transparent; }
  .monitor-row.live-card { border-left-color: var(--red); }
  .identity { min-width: 0; display: flex; align-items: center; gap: 12px; }
  .identity img, .avatar-fallback { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; }
  .avatar-fallback { display: grid; place-items: center; background: #e4e7e9; color: #566067; font-weight: 700; }
  .identity-text { min-width: 0; display: grid; gap: 3px; }
  .identity-text strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; }
  .identity-text small, .current-status small, .forecast small { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .current-status { min-width: 0; display: flex; align-items: center; gap: 8px; }
  .current-status > div { min-width: 0; display: grid; gap: 6px; justify-items: start; }
  .status-dot { color: #90999e; }
  .status-dot.live { color: var(--red); }
  .status-dot.rotating { color: var(--amber); }
  .forecast { min-width: 0; display: grid; gap: 6px; justify-items: start; }
  .forecast strong { display: flex; align-items: center; gap: 7px; font-size: 19px; font-variant-numeric: tabular-nums; }
  .forecast > span { font-size: 12px; color: var(--muted); }
  .live-now { color: var(--red) !important; display: flex; align-items: center; gap: 7px; font-size: 19px !important; font-weight: 760; }
  .cancelled { color: var(--amber); }
  .details { justify-self: end; }
  @media (max-width: 780px) {
    .monitor-row { grid-template-columns: 1fr auto; gap: 13px; }
    .current-status, .forecast { grid-column: 1 / -1; border-top: 1px solid var(--line); padding-top: 11px; }
    .forecast { grid-column: 2; grid-row: 2; border-top: 0; padding-top: 0; justify-self: end; }
    .details { grid-column: 2; grid-row: 1; }
  }
  @media (max-width: 470px) {
    .monitor-row { min-height: 174px; }
    .forecast { grid-column: 1 / -1; grid-row: 3; justify-self: start; border-top: 1px solid var(--line); padding-top: 11px; width: 100%; }
  }
</style>
