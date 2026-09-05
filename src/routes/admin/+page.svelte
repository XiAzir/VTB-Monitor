<script lang="ts">
  import { Activity, AlertTriangle, Bot, CalendarDays, Database, History, KeyRound, LogOut, Mail, Plus, Radio, RefreshCw, ServerCog, Settings2, Users } from '@lucide/svelte';
  import PiChat from '$lib/components/PiChat.svelte';
  import { formatDateTime, relativeTime } from '$lib/format';
  let { data, form } = $props();
  const jobLabels: Record<string, string> = {
    sync_streamer: '同步主播动态', refresh_dynamic: '刷新动态', sync_comments: '同步评论', sync_sub_replies: '同步楼中楼',
    download_media: '下载媒体', pi_analyze: 'Pi 预测分析', pi_revision: 'Pi 编辑分析', recognize_schedule: '识别周表',
    repair_dynamic_archives: '修复动态归档', cleanup_storage: '清理存储', validate_cookie: '验证 Cookie', send_alert_email: '发送告警邮件'
  };
  const statusLabels: Record<string, string> = { pending: '等待中', retry: '待重试', running: '执行中', done: '已完成', failed: '失败' };
  const auditLabels: Record<string, string> = {
    'alert.acknowledge': '确认告警', 'alert.acknowledge_all': '批量确认告警', 'alert.resolve': '解决告警',
    'forecast.set': '设置预测', 'schedule.replace': '替换周表', 'schedule.manual.replace': '替换人工周表',
    'schedule.exception.upsert': '更新周表安排', 'streamer.create': '添加主播', 'streamer.update': '更新主播配置',
    'secret.put': '更新密钥', 'setting.update': '更新设置'
  };
  const actorLabels: Record<string, string> = { admin: '管理员', 'admin-ui': '后台', pi: 'Pi', system: '系统', scheduler: '调度器' };
  function jobLabel(type: unknown): string { return jobLabels[String(type)] ?? `任务：${String(type)}`; }
  function statusLabel(status: unknown): string { return statusLabels[String(status)] ?? String(status); }
  function auditLabel(action: unknown): string { return auditLabels[String(action)] ?? String(action).replaceAll('.', ' · '); }
  function actorLabel(actor: unknown): string { return actorLabels[String(actor)] ?? String(actor); }
  const liveLabels: Record<string, string> = { live: '直播中', rotating: '轮播中', offline: '未开播', unknown: '状态未知' };
</script>

