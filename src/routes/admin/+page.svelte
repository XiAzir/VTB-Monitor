<script lang="ts">
  import { Activity, AlertTriangle, Bot, CalendarDays, Database, History, KeyRound, LogOut, Mail, Plus, Radio, RefreshCw, ServerCog, Settings2, Users } from '@lucide/svelte';
  import PiChat from '$lib/components/PiChat.svelte';
  import { formatDateTime, relativeTime } from '$lib/format';
  let { data, form } = $props();
</script>

<svelte:head><title>后台管理 · 监控室老大爷</title></svelte:head>

{#if !data.authenticated}
  <section class="login-page">
    <form class="login panel" method="POST" action="?/login">
      <div class="login-icon"><KeyRound size={23} /></div><h1>后台登录</h1><p>仅限站点管理员</p>
      {#if form?.loginError}<div class="notice error">{form.loginError}</div>{/if}
      <div class="field"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" value="admin" required /></div>
      <div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required /></div>
      <button class="button primary" type="submit">登录</button>
    </form>
  </section>
{:else}
  <section class="page admin-page">
    <div class="page-heading">
      <div><h1>后台管理</h1><p>抓取、预测、凭据与本机 agent 接口</p></div>
      <form method="POST" action="?/logout"><button class="button" type="submit"><LogOut size={15} /> 退出</button></form>
    </div>
    {#if form?.formError}<div class="notice error top-notice">{form.formError}</div>{/if}
    {#if form?.saved}<div class="notice top-notice">{form.saved}</div>{/if}
    {#if form?.apiToken}<div class="token-reveal"><strong>令牌仅显示一次</strong><code>{form.apiToken}</code></div>{/if}

    <div class="admin-shortcuts"><a class="button" href="/admin/schedules"><CalendarDays size={15} /> 审核周表识别</a></div>
    <div class="stats-grid">
      <div class="stat panel"><Users size={18} /><strong>{data.stats.streamers}</strong><span>监控主播</span></div>
      <div class="stat panel"><Activity size={18} /><strong>{data.stats.dynamics}</strong><span>历史动态</span></div>
      <div class="stat panel"><Database size={18} /><strong>{data.stats.comments}</strong><span>已存评论</span></div>
      <div class="stat panel"><ServerCog size={18} /><strong>{data.stats.pendingJobs}</strong><span>队列任务</span></div>
      <div class="stat panel"><AlertTriangle size={18} /><strong>{data.stats.openAlerts}</strong><span>待处理告警</span></div>
    </div>

    {#if data.admin.forcePasswordChange}<div class="notice error top-notice">当前仍在使用初始化密码，请立即修改。</div>{/if}
    <div class="admin-grid">
      <div class="admin-main">
        <section id="streamers">
          <div class="section-title"><div><Users size={18} /><h2>监控主播</h2></div></div>
          <div class="panel table-wrap">
            <table><thead><tr><th>主播</th><th>状态</th><th>预测</th><th>最近检查</th><th>操作</th></tr></thead>
              <tbody>{#each data.streamers as streamer}<tr><td><strong>{streamer.name}</strong><small>UID {streamer.biliUid} · {streamer.roomId}</small></td>
                <td><span class={`badge ${streamer.liveStatus}`}>{streamer.liveStatus}</span></td><td>{streamer.predictedStartAt ? formatDateTime(streamer.predictedStartAt) : '分析中'}</td>
                <td>{relativeTime(streamer.lastCheckedAt)}</td><td><form class="row-actions" method="POST" action="?/runOperation"><input type="hidden" name="streamerId" value={streamer.id} />
                  <button class="icon-button" name="operation" value="sync" title="立即同步" aria-label="立即同步"><RefreshCw size={15} /></button>
                  <button class="icon-button" name="operation" value="refresh" title="重新导入半年动态" aria-label="重新导入半年动态"><History size={15} /></button>
                  <button class="icon-button" name="operation" value="reanalyze" title="重新分析" aria-label="重新分析"><Bot size={15} /></button></form></td></tr>{/each}</tbody>
            </table>
            {#if data.streamers.length === 0}<div class="empty small">尚未添加主播</div>{/if}
          </div>
          {#each data.streamers as streamer}
            <details class="panel streamer-editor"><summary>编辑 {streamer.name} 的抓取配置</summary>
              <form class="form-panel four-cols" method="POST" action="?/updateStreamer">
                <input type="hidden" name="id" value={streamer.id} /><input type="hidden" name="version" value={streamer.version} />
                <div class="field"><label for={`edit-name-${streamer.id}`}>显示名称</label><input id={`edit-name-${streamer.id}`} name="name" value={streamer.name} required /></div>
                <div class="field"><label for={`edit-slug-${streamer.id}`}>页面 slug</label><input id={`edit-slug-${streamer.id}`} name="slug" value={streamer.slug} required /></div>
                <div class="field"><label for={`edit-uid-${streamer.id}`}>B站 UID</label><input id={`edit-uid-${streamer.id}`} name="biliUid" value={streamer.biliUid} required /></div>
                <div class="field"><label for={`edit-room-${streamer.id}`}>直播间号</label><input id={`edit-room-${streamer.id}`} name="roomId" value={streamer.roomId} required /></div>
                <div class="field wide"><label for={`edit-dynamic-${streamer.id}`}>动态主页</label><input id={`edit-dynamic-${streamer.id}`} name="dynamicUrl" value={streamer.dynamicUrl} required /></div>
                <div class="field wide"><label for={`edit-live-${streamer.id}`}>直播间主页</label><input id={`edit-live-${streamer.id}`} name="liveUrl" value={streamer.liveUrl} required /></div>
                <div class="field"><label for={`edit-live-poll-${streamer.id}`}>直播轮询（秒）</label><input id={`edit-live-poll-${streamer.id}`} name="livePollSeconds" type="number" min="15" max="600" value={streamer.livePollSeconds} /></div>
                <div class="field"><label for={`edit-dynamic-poll-${streamer.id}`}>动态轮询（秒）</label><input id={`edit-dynamic-poll-${streamer.id}`} name="dynamicPollSeconds" type="number" min="180" max="3600" value={streamer.dynamicPollSeconds} /></div>
                <label class="checkbox"><input name="enabled" type="checkbox" checked={streamer.enabled} /> 启用监控</label><button class="button" type="submit">保存配置</button>
              </form>
            </details>
          {/each}
          <form class="panel form-panel four-cols" method="POST" action="?/createStreamer">
            <div class="form-title"><Plus size={17} /><strong>添加主播</strong></div>
            <div class="field"><label for="name">显示名称</label><input id="name" name="name" required /></div>
            <div class="field"><label for="slug">页面 slug</label><input id="slug" name="slug" pattern="[a-zA-Z0-9_-]+" required /></div>
            <div class="field"><label for="biliUid">B站 UID</label><input id="biliUid" name="biliUid" inputmode="numeric" required /></div>
            <div class="field"><label for="roomId">直播间号</label><input id="roomId" name="roomId" inputmode="numeric" required /></div>
            <div class="field wide"><label for="dynamicUrl">动态主页（可留空）</label><input id="dynamicUrl" name="dynamicUrl" /></div>
            <div class="field wide"><label for="liveUrl">直播间主页（可留空）</label><input id="liveUrl" name="liveUrl" /></div>
            <button class="button primary" type="submit"><Plus size={15} /> 添加并同步</button>
          </form>
        </section>

        <section id="manual-schedule">
          <div class="section-title"><div><Settings2 size={18} /><h2>人工预测与固定周表</h2></div></div>
          <div class="settings-grid">
            <form class="panel form-panel" method="POST" action="?/setManualForecast">
              <div class="form-title"><Radio size={17} /><strong>锁定下一次开播</strong></div>
              <div class="field"><label for="forecast-streamer">主播</label><select id="forecast-streamer" name="streamerId" required>{#each data.streamers as streamer}<option value={streamer.id}>{streamer.name}</option>{/each}</select></div>
              <div class="field"><label for="predictedStartAt">预计时间</label><input id="predictedStartAt" name="predictedStartAt" type="datetime-local" required /></div>
              <div class="field"><label for="forecast-confidence">置信度</label><input id="forecast-confidence" name="confidence" type="number" min="0" max="100" value="100" required /></div>
              <div class="field"><label for="forecast-reason">公开说明</label><input id="forecast-reason" name="reason" value="管理员人工设置" required /></div>
              <button class="button" type="submit">保存并锁定</button>
            </form>
            <form class="panel form-panel" method="POST" action="?/saveManualSchedule">
              <div class="form-title"><Activity size={17} /><strong>替换人工周表</strong></div>
              <div class="field"><label for="schedule-streamer">主播</label><select id="schedule-streamer" name="streamerId" required>{#each data.streamers as streamer}<option value={streamer.id}>{streamer.name}</option>{/each}</select></div>
              <div class="field"><label for="schedule-rules">周表（星期 时间 标题）</label><textarea id="schedule-rules" name="rules" rows="6" placeholder={'1 20:00 杂谈\n3 19:30 游戏\n7 20:00 周末直播'}></textarea></div>
              <p class="form-help">星期使用 1 至 7 表示周一至周日；留空保存可清除人工周表。</p>
              <button class="button" type="submit">保存并锁定</button>
            </form>
          </div>
        </section>

        <section id="credentials">
          <div class="section-title"><div><Settings2 size={18} /><h2>数据源与 AI</h2></div></div>
          <div class="settings-grid">
            <form class="panel form-panel" method="POST" action="?/changePassword"><div class="form-title"><KeyRound size={17} /><strong>修改管理员密码</strong></div>
              <div class="field"><label for="new-password">新密码</label><input id="new-password" name="password" type="password" minlength="10" autocomplete="new-password" required /></div>
              <div class="field"><label for="confirm-password">再次输入</label><input id="confirm-password" name="confirm" type="password" minlength="10" autocomplete="new-password" required /></div>
              <button class="button" type="submit">更新密码</button></form>
            <form class="panel form-panel" method="POST" action="?/saveCookie"><div class="form-title"><Radio size={17} /><strong>B站 Cookie</strong></div>
              <p class="form-help">失效时自动回退匿名抓取并发送告警。</p><div class="field"><label for="cookie">替换 Cookie</label><textarea id="cookie" name="cookie" autocomplete="off" required></textarea></div>
              <button class="button" type="submit">加密保存并验证</button></form>
            <form class="panel form-panel" method="POST" action="?/savePi"><div class="form-title"><Bot size={17} /><strong>Pi Provider</strong><span class={`badge ${data.pi.configured ? 'high' : 'low'}`}>{data.pi.configured ? '已配置' : '未配置'}</span></div>
              <div class="field"><label for="provider">Provider</label><select id="provider" name="provider" value={data.pi.profile.provider}><option value="openai">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option><option value="google">Google Generative AI</option><option value="openrouter">OpenAI Chat / OpenRouter</option></select></div>
              <div class="field"><label for="modelId">模型 ID</label><input id="modelId" name="modelId" value={data.pi.profile.modelId} required /></div>
              <div class="field"><label for="baseUrl">自定义 Base URL</label><input id="baseUrl" name="baseUrl" value={data.pi.profile.baseUrl || ''} placeholder="可留空" /></div>
              <div class="field"><label for="apiKey">替换 API Key</label><input id="apiKey" name="apiKey" type="password" autocomplete="new-password" placeholder="不修改可留空" /></div>
              <div class="field"><label for="thinkingLevel">思考强度</label><select id="thinkingLevel" name="thinkingLevel" value={data.pi.profile.thinkingLevel}><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></div>
              <button class="button" type="submit">保存 Pi 配置</button></form>
          </div>
        </section>

        <section id="alerts">
          <div class="section-title"><div><AlertTriangle size={18} /><h2>告警与任务</h2></div></div>
          <div class="split-list">
            <div class="panel list-panel"><h3>待处理告警</h3>{#if data.alerts.length === 0}<div class="empty small">当前没有告警</div>{/if}
              {#each data.alerts as alert}<div class="list-row"><div><strong>{String(alert.title)}</strong><small>{String(alert.message)} · {relativeTime(String(alert.last_seen_at))}</small></div>
                <form method="POST" action="?/acknowledge"><input type="hidden" name="alertId" value={String(alert.id)} /><button class="button" type="submit">确认</button></form></div>{/each}</div>
            <div class="panel list-panel"><h3>最近任务</h3>{#each data.jobs.slice(0, 12) as job}<div class="list-row"><div><strong>{String(job.type)}</strong><small>{String(job.status)} · 尝试 {Number(job.attempts)} 次</small></div><time>{relativeTime(String(job.updated_at))}</time></div>{/each}</div>
          </div>
        </section>

        <section id="integration">
          <div class="section-title"><div><ServerCog size={18} /><h2>邮件与本机 Agent API</h2></div></div>
          <div class="settings-grid">
            <form class="panel form-panel" method="POST" action="?/saveSmtp"><div class="form-title"><Mail size={17} /><strong>SMTP 告警邮件</strong></div>
              <div class="field"><label for="smtp-host">服务器</label><input id="smtp-host" name="host" value={data.smtp?.host || ''} /></div><div class="field"><label for="smtp-port">端口</label><input id="smtp-port" name="port" type="number" value={data.smtp?.port || 587} /></div>
              <div class="field"><label for="smtp-username">用户名</label><input id="smtp-username" name="username" value={data.smtp?.username || ''} /></div><div class="field"><label for="smtp-password">替换密码</label><input id="smtp-password" name="password" type="password" /></div>
              <div class="field"><label for="smtp-from">发件人</label><input id="smtp-from" name="from" value={data.smtp?.from || ''} /></div><div class="field"><label for="smtp-to">收件人</label><input id="smtp-to" name="to" value={data.smtp?.to || ''} /></div>
              <label class="checkbox"><input name="secure" type="checkbox" checked={data.smtp?.secure || false} /> 使用隐式 TLS</label><button class="button" type="submit">保存 SMTP</button></form>
            <form class="panel form-panel" method="POST" action="?/createToken"><div class="form-title"><KeyRound size={17} /><strong>创建管理 API 令牌</strong></div>
              <div class="field"><label for="token-name">令牌名称</label><input id="token-name" name="name" value="server-agent" required /></div>
              {#each ['status:read','config:read','config:write','ops:run','audit:read','secrets:read','secrets:write'] as scope}<label class="checkbox"><input type="checkbox" name="scope" value={scope} /> {scope}</label>{/each}
              <button class="button" type="submit">创建一次性令牌</button>
              {#if data.tokens.length > 0}<div class="token-list">{#each data.tokens as token}<div><span><strong>{String(token.name)}</strong><small>{String(token.token_prefix)}… · {token.revoked_at ? '已撤销' : '有效'}</small></span>{#if !token.revoked_at}<button class="button danger" type="submit" formaction="?/revokeToken" name="tokenId" value={String(token.id)}>撤销</button>{/if}</div>{/each}</div>{/if}
            </form>
          </div>
        </section>
      </div>

      <aside><PiChat /><div class="panel audit"><h3>最近审计</h3>{#each data.audit.slice(0, 12) as entry}<div><strong>{String(entry.action)}</strong><small>{String(entry.actor_type)} · {relativeTime(String(entry.created_at))}</small></div>{/each}</div></aside>
    </div>
  </section>
{/if}

<style>
  .login-page { min-height: calc(100vh - 58px); display: grid; place-items: center; padding: 24px; }
  .login { width: min(380px, 100%); display: grid; gap: 16px; padding: 26px; }
  .login-icon { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 6px; background: #202427; color: white; }
  .login h1 { margin: 0; font-size: 21px; }.login p { margin: -10px 0 0; color: var(--muted); font-size: 13px; }
  .top-notice, .token-reveal { margin-bottom: 14px; }.token-reveal { display: grid; gap: 7px; padding: 12px; border: 1px solid #deb969; background: #fff5dc; }.token-reveal code { overflow-wrap: anywhere; }
  .token-list { display: grid; border-top: 1px solid var(--line); }.token-list > div { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 9px; }.token-list span { min-width: 0; }.token-list strong, .token-list small { display: block; overflow: hidden; text-overflow: ellipsis; }.token-list small { margin-top: 2px; color: var(--muted); font-size: 10px; }.token-list .button { min-height: 30px; padding: 0 9px; font-size: 11px; }
  .stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 28px; }
  .stat { min-height: 92px; display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 3px 9px; padding: 14px; }.stat :global(svg) { grid-row: 1 / 3; color: var(--muted); }.stat strong { font-size: 22px; }.stat span { color: var(--muted); font-size: 11px; }
  .admin-grid { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 24px; align-items: start; }.admin-main { display: grid; gap: 32px; }.admin-grid aside { display: grid; gap: 16px; position: sticky; top: 78px; }
  .section-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }.section-title > div, .form-title { display: flex; align-items: center; gap: 8px; }.section-title h2 { margin: 0; font-size: 17px; }
  .table-wrap { overflow: auto; }table { width: 100%; border-collapse: collapse; font-size: 12px; }th,td { padding: 11px 12px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }th { color: var(--muted); background: #f5f6f7; font-weight: 650; }td strong,td small { display: block; }td small { margin-top: 3px; color: var(--muted); }.row-actions { display: flex; gap: 5px; }.row-actions .icon-button { width: 31px; height: 31px; }
  .form-panel { display: grid; gap: 12px; padding: 15px; }.four-cols { grid-template-columns: repeat(4, 1fr) auto; align-items: end; margin-top: 10px; }.four-cols .form-title { grid-column: 1 / -1; }.four-cols .button { margin-bottom: 1px; }
  .streamer-editor { margin-top: 8px; }.streamer-editor summary { cursor: pointer; padding: 11px 13px; font-size: 12px; font-weight: 650; }.streamer-editor .form-panel { border-top: 1px solid var(--line); }.four-cols .wide { grid-column: span 2; }
  .settings-grid, .split-list { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start; }.form-help { margin: -5px 0 0; color: var(--muted); font-size: 11px; }.checkbox { display: flex; align-items: center; gap: 7px; font-size: 12px; }
  .list-panel h3, .audit h3 { margin: 0; padding: 12px; border-bottom: 1px solid var(--line); font-size: 13px; }.list-row, .audit > div { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--line); }.list-row:last-child, .audit > div:last-child { border-bottom: 0; }.list-row > div, .audit > div { min-width: 0; }.list-row strong, .list-row small, .audit strong, .audit small { display: block; }.list-row small, .audit small, .list-row time { margin-top: 3px; color: var(--muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; }.list-row .button { min-height: 30px; padding: 0 9px; font-size: 11px; }
  .empty.small { padding: 25px 12px; }.audit { overflow: hidden; }.audit > div { display: grid; justify-content: stretch; }
  @media (max-width: 1050px) { .admin-grid { grid-template-columns: 1fr; }.admin-grid aside { position: static; }.stats-grid { grid-template-columns: repeat(3, 1fr); } }
  @media (max-width: 760px) { .four-cols, .settings-grid, .split-list { grid-template-columns: 1fr; }.four-cols .form-title, .four-cols .wide { grid-column: 1; }.stats-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
