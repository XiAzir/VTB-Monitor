<script lang="ts">
  import { CirclePlay, Image as ImageIcon, MessageSquareText, Play } from '@lucide/svelte';
  import type { DynamicCard, MediaAsset } from '$lib/types';
  import { richTextHtml } from '$lib/format';
  import { proxyBilibiliImage } from '$lib/image';

  let { text, emojiMap = {}, card = null, media = [], compact = false }: {
    text: string;
    emojiMap?: Record<string, string>;
    card?: DynamicCard | null;
    media?: MediaAsset[];
    compact?: boolean;
  } = $props();

  const cardUrls = $derived.by(() => {
    const urls = new Set<string>();
    if (card?.kind === 'video' && card.coverUrl) urls.add(card.coverUrl);
    if (card?.kind === 'forward') {
      for (const url of card.mediaUrls) urls.add(url);
      if (card.video?.coverUrl) urls.add(card.video.coverUrl);
    }
    return urls;
  });
  const regularMedia = $derived(media.filter((item) => !cardUrls.has(item.sourceUrl)));

  function mediaFor(url: string | null): MediaAsset | null {
    if (!url) return null;
    return media.find((item) => item.sourceUrl === url) ?? null;
  }

  function imageUrl(url: string | null): string | null {
    if (!url) return null;
    const asset = mediaFor(url);
    return asset?.localUrl ?? (asset ? null : proxyBilibiliImage(url));
  }
</script>

