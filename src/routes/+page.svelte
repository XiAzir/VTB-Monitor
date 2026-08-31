<script lang="ts">
  import { Bell, ChevronRight, Clock3, Radio, RefreshCw, Users } from '@lucide/svelte';
  import { confidenceClass, formatDateTime, relativeTime, sourceLabel } from '$lib/format';
  import { proxyBilibiliImage } from '$lib/image';
  let { data } = $props();

  const statusLabel = (status: string) =>
    status === 'live' ? '直播中' : status === 'rotating' ? '轮播中' : status === 'offline' ? '未开播' : '状态未知';

  const liveCount = $derived(data.streamers.filter((item) => item.liveStatus === 'live').length);
  const todayCount = $derived(
    data.streamers.filter((item) => {
      if (!item.predictedStartAt) return false;
      if (item.forecastStatus !== 'exact' && item.forecastStatus !== 'range') return false;
      const at = new Date(item.predictedStartAt);
      const now = new Date();
      return at.toDateString() === now.toDateString();
    }).length
  );
  const cancelledCount = $derived(data.streamers.filter((item) => item.forecastStatus === 'cancelled_today').length);
  const greeting = () => {
    const hour = new Date().getHours();
    return hour < 6 ? '凌晨好' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  };
</script>

<svelte:head><title>监控台 · 监控室老大爷</title></svelte:head>

