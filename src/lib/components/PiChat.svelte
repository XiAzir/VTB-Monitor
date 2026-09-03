<script lang="ts">
  import { Bot, History, Plus, Send, Square } from '@lucide/svelte';
  import { relativeTime } from '$lib/format';

  type ChatMessage = { role: 'user' | 'assistant' | 'error'; text: string };
  type Conversation = { id: string; title: string; updatedAt: string };

  let messages = $state<ChatMessage[]>([]);
  let conversations = $state<Conversation[]>([]);
  let prompt = $state('');
  let running = $state(false);
  let historyOpen = $state(false);
  let historyLoading = $state(false);
  let controller: AbortController | null = null;
  let conversationId = $state<string>(crypto.randomUUID());

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
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: value, conversationId }), signal: controller.signal
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
      await loadConversations();
    } catch (error) {
      messages[target] = { role: 'error', text: error instanceof Error ? error.message : String(error) };
    } finally {
      running = false;
      controller = null;
    }
  }

  async function loadConversations() {
    historyLoading = true;
    try {
      const response = await fetch('/admin/pi/history');
      if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
      const data = await response.json() as { conversations: Conversation[] };
      conversations = data.conversations;
    } finally {
      historyLoading = false;
    }
  }

  async function toggleHistory() {
    historyOpen = !historyOpen;
    if (historyOpen) await loadConversations();
  }

  async function selectConversation(id: string) {
    if (running || id === conversationId) {
      historyOpen = false;
      return;
    }
    historyLoading = true;
    try {
      const response = await fetch(`/admin/pi/history?id=${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
      const data = await response.json() as { messages: ChatMessage[] };
      conversationId = id;
      messages = data.messages;
      historyOpen = false;
    } finally {
      historyLoading = false;
    }
  }

  function stop() { controller?.abort(); }

  function newConversation() {
    controller?.abort();
    messages = [];
    conversationId = crypto.randomUUID();
    historyOpen = false;
  }
</script>

<div class="pi-chat panel">
  <div class="chat-head">
    <div><Bot size={18} /><strong>Pi 管理助手</strong></div>
    <div class="head-actions">
      <button class:active={historyOpen} class="icon-button" onclick={() => void toggleHistory()} title="对话历史" aria-label="对话历史"><History size={16} /></button>
      <button class="icon-button" onclick={newConversation} title="新建对话" aria-label="新建对话"><Plus size={17} /></button>
    </div>
  </div>
  <div class="chat-body">
    {#if historyOpen}
      <div class="history-panel">
        <div class="history-title"><strong>对话历史</strong><button class="button" onclick={newConversation}><Plus size={14} /> 新对话</button></div>
        <div class="history-list">
          {#if historyLoading && conversations.length === 0}<div class="history-empty">正在载入…</div>
          {:else if conversations.length === 0}<div class="history-empty">还没有历史对话</div>
          {:else}{#each conversations as conversation}
            <button class:active={conversation.id === conversationId} class="history-item" onclick={() => void selectConversation(conversation.id)}>
              <strong>{conversation.title || '新对话'}</strong><small>{relativeTime(conversation.updatedAt)}</small>
            </button>
          {/each}{/if}
        </div>
      </div>
    {/if}
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
  .head-actions { display: flex; gap: 5px; }
  .chat-head .icon-button { width: 32px; height: 32px; }
  .chat-head .icon-button.active { border-color: var(--pink-soft); background: var(--pink-tint); }
  .chat-body { position: relative; min-height: 0; overflow: hidden; }
  .chat-log { height: 100%; overflow: auto; padding: 16px; background: var(--surface-muted); }
  .history-panel { position: absolute; z-index: 3; inset: 0; display: grid; grid-template-rows: auto 1fr; background: rgb(255 255 255 / 97%); backdrop-filter: blur(8px); }
  .history-title { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--line-soft); font-size: 13px; }
  .history-title .button { min-height: 30px; display: inline-flex; align-items: center; gap: 5px; padding: 0 10px; font-size: 12px; }
  .history-list { overflow: auto; padding: 8px; }
  .history-item { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 11px 12px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text); text-align: left; cursor: pointer; }
  .history-item:hover { background: var(--surface-muted); }
  .history-item.active { background: var(--pink-tint); color: var(--pink-ink); }
  .history-item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
  .history-item small { color: var(--muted-2); font-size: 10.5px; white-space: nowrap; }
  .history-empty { padding: 28px 12px; color: var(--muted-2); font-size: 12px; text-align: center; }
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