<div class:compact class="dynamic-content">
  {#if card?.kind === 'forward'}<div class="type-label">转发动态</div>{/if}
  {#if text}<p class="rich-text">{@html richTextHtml(text, emojiMap)}</p>{:else if card?.kind !== 'video'}<p class="empty-text">此动态没有文字正文。</p>{/if}

  {#if card?.kind === 'video'}
    <a class="video-card" href={card.url || '#'} target={card.url ? '_blank' : undefined} rel="noreferrer">
      <div class="video-cover">
        {#if imageUrl(card.coverUrl)}<img src={imageUrl(card.coverUrl)} alt="视频封面" loading="lazy" />{:else}<span><ImageIcon size={22} /> 封面待下载</span>{/if}
        <i><Play size={15} fill="currentColor" /></i>
        {#if card.durationText}<small>{card.durationText}</small>{/if}
      </div>
      <div class="video-copy">
        {#if card.badge}<span class="card-badge">{card.badge}</span>{/if}
        <strong>{card.title}</strong>
        {#if card.description}<p>{card.description}</p>{/if}
        <span class="video-stats"><CirclePlay size={14} /> {card.viewCount || '播放视频'} {#if card.danmakuCount}<MessageSquareText size={14} /> {card.danmakuCount}{/if}</span>
      </div>
    </a>
  {:else if card?.kind === 'forward'}
    <section class="forward-card">
      <header>
        {#if card.authorAvatarUrl}<img src={proxyBilibiliImage(card.authorAvatarUrl)} alt="" loading="lazy" />{/if}
        <strong>{card.authorName}</strong>
        {#if card.sourceUrl}<a href={card.sourceUrl} target="_blank" rel="noreferrer">查看原动态</a>{/if}
      </header>
      {#if card.unavailable}<p class="forward-unavailable">原动态已删除或不可见。</p>
      {:else}
        {#if card.text}<p class="rich-text original-text">{@html richTextHtml(card.text, card.emojiMap)}</p>{/if}
        {#if card.video}
          <a class="video-card nested" href={card.video.url || card.sourceUrl || '#'} target="_blank" rel="noreferrer">
            <div class="video-cover">
              {#if imageUrl(card.video.coverUrl)}<img src={imageUrl(card.video.coverUrl)} alt="原动态视频封面" loading="lazy" />{:else}<span><ImageIcon size={22} /> 封面待下载</span>{/if}
              <i><Play size={15} fill="currentColor" /></i>
              {#if card.video.durationText}<small>{card.video.durationText}</small>{/if}
            </div>
            <div class="video-copy"><strong>{card.video.title}</strong>{#if card.video.description}<p>{card.video.description}</p>{/if}</div>
          </a>
        {/if}
        {#if card.mediaUrls.length > 0}
          <div class="media-grid card-media">
            {#each card.mediaUrls as url}
              {#if imageUrl(url)}<a href={imageUrl(url) ?? url} target="_blank"><img src={imageUrl(url)} alt="原动态图片" loading="lazy" /></a>
              {:else}<span class="media-missing"><ImageIcon size={18} /> 图片待下载</span>{/if}
            {/each}
          </div>
        {/if}
      {/if}
    </section>
  {/if}

  {#if regularMedia.length > 0}
    <div class="media-grid">
      {#each (compact ? regularMedia.slice(0, 4) : regularMedia) as item}
        {#if item.localUrl}<a href={item.localUrl} target="_blank"><img src={item.localUrl} alt="动态图片" loading="lazy" /></a>
        {:else}<span class="media-missing"><ImageIcon size={18} /> {item.state === 'failed' ? '图片下载失败' : item.state === 'quota_exceeded' ? '媒体配额已满' : '图片待下载'}</span>{/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .dynamic-content { display: grid; gap: 12px; margin: 14px 0; }
  .dynamic-content > p { margin: 0; line-height: 1.72; white-space: pre-wrap; overflow-wrap: anywhere; }
  .rich-text :global(.inline-emoji) { width: 1.6em; height: 1.6em; vertical-align: -0.35em; object-fit: contain; }
  .empty-text { color: var(--muted); }
  .type-label { width: fit-content; padding: 3px 7px; border: 1px solid #d9a8b7; border-radius: 4px; color: #8c3451; background: #fff4f7; font-size: 11px; font-weight: 700; }
  .video-card { min-width: 0; display: grid; grid-template-columns: minmax(180px, 42%) 1fr; overflow: hidden; color: inherit; border: 1px solid var(--line); border-radius: 5px; background: #fafbfb; }
  .video-cover { position: relative; min-height: 128px; background: #e9edef; }
  .video-cover img { width: 100%; height: 100%; position: absolute; inset: 0; object-fit: cover; }
  .video-cover > span { height: 100%; display: grid; place-items: center; align-content: center; gap: 5px; color: var(--muted); font-size: 11px; }
  .video-cover i { position: absolute; left: 10px; bottom: 9px; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; color: white; background: rgba(0,0,0,.68); }
  .video-cover small { position: absolute; right: 8px; bottom: 7px; padding: 2px 5px; border-radius: 3px; color: white; background: rgba(0,0,0,.72); font-size: 10px; }
  .video-copy { min-width: 0; display: grid; align-content: center; gap: 7px; padding: 14px 16px; }
  .video-copy strong { overflow-wrap: anywhere; line-height: 1.45; }
  .video-copy p { display: -webkit-box; overflow: hidden; margin: 0; color: var(--muted); font-size: 12px; line-height: 1.55; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
  .card-badge { width: fit-content; padding: 2px 5px; border-radius: 3px; color: #a22e55; background: #ffe5ed; font-size: 10px; }
  .video-stats { display: flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11px; }
  .forward-card { display: grid; gap: 12px; padding: 14px; border-left: 3px solid #b8c0c4; background: #f4f6f7; }
  .forward-card > header { display: flex; align-items: center; gap: 8px; }
  .forward-card > header img { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; }
  .forward-card > header strong { min-width: 0; overflow-wrap: anywhere; font-size: 13px; }
  .forward-card > header a { margin-left: auto; color: var(--blue); font-size: 11px; }
  .forward-card > p { margin: 0; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
  .forward-unavailable { color: var(--muted); }
  .media-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
  .compact .media-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .media-grid a { min-width: 0; }
  .media-grid img, .media-missing { width: 100%; min-height: 150px; max-height: 520px; object-fit: contain; border-radius: 4px; background: #edf0f1; }
  .compact .media-grid img, .compact .media-missing { min-height: 0; aspect-ratio: 1; object-fit: cover; }
  .card-media img, .card-media .media-missing { min-height: 110px; max-height: 360px; }
  .media-missing { display: grid; place-items: center; align-content: center; gap: 5px; color: var(--muted); font-size: 11px; }
  .nested { grid-template-columns: minmax(150px, 34%) 1fr; background: white; }
  @media (max-width: 560px) {
    .video-card, .nested { grid-template-columns: 1fr; }
    .video-cover { min-height: 170px; }
    .compact .media-grid, .media-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
</style>