<section class="page">
  <div class="page-heading">
    <div>
      <h1>{greeting()}，今天有 {liveCount} 位主播在播</h1>
      <p>直播状态按后台间隔轮询，动态归档与开播预测持续更新。</p>
    </div>
    <span class="stamp"><span class="pulse"></span> 数据生成于 {relativeTime(data.generatedAt)}</span>
  </div>

  {#if data.streamers.length === 0}
    <div class="panel empty">
      <Radio size={32} />
      <p>尚未配置监控主播</p>
      <a class="button primary" href="/admin">进入后台配置</a>
    </div>
  {:else}
    <div class="kpi-row">
      <div class="panel kpi">
        <div class="kpi-top"><span class="kpi-chip blue"><Users size={15} /></span> 监控主播</div>
        <div class="kpi-val">{data.streamers.length}<small>位</small></div>
        <div class="kpi-note">全部启用中</div>
      </div>
      <div class="panel kpi">
        <div class="kpi-top"><span class="kpi-chip pink"><Radio size={15} /></span> 正在直播</div>
        <div class="kpi-val">{liveCount}<small>位</small></div>
        <div class="kpi-note">由直播间状态确认</div>
      </div>
      <div class="panel kpi">
        <div class="kpi-top"><span class="kpi-chip green"><Clock3 size={15} /></span> 今日预计开播</div>
        <div class="kpi-val">{todayCount}<small>场</small></div>
        <div class="kpi-note">来自预测与周表</div>
      </div>
      <div class="panel kpi">
        <div class="kpi-top"><span class="kpi-chip amber"><Bell size={15} /></span> 今日取消</div>
        <div class="kpi-val">{cancelledCount}<small>场</small></div>
        <div class="kpi-note">已确认日程变更</div>
      </div>
    </div>

    <div class="section-head">
      <div>
        <h2>主播监控</h2>
        <p class="sub">按直播状态排序，正在直播的排在最前面</p>
      </div>
    </div>

    <div class="streamer-grid">
      {#each data.streamers as streamer, index}
        <article class="panel sc">
          <div class={`sc-cover c${(index % 5) + 1}`}>
            {#if streamer.liveStatus === 'live'}
              <span class="sc-flag"><span class="badge live"><span class="dot live"></span> 直播中</span></span>
            {:else if streamer.liveStatus === 'rotating'}
              <span class="sc-flag"><span class="badge rotating">轮播中</span></span>
            {/if}
          </div>

          <a class="sc-id" href={`/streamers/${streamer.slug}`}>
            {#if streamer.avatarUrl}
              <img class:ring={streamer.liveStatus === 'live'} class="av" src={proxyBilibiliImage(streamer.avatarUrl)} alt="" loading="lazy" />
            {:else}
              <span class:ring={streamer.liveStatus === 'live'} class="av av-fallback">{streamer.name.slice(0, 1)}</span>
            {/if}
            <span class="sc-name">
              <strong>{streamer.name}</strong>
              <span>UID {streamer.biliUid} · 房间 {streamer.roomId}</span>
            </span>
          </a>

          <div class="sc-status">
            <span class={`badge ${streamer.liveStatus}`}>
              <span class:live={streamer.liveStatus === 'live'} class="dot"></span> {statusLabel(streamer.liveStatus)}
            </span>
            <p>{streamer.liveTitle || `${relativeTime(streamer.lastCheckedAt)}检查`}</p>
          </div>

          <div class="sc-forecast">
            {#if streamer.forecastStatus === 'live'}
              <div class="fc-label"><span>当前场次</span><span>由直播间状态确认</span></div>
              <div class="fc-time is-live"><b>LIVE</b><em>{streamer.liveTitle ? '正在直播中' : '直播间已开启'}</em></div>
            {:else if streamer.forecastStatus === 'cancelled_today'}
              <div class="fc-label"><span>预计开播</span><span class="badge rotating">今日取消</span></div>
              <div class="fc-time is-off"><b>今天休息</b></div>
              <em class="fc-note">{streamer.forecastReason || '来自已确认的日程变更'}</em>
            {:else if (streamer.forecastStatus === 'exact' || streamer.forecastStatus === 'range') && streamer.predictedStartAt}
              <div class="fc-label">
                <span>预计开播</span>
                <span class={`badge ${confidenceClass(streamer.confidence)}`}>信心 {streamer.confidence}%</span>
              </div>
              <div class="fc-time">
                <b>{formatDateTime(streamer.predictedStartAt, { month: undefined, day: undefined })}</b>
                <em>{streamer.forecastStatus === 'range' ? `± ${streamer.uncertaintyMinutes ?? 30} 分钟` : sourceLabel(streamer.forecastSource)}</em>
              </div>
              <div class="meter"><i style={`width:${Math.max(4, Math.min(100, streamer.confidence ?? 0))}%`}></i></div>
            {:else if streamer.forecastStatus === 'stale'}
              <div class="fc-label"><span>预计开播</span><span class="badge">待更新</span></div>
              <div class="fc-time is-off"><b>预测已过期</b></div>
              <em class="fc-note">上次预测时间已过，等待下一轮分析</em>
            {:else}
              <div class="fc-label"><span>预计开播</span><span class="badge">信息不足</span></div>
              <div class="fc-time is-off"><b>暂无可靠依据</b></div>
              <em class="fc-note">{streamer.forecastReason || '样本不足以形成预测'}</em>
            {/if}
          </div>

          <div class="sc-foot">
            <span>{relativeTime(streamer.lastCheckedAt)}同步</span>
            <a href={`/streamers/${streamer.slug}`}>查看详情 <ChevronRight size={13} /></a>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .stamp { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 15px; border-radius: 999px; background: #fff; border: 1px solid var(--line); box-shadow: var(--shadow); color: var(--muted); font-size: 13px; }
  .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--green-brand); box-shadow: 0 0 0 4px rgb(12 163 12 / 14%); }
  .empty .button { margin-top: 14px; }

  .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
  .kpi { padding: 18px; display: grid; gap: 11px; }
  .kpi-top { display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: 13px; }
  .kpi-chip { width: 30px; height: 30px; border-radius: var(--r-sm); display: grid; place-items: center; }
  .kpi-chip.pink { background: var(--pink-tint); color: var(--pink-ink); }
  .kpi-chip.blue { background: var(--blue-tint); color: var(--blue); }
  .kpi-chip.amber { background: var(--amber-tint); color: var(--amber); }
  .kpi-chip.green { background: var(--green-tint); color: var(--green); }
  .kpi-val { font-size: 32px; font-weight: 700; line-height: 1; }
  .kpi-val small { margin-left: 3px; color: var(--muted); font-size: 14px; font-weight: 600; }
  .kpi-note { color: var(--muted-2); font-size: 12px; }

  .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin: 34px 0 14px; }
  .section-head h2 { margin: 0; font-size: 18px; }
  .section-head .sub { margin: 5px 0 0; color: var(--muted); font-size: 13px; }

  .streamer-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
  .sc { position: relative; overflow: hidden; display: grid; align-content: start; transition: transform .18s, box-shadow .18s; }
  .sc:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
  .sc-cover { height: 74px; position: relative; }
  .sc-cover.c1 { background: linear-gradient(120deg, #ffd9e5, #ffeef4 55%, #e4f5fd); }
  .sc-cover.c2 { background: linear-gradient(120deg, #d8eefc, #eaf7fd 55%, #fdeef5); }
  .sc-cover.c3 { background: linear-gradient(120deg, #ffe6cf, #fff6e6 55%, #e8f6ee); }
  .sc-cover.c4 { background: linear-gradient(120deg, #e2ecff, #f0f5ff 55%, #ffeef6); }
  .sc-cover.c5 { background: linear-gradient(120deg, #dcf3e8, #eefaf3 55%, #e7f2fd); }
  .sc-flag { position: absolute; top: 12px; right: 12px; }
  .sc-flag .badge { background: rgb(255 255 255 / 88%); backdrop-filter: blur(6px); box-shadow: 0 2px 6px rgb(24 25 28 / 8%); }

  .sc-id { padding: 0 18px; margin-top: -26px; display: flex; align-items: flex-start; gap: 12px; position: relative; z-index: 1; }
  .av { width: 56px; height: 56px; border-radius: 50%; flex: 0 0 auto; object-fit: cover; border: 3px solid #fff; background: #eef1f3; box-shadow: 0 3px 10px -3px rgb(24 25 28 / 22%); }
  .av-fallback { display: grid; place-items: center; color: #566067; font-size: 20px; font-weight: 700; }
  .av.ring { box-shadow: 0 0 0 2px var(--pink), 0 3px 10px -3px rgb(251 114 153 / 40%); }
  .sc-name { min-width: 0; margin-top: 30px; }
  .sc-name strong { display: block; font-size: 16.5px; font-weight: 680; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sc-name > span { display: block; margin-top: 3px; color: var(--muted-2); font-size: 12px; font-variant-numeric: tabular-nums; }

  .sc-status { padding: 14px 18px 0; display: flex; align-items: center; gap: 8px; min-width: 0; }
  .sc-status p { margin: 0; min-width: 0; color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .sc-forecast { margin: 14px 18px 0; padding: 13px 14px; border: 1px solid var(--line-soft); border-radius: var(--r); background: var(--surface-muted); display: grid; gap: 9px; }
  .fc-label { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 12px; }
  .fc-time { display: flex; align-items: baseline; gap: 8px; }
  .fc-time b { font-size: 25px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
  .fc-time em { font-style: normal; color: var(--muted); font-size: 12.5px; }
  .fc-time.is-live b { color: var(--pink-ink); }
  .fc-time.is-off b { font-size: 17px; font-weight: 620; color: var(--muted); }
  .fc-note { font-style: normal; color: var(--muted-2); font-size: 12px; line-height: 1.6; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }

  .sc-foot { margin-top: 14px; padding: 12px 18px; border-top: 1px solid var(--line-soft); display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--muted-2); font-size: 12px; }
  .sc-foot a { display: inline-flex; align-items: center; gap: 4px; color: var(--blue); font-weight: 600; }

  @media (max-width: 860px) { .kpi-row { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 640px) { .streamer-grid { grid-template-columns: 1fr; } }
</style>