<svelte:head><title>后台管理 · VTB Monitor</title></svelte:head>

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
                <td><span class={`badge ${streamer.liveStatus}`}><span class:live={streamer.liveStatus === 'live'} class="dot"></span> {liveLabels[streamer.liveStatus] ?? streamer.liveStatus}</span></td><td>{streamer.predictedStartAt ? formatDateTime(streamer.predictedStartAt) : '分析中'}</td>
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
                <label class="checkbox"><input name="enabled" type="checkbox" checked={streamer.enabled} /> 启用监控</label><button class="button primary" type="submit">保存配置</button>
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
              <button class="button primary" type="submit">保存并锁定</button>
            </form>
            <form class="panel form-panel" method="POST" action="?/saveManualSchedule">
              <div class="form-title"><Activity size={17} /><strong>替换人工周表</strong></div>
              <div class="field"><label for="schedule-streamer">主播</label><select id="schedule-streamer" name="streamerId" required>{#each data.streamers as streamer}<option value={streamer.id}>{streamer.name}</option>{/each}</select></div>
              <div class="field"><label for="schedule-rules">周表（星期 时间 标题）</label><textarea id="schedule-rules" name="rules" rows="6" placeholder={'1 20:00 杂谈\n3 19:30 游戏\n7 20:00 周末直播'}></textarea></div>
              <p class="form-help">星期使用 1 至 7 表示周一至周日；留空保存可清除人工周表。</p>
              <button class="button primary" type="submit">保存并锁定</button>
            </form>
          </div>
        </section>

        <section id="credentials">
          <div class="section-title"><div><Settings2 size={18} /><h2>数据源与 AI</h2></div></div>
          <div class="settings-grid">
            <form class="panel form-panel" method="POST" action="?/changePassword"><div class="form-title"><KeyRound size={17} /><strong>修改管理员密码</strong></div>
              <div class="field"><label for="new-password">新密码</label><input id="new-password" name="password" type="password" minlength="10" autocomplete="new-password" required /></div>
              <div class="field"><label for="confirm-password">再次输入</label><input id="confirm-password" name="confirm" type="password" minlength="10" autocomplete="new-password" required /></div>
              <button class="button primary" type="submit">更新密码</button></form>
            <form class="panel form-panel" method="POST" action="?/saveCookie"><div class="form-title"><Radio size={17} /><strong>B站 Cookie</strong></div>
              <p class="form-help">单个 Cookie 直接填写；多个 Cookie 请用空行分隔，系统会轮询使用。失效时自动回退匿名抓取并发送告警。</p><div class="field"><label for="cookie">替换 Cookie</label><textarea id="cookie" name="cookie" autocomplete="off" required></textarea></div>
              <button class="button primary" type="submit">加密保存并验证</button></form>
            {#if data.secrets.some((secret) => String(secret.key).startsWith('bilibili_cookie_pool:'))}
              <div class="panel form-panel"><div class="form-title"><Radio size={17} /><strong>Cookie 池条目</strong></div>
                {#each data.secrets.filter((secret) => String(secret.key).startsWith('bilibili_cookie_pool:')) as secret}
                  <div class="list-row"><div><strong>{String(secret.key).replace('bilibili_cookie_pool:', '')}</strong><small>{statusLabel(secret.status)} · {relativeTime(String(secret.updated_at ?? ''))}</small></div>
                    <form method="POST" action="?/deleteCookie"><input type="hidden" name="key" value={String(secret.key)} /><button class="button danger small" type="submit">删除</button></form>
                  </div>
                {/each}
              </div>
            {/if}
            <form class="panel form-panel" method="POST" action="?/saveBilibiliProxy"><div class="form-title"><ServerCog size={17} /><strong>B站请求代理</strong></div>
              <p class="form-help">仅用于 B站 API、动态详情和直播状态请求；留空使用直连。</p>
              <div class="field"><label for="bilibili-proxy">HTTP(S) 代理 URL</label><input id="bilibili-proxy" name="proxyUrl" value={data.bilibiliProxyUrl || ''} placeholder="http://127.0.0.1:7890" /></div>
              <button class="button primary" type="submit">保存并验证</button></form>
            <form class="panel form-panel" method="POST" action="?/savePi"><div class="form-title"><Bot size={17} /><strong>Pi Provider</strong><span class={`badge ${data.pi.configured ? 'high' : 'low'}`}>{data.pi.configured ? '已配置' : '未配置'}</span></div>
              <div class="field"><label for="provider">Provider</label><select id="provider" name="provider" value={data.pi.profile.provider}><option value="openai">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option><option value="google">Google Generative AI</option><option value="openrouter">OpenAI Chat / OpenRouter</option></select></div>
              <div class="field"><label for="modelId">模型 ID</label><input id="modelId" name="modelId" value={data.pi.profile.modelId} required /></div>
              <div class="field"><label for="baseUrl">自定义 Base URL</label><input id="baseUrl" name="baseUrl" value={data.pi.profile.baseUrl || ''} placeholder="可留空" /></div>
              <div class="field"><label for="apiKey">替换 API Key</label><input id="apiKey" name="apiKey" type="password" autocomplete="new-password" placeholder="不修改可留空" /></div>
              <div class="field"><label for="thinkingLevel">思考强度</label><select id="thinkingLevel" name="thinkingLevel" value={data.pi.profile.thinkingLevel}><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></div>
              <label class="checkbox"><input name="supportsImage" type="checkbox" checked={data.pi.profile.input?.includes('image') || false} /> 支持图片输入</label>
              <label class="checkbox"><input name="reasoning" type="checkbox" checked={data.pi.profile.reasoning || false} /> 启用模型推理</label>
              <label class="checkbox"><input name="sessionAffinity" type="checkbox" checked={data.pi.profile.sessionAffinity || false} /> 启用会话亲和</label>
              <p class="form-help">输入：文字{data.pi.profile.input?.includes('image') ? '、图片' : ''}；输出：文字。</p>
              <button class="button primary" type="submit">保存 Pi 配置</button></form>
          </div>
        </section>

        <section id="alerts">
          <div class="section-title"><div><AlertTriangle size={18} /><h2>告警与任务</h2></div></div>
          <div class="split-list">
            <div class="panel list-panel"><div class="list-heading"><h3>待处理告警</h3>{#if data.alerts.length > 0}<form method="POST" action="?/acknowledgeAll" onsubmit={(event) => { if (!confirm(`确定确认全部 ${data.alerts.length} 条待处理告警吗？`)) event.preventDefault(); }}><button class="button" type="submit">一键确认</button></form>{/if}</div>{#if data.alerts.length === 0}<div class="empty small">当前没有告警</div>{/if}
              {#each data.alerts as alert}<div class="list-row"><div><strong>{String(alert.title)}</strong><small>{String(alert.message)} · {relativeTime(String(alert.last_seen_at))}</small></div>
                <form method="POST" action="?/acknowledge"><input type="hidden" name="alertId" value={String(alert.id)} /><button class="button" type="submit">确认</button></form></div>{/each}</div>
            <div class="panel list-panel"><h3>最近任务</h3>{#each data.jobs.slice(0, 12) as job}<div class="list-row"><div><strong>{jobLabel(job.type)}</strong><small>{statusLabel(job.status)} · 尝试 {Number(job.attempts)} 次</small></div><time>{relativeTime(String(job.updated_at))}</time></div>{/each}</div>
          </div>
        </section>

        <section id="integration">
          <div class="section-title"><div><ServerCog size={18} /><h2>邮件与本机 Agent API</h2></div></div>
          <div class="settings-grid">
            <form class="panel form-panel" method="POST" action="?/saveSmtp"><div class="form-title"><Mail size={17} /><strong>SMTP 告警邮件</strong></div>
              <div class="field"><label for="smtp-host">服务器</label><input id="smtp-host" name="host" value={data.smtp?.host || ''} /></div><div class="field"><label for="smtp-port">端口</label><input id="smtp-port" name="port" type="number" value={data.smtp?.port || 587} /></div>
              <div class="field"><label for="smtp-username">用户名</label><input id="smtp-username" name="username" value={data.smtp?.username || ''} /></div><div class="field"><label for="smtp-password">替换密码</label><input id="smtp-password" name="password" type="password" /></div>
              <div class="field"><label for="smtp-from">发件人</label><input id="smtp-from" name="from" value={data.smtp?.from || ''} /></div><div class="field"><label for="smtp-to">收件人</label><input id="smtp-to" name="to" value={data.smtp?.to || ''} /></div>
              <label class="checkbox"><input name="secure" type="checkbox" checked={data.smtp?.secure || false} /> 使用隐式 TLS</label><button class="button primary" type="submit">保存 SMTP</button></form>
            <form class="panel form-panel" method="POST" action="?/createToken"><div class="form-title"><KeyRound size={17} /><strong>创建管理 API 令牌</strong></div>
              <div class="field"><label for="token-name">令牌名称</label><input id="token-name" name="name" value="server-agent" required /></div>
              {#each ['status:read','config:read','config:write','ops:run','audit:read','secrets:read','secrets:write'] as scope}<label class="checkbox"><input type="checkbox" name="scope" value={scope} /> {scope}</label>{/each}
              <button class="button primary" type="submit">创建一次性令牌</button>
              {#if data.tokens.length > 0}<div class="token-list">{#each data.tokens as token}<div><span><strong>{String(token.name)}</strong><small>{String(token.token_prefix)}… · {token.revoked_at ? '已撤销' : '有效'}</small></span>{#if !token.revoked_at}<button class="button danger" type="submit" formaction="?/revokeToken" name="tokenId" value={String(token.id)}>撤销</button>{/if}</div>{/each}</div>{/if}
            </form>
          </div>
        </section>
      </div>

      <aside><PiChat /><div class="panel audit"><h3>最近审计</h3>{#each data.audit.slice(0, 12) as entry}<div><strong>{auditLabel(entry.action)}</strong><small>{actorLabel(entry.actor_type)} · {relativeTime(String(entry.created_at))}</small></div>{/each}</div></aside>
    </div>
  </section>
{/if}

<style>
  .login-page { min-height: calc(100vh - 64px); display: grid; place-items: center; padding: 24px; }
  .login { width: min(380px, 100%); display: grid; gap: 14px; padding: 30px; justify-items: stretch; }
  .login-icon { width: 42px; height: 42px; justify-self: center; display: grid; place-items: center; border-radius: 14px; color: #fff; background: linear-gradient(145deg, var(--pink-soft), var(--pink)); box-shadow: 0 5px 14px -4px rgb(251 114 153 / 60%); }
  .login h1 { margin: 0; font-size: 20px; text-align: center; }
  .login p { margin: -8px 0 0; color: var(--muted); font-size: 13px; text-align: center; }
  .login .button { width: 100%; }
  .top-notice, .token-reveal { margin-bottom: 14px; }
  .token-reveal { display: grid; gap: 7px; padding: 13px 15px; border: 1px solid rgb(250 178 25 / 34%); border-radius: var(--r); background: var(--amber-tint); color: var(--amber); }
  .token-reveal code { overflow-wrap: anywhere; font-size: 12.5px; }
  .admin-shortcuts { display: flex; gap: 9px; margin-bottom: 14px; }
  .token-list { display: grid; gap: 9px; margin-top: 4px; padding-top: 11px; border-top: 1px solid var(--line-soft); }
  .token-list > div { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .token-list span { min-width: 0; }
  .token-list strong, .token-list small { display: block; overflow: hidden; text-overflow: ellipsis; }
  .token-list small { margin-top: 2px; color: var(--muted-2); font-size: 11.5px; }
  .token-list .button { min-height: 31px; padding: 0 12px; font-size: 12.5px; }

  .stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 14px; margin-bottom: 30px; }
  .stat { min-height: 96px; display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 4px 11px; padding: 18px; }
  .stat :global(svg) { grid-row: 1 / 3; width: 30px; height: 30px; padding: 7px; border-radius: var(--r-sm); background: var(--pink-tint); color: var(--pink-ink); }
  .stat strong { font-size: 26px; font-weight: 700; line-height: 1; }
  .stat span { color: var(--muted); font-size: 12px; }

  .admin-grid { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 24px; align-items: start; }
  .admin-main { min-width: 0; display: grid; gap: 34px; }
  .admin-main > section, .admin-grid aside, .settings-grid > *, .split-list > * { min-width: 0; }
  .admin-grid aside { display: grid; gap: 18px; position: sticky; top: 84px; }
  .section-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .section-title > div, .form-title { display: flex; align-items: center; gap: 9px; }
  .section-title h2 { margin: 0; font-size: 18px; }
  .form-title { font-size: 15px; }
  .form-title :global(svg) { color: var(--pink-ink); }
  .form-title .badge { margin-left: auto; }

  .table-wrap { overflow: hidden; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 12px 18px; text-align: left; border-bottom: 1px solid var(--line-soft); white-space: nowrap; }
  th { padding-bottom: 9px; color: var(--muted-2); font-size: 12px; font-weight: 600; }
  tr:last-child td { border-bottom: 0; }
  td strong, td small { display: block; }
  td strong { font-weight: 620; }
  td small { margin-top: 2px; color: var(--muted-2); font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .row-actions { display: flex; justify-content: flex-end; gap: 7px; }
  .row-actions .icon-button { width: 30px; height: 30px; }

  .form-panel { display: grid; gap: 13px; padding: 18px 20px; align-content: start; }
  .four-cols { grid-template-columns: repeat(4, 1fr) auto; align-items: end; margin-top: 12px; background: var(--surface-muted); }
  .four-cols .form-title { grid-column: 1 / -1; }
  .four-cols .wide { grid-column: span 2; }
  .streamer-editor { margin-top: 9px; overflow: hidden; }
  .streamer-editor summary { cursor: pointer; padding: 13px 18px; font-size: 12.5px; font-weight: 650; color: var(--muted); }
  .streamer-editor summary:hover { color: var(--text); }
  .streamer-editor .form-panel { border-top: 1px solid var(--line-soft); }
  .settings-grid, .split-list { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
  .form-help { margin: -6px 0 0; color: var(--muted-2); font-size: 12px; line-height: 1.6; }

  .list-panel h3, .audit h3, .list-heading h3 { margin: 0; padding: 15px 18px; border-bottom: 1px solid var(--line-soft); font-size: 14.5px; }
  .list-row, .audit > div { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--line-soft); }
  .list-row:last-child, .audit > div:last-child { border-bottom: 0; }
  .list-row > div, .audit > div { min-width: 0; }
  .list-row strong, .audit strong { display: block; font-size: 13.5px; font-weight: 620; }
  .list-row small, .audit small, .list-row time { display: block; margin-top: 3px; color: var(--muted-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .list-row .button { min-height: 31px; padding: 0 12px; font-size: 12.5px; }
  .list-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--line-soft); }
  .list-heading h3 { border-bottom: 0; }
  .list-heading form { margin-right: 14px; }
  .list-heading .button { min-height: 31px; padding: 0 12px; font-size: 12.5px; }
  .audit { overflow: hidden; }
  .audit > div { display: grid; justify-content: stretch; }

  @media (max-width: 1050px) { .admin-grid { grid-template-columns: minmax(0, 1fr); } .admin-grid aside { position: static; } .stats-grid { grid-template-columns: repeat(3, 1fr); } .table-wrap { overflow: auto; } }
  @media (max-width: 760px) { .four-cols, .settings-grid, .split-list { grid-template-columns: 1fr; } .four-cols .form-title, .four-cols .wide { grid-column: 1; } .stats-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
