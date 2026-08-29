<script lang="ts">
  import { ArrowLeft, ExternalLink, Heart, MessageSquare, Pin, RefreshCw, UserRoundCheck, Image as ImageIcon } from '@lucide/svelte';
  import { formatDateTime, richTextHtml } from '$lib/format';
  import { proxyBilibiliImage } from '$lib/image';
  let { data } = $props();
  const displayText = $derived(data.selectedRevision ? String(data.selectedRevision.snapshot.text ?? data.selectedRevision.text) : data.dynamic.text);
  const displayMedia = $derived(data.selectedRevision ? data.selectedRevision.media : data.dynamic.media);
  const displayEmojiMap = $derived(data.selectedRevision ? data.selectedRevision.emojiMap : data.dynamic.emojiMap);
</script>

<svelte:head><title>动态详情 · {String(data.streamer.name)}</title></svelte:head>

<section class="page narrow">
  <a class="back" href={`/streamers/${String(data.streamer.slug)}`}><ArrowLeft size={16} /> 返回 {String(data.streamer.name)}</a>
  <article class="dynamic-detail panel">
    <header>
      <div><strong>{String(data.streamer.name)}</strong><time>{formatDateTime(data.dynamic.publishedAt)}</time></div>
      <a class="icon-button" href={data.dynamic.sourceUrl} target="_blank" rel="noreferrer" title="打开源动态" aria-label="打开源动态"><ExternalLink size={17} /></a>
    </header>
    {#if data.dynamic.state === 'deleted'}<div class="source-warning">最新版已被删除，当前显示删除前最后一版内容。</div>{:else if data.dynamic.state !== 'visible'}<div class="source-warning">源动态不可见，本页展示的是本地归档。</div>{/if}
    {#if data.selectedRevision}<div class="revision-note">正在查看历史版本 · {formatDateTime(data.selectedRevision.createdAt)} <a href={`/dynamics/${data.dynamic.id}`}>查看当前版</a></div>{/if}
    {#if displayText}<p class="rich-text">{@html richTextHtml(displayText, displayEmojiMap)}</p>{:else}<p>此动态没有文字正文。</p>{/if}
    {#if displayMedia.length > 0}
      <div class="media-grid">
        {#each displayMedia as media}
          {#if media.localUrl}<a href={media.localUrl} target="_blank"><img src={media.localUrl} alt="动态原图" loading="lazy" /></a>
          {:else}<div class="media-missing"><ImageIcon size={24} /><span>{media.state === 'failed' ? '原图下载失败' : media.state === 'quota_exceeded' ? '媒体配额已满' : '原图待下载'}</span></div>{/if}
        {/each}
      </div>
    {/if}
    <footer><span><Heart size={15} /> {data.dynamic.likeCount}</span><span><MessageSquare size={15} /> {data.dynamic.commentCount}</span></footer>
  </article>
  <div class="dynamic-actions">{#if data.canRefresh}<form method="POST" action="?/refresh"><button class="button" type="submit"><RefreshCw size={15} /> 刷新此动态</button></form>{:else}<a class="button" href="/admin"><RefreshCw size={15} /> 登录后刷新</a>{/if}</div>
  {#if data.revisions.length > 0}<section class="revisions panel"><strong>历史版本</strong>{#each data.revisions as revision}<a href={`/dynamics/${data.dynamic.id}?revision=${revision.id}`}>{formatDateTime(revision.createdAt)} · {revision.text || '无文字正文'}</a>{/each}</section>{/if}

  <div class="comments-heading"><h2>评论</h2><span>显示 {data.comments.length} / {data.totalRootComments} 条主评论</span></div>
  <div class="comments">
    {#if data.comments.length === 0}<div class="panel empty">评论仍在后台同步，或该动态暂无评论。</div>{/if}
    {#each data.comments as comment}
      <article class="comment panel">
        <div class="comment-author">
          {#if comment.avatarUrl}<img src={proxyBilibiliImage(comment.avatarUrl)} alt="" loading="lazy" />{:else}<span></span>{/if}
          <div><strong>{comment.authorName}</strong><small>{formatDateTime(comment.publishedAt)}</small></div>
          {#if comment.isStreamer}<span class="signal" title="主播本人"><UserRoundCheck size={16} /></span>{/if}
          {#if comment.isPinned}<span class="signal" title="置顶评论"><Pin size={15} /></span>{/if}
        </div>
        {#if comment.state !== 'visible'}<small class="deleted">源评论已删除</small>{/if}
        <p>{comment.message}</p>
        {#if comment.media.length > 0}<div class="comment-media">{#each comment.media as media}{#if media.localUrl}<img src={media.localUrl} alt="评论图片" loading="lazy" />{/if}{/each}</div>{/if}
        <div class="comment-stats"><Heart size={13} /> {comment.likeCount}</div>
        {#if comment.replies.length > 0}
          <div class="replies">
            {#each comment.replies as reply}
              <div class="reply"><strong>{reply.authorName}</strong>{#if reply.isStreamer}<UserRoundCheck size={14} />{/if}<span>{reply.message}</span><small>{formatDateTime(reply.publishedAt)}</small></div>
            {/each}
          </div>
        {/if}
      </article>
    {/each}
  </div>
  {#if data.page > 1 || data.nextBefore}<nav class="comment-pages" aria-label="评论分页">{#if data.page > 1}<a class="button" href={`/dynamics/${data.dynamic.id}`}>返回最新评论</a>{/if}{#if data.nextBefore}<a class="button" href={`/dynamics/${data.dynamic.id}?page=${data.page + 1}&before=${encodeURIComponent(data.nextBefore)}`}>更早评论</a>{/if}</nav>{/if}
</section>

<style>
  .narrow { width: min(820px, calc(100% - 36px)); }
  .back { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 17px; color: var(--muted); font-size: 13px; }
  .dynamic-detail { padding: 20px; }
  .dynamic-detail header { display: flex; align-items: center; justify-content: space-between; }
  .dynamic-detail header > div { display: grid; gap: 4px; }
  .dynamic-detail time { color: var(--muted); font-size: 12px; }
  .dynamic-detail > p { margin: 22px 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.75; }
  .dynamic-detail > .rich-text :global(.inline-emoji) { width: 1.6em; height: 1.6em; vertical-align: -0.35em; object-fit: contain; }
  .source-warning { margin-top: 15px; padding: 9px 11px; border-left: 3px solid var(--amber); background: #fff4dc; color: #6d4c15; font-size: 12px; }
  .revision-note { margin-top: 14px; color: var(--muted); font-size: 12px; }
  .revision-note a, .revisions a { color: var(--blue); }
  .dynamic-actions { margin: 10px 0; display: flex; justify-content: flex-end; }
  .revisions { display: grid; gap: 8px; padding: 14px 17px; margin-bottom: 18px; font-size: 12px; }
  .media-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
  .media-grid img, .media-missing { width: 100%; min-height: 160px; max-height: 520px; object-fit: contain; background: #f0f2f3; border-radius: 4px; }
  .media-missing { display: grid; place-items: center; align-content: center; gap: 7px; color: var(--muted); font-size: 12px; }
  .dynamic-detail footer { display: flex; gap: 20px; margin-top: 18px; padding-top: 13px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
  .dynamic-detail footer span, .comment-stats { display: inline-flex; align-items: center; gap: 5px; }
  .comments-heading { display: flex; align-items: baseline; justify-content: space-between; margin: 28px 0 12px; }
  .comments-heading h2 { margin: 0; font-size: 18px; }
  .comments-heading span { color: var(--muted); font-size: 12px; }
  .comments { display: grid; gap: 9px; }
  .comment-pages { display: flex; justify-content: space-between; gap: 10px; margin-top: 14px; }
  .comment { padding: 15px 17px; }
  .comment-author { display: flex; align-items: center; gap: 9px; }
  .comment-author img, .comment-author > span:first-child { width: 34px; height: 34px; border-radius: 50%; background: #e7eaec; }
  .comment-author > div { display: grid; gap: 2px; margin-right: auto; }
  .comment-author strong { font-size: 13px; }
  .comment-author small, .reply small { color: var(--muted); font-size: 11px; }
  .signal { color: var(--blue); }
  .comment > p { margin: 12px 0; line-height: 1.68; white-space: pre-wrap; overflow-wrap: anywhere; }
  .deleted { color: var(--red); }
  .comment-media { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }
  .comment-media img { width: 112px; height: 112px; object-fit: cover; border-radius: 4px; }
  .comment-stats { color: var(--muted); font-size: 11px; }
  .replies { display: grid; gap: 8px; margin-top: 12px; padding: 11px; background: #f3f5f6; border-radius: 4px; }
  .reply { display: grid; grid-template-columns: auto auto 1fr auto; align-items: baseline; gap: 6px; font-size: 12px; }
  .reply span { overflow-wrap: anywhere; }
  @media (max-width: 560px) { .media-grid { grid-template-columns: 1fr; } .reply { grid-template-columns: auto auto 1fr; } .reply small { grid-column: 3; } }
</style>
