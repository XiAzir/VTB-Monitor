<script lang="ts">
  import { Bot, Send, Square, Trash2 } from '@lucide/svelte';
  type ChatMessage = { role: 'user' | 'assistant' | 'error'; text: string };
  let messages = $state<ChatMessage[]>([]);
  let prompt = $state('');
  let running = $state(false);
  let controller: AbortController | null = null;

  async function submit() {
    const value = prompt.trim();
    if (!value || running) return;
    prompt = '';
    messages.push({ role: 'user', text: value }, { role: 'assistant', text: '' });
    const target = messages.length - 1;
    running = true;
    controller = new AbortController();
    try {
      const response = await fetch('/admin/pi', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: value }), signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error(await response.text() || `HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        messages[target].text += decoder.decode(chunk, { stream: true });
      }
      if (!messages[target].text) messages[target].text = '操作已完成。';
    } catch (error) {
      messages[target] = { role: 'error', text: error instanceof Error ? error.message : String(error) };
    } finally {
      running = false;
      controller = null;
    }
  }

  function stop() { controller?.abort(); }
</script>

<div class="pi-chat panel">
  <div class="chat-head"><div><Bot size={18} /><strong>Pi 管理助手</strong></div><button class="icon-button" onclick={() => messages = []} title="清空当前显示" aria-label="清空当前显示"><Trash2 size={16} /></button></div>
  <div class="chat-log" aria-live="polite">
    {#if messages.length === 0}
      <div class="chat-empty"><Bot size={28} /><span>可修改主播业务配置，或触发同步、重分析与重算。</span></div>
    {/if}
    {#each messages as message}
      <div class:assistant={message.role === 'assistant'} class:error-message={message.role === 'error'} class="message">
        <small>{message.role === 'user' ? 'ADMIN' : message.role === 'assistant' ? 'PI' : 'ERROR'}</small>
        <p>{message.text || (running ? '正在处理…' : '')}</p>
      </div>
    {/each}
  </div>
  <form class="chat-input" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
    <textarea bind:value={prompt} placeholder="例如：同步所有主播，并重新分析状态异常的主播" disabled={running}></textarea>
    {#if running}<button type="button" class="icon-button" onclick={stop} title="停止" aria-label="停止"><Square size={16} /></button>
    {:else}<button type="submit" class="icon-button primary" title="发送" aria-label="发送"><Send size={17} /></button>{/if}
  </form>
</div>

<style>
  .pi-chat { display: grid; grid-template-rows: auto minmax(260px, 430px) auto; overflow: hidden; }
  .chat-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--line-soft); }
  .chat-head > div { display: flex; align-items: center; gap: 9px; font-size: 14.5px; }
  .chat-head :global(svg) { color: var(--pink-ink); }
  .chat-head .icon-button { width: 32px; height: 32px; }
  .chat-log { overflow: auto; padding: 16px; background: var(--surface-muted); }
  .chat-empty { height: 100%; display: grid; place-items: center; align-content: center; gap: 10px; color: var(--muted-2); font-size: 12.5px; text-align: center; }
  .message { max-width: 85%; margin: 0 0 12px auto; padding: 11px 13px; border-radius: var(--r); border: 1px solid transparent; background: var(--pink-tint); color: var(--text); }
  .message.assistant, .message.error-message { margin-left: 0; margin-right: auto; background: #fff; border-color: var(--line); }
  .message.error-message { border-color: rgb(251 114 153 / 40%); color: var(--pink-ink); }
  .message small { display: block; margin-bottom: 4px; color: var(--pink-ink); font-size: 10px; font-weight: 750; letter-spacing: .04em; }
  .message.assistant small { color: var(--blue); }
  .message p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; font-size: 13px; }
  .chat-input { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 12px; border-top: 1px solid var(--line-soft); }
  .chat-input textarea { min-height: 58px; max-height: 130px; resize: vertical; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 9px 12px; font-size: 13px; outline: none; }
  .chat-input textarea:focus { border-color: var(--pink); box-shadow: 0 0 0 3px rgb(251 114 153 / 16%); }
  .chat-input .icon-button { align-self: end; }
  .icon-button.primary { color: #fff; border-color: transparent; background: linear-gradient(140deg, var(--pink-soft), var(--pink)); box-shadow: 0 5px 14px -5px rgb(251 114 153 / 65%); }
  .icon-button.primary:hover { color: #fff; filter: brightness(1.03); }
</style>

