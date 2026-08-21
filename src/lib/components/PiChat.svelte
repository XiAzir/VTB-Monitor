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
  .chat-head { display: flex; align-items: center; justify-content: space-between; padding: 11px 13px; border-bottom: 1px solid var(--line); }
  .chat-head > div { display: flex; align-items: center; gap: 8px; }
  .chat-head .icon-button { width: 32px; height: 32px; }
  .chat-log { overflow: auto; padding: 14px; background: #f7f8f8; }
  .chat-empty { height: 100%; display: grid; place-items: center; align-content: center; gap: 9px; color: var(--muted); font-size: 12px; text-align: center; }
  .message { max-width: 85%; margin: 0 0 12px auto; padding: 9px 11px; border-radius: 6px; background: #202427; color: white; }
  .message.assistant, .message.error-message { margin-left: 0; margin-right: auto; background: white; color: var(--text); border: 1px solid var(--line); }
  .message.error-message { border-color: #e1a9a9; color: #8c2525; }
  .message small { display: block; margin-bottom: 4px; color: #aeb6ba; font-size: 9px; font-weight: 750; }
  .message.assistant small { color: var(--blue); }
  .message p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; font-size: 13px; }
  .chat-input { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 10px; border-top: 1px solid var(--line); }
  .chat-input textarea { min-height: 58px; max-height: 130px; resize: vertical; border: 1px solid #ccd2d5; border-radius: 5px; padding: 9px; }
  .chat-input .icon-button { align-self: end; }
  .icon-button.primary { color: white; background: #202427; border-color: #202427; }
</style>

