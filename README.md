# 监控室老大爷

面向 B 站主播的低资源监控与归档网站。系统持续检查直播状态，归档动态正文、图片、评论和楼中楼，保存内容修订历史，并结合固定周表、动态信号和受限 Pi Agent 推测下一次开播时间。

项目按 1 核 CPU、1 GB 内存的 Linux 主机设计：单 Node.js 进程、SQLite WAL、单任务 worker，无 Redis、PostgreSQL、容器或常驻浏览器依赖。

## 功能

- 首页展示主播头像、直播/轮播状态和预计开播时间
- 正确处理直播间短号与真实房间号映射，并用 UID 防止错误绑定
- 初次导入和手动刷新归档最近半年动态，半年以前的既有归档不受影响
- 每天重新比对半年内动态；正文、表情或图片变化时保存旧版本
- 单条动态可独立刷新；源动态删除后保留删除前最后版本并明确标记
- 完整扫描连续两次缺失才确认删除，单次缺失显示为疑似删除
- 动态详情可切换历史版本，查看当时的正文、表情和已归档图片
- 主播归档支持复合游标分页、关键词、日期、类型、状态、图片和修订筛选
- 动态详情支持正文、图片、表情和状态的版本差异对比
- 评论与全部楼中楼分级同步，按动态年龄逐步降频
- 图片本地归档、SHA-256 去重、单文件限制和共享容量配额
- 后台配置主播、Cookie、固定周表、人工预测、Pi、SMTP 和 API Token
- 周表图片先生成识别草稿，在后台人工编辑确认后才进入正式单周安排
- 预测区分精确时间、时间范围、今日取消、信息不足和待更新，并统计实际开播误差
- localhost 管理 API 供外部 Agent 做受限、可审计、幂等的运维操作

## 快速开始

需要 Node.js 24 LTS（最低 `22.19.0`）和 npm。

```powershell
npm ci --ignore-scripts
$env:ADMIN_INITIAL_PASSWORD='change-this-password'
npm run dev
```

开发服务器地址由 Vite 输出。生产运行：

```powershell
npm run check
npm test
npm run build
npm start
```

默认地址：

- 网站和后台：`http://127.0.0.1:4311`，后台路径 `/admin`
- 本机管理 API：`http://127.0.0.1:4312/v1`
- OpenAPI：`http://127.0.0.1:4312/v1/openapi.json`
- 健康检查：`http://127.0.0.1:4312/v1/healthz`

生产环境必须配置随机的 32 字节 Base64 `APP_ENCRYPTION_KEY`，并把 `ORIGIN` 设置成用户实际访问的完整源，例如 `https://monitor.example.com`。完整变量见 [.env.example](.env.example)。

## 数据与调度

SQLite 数据库、Pi 会话、媒体和备份默认保存在 `data/`，生产环境建议设置 `DATA_DIR=/var/lib/vtb-monitor`。

- 直播状态默认每 30 秒批量检查
- 最新动态按主播配置的周期检查，默认 5 分钟
- 每个主播每天执行一次最近半年全量比对
- 新动态评论优先同步，之后按 5 分钟、1 小时、1 天、1 周降频
- 媒体默认总配额 5 GB，达到 90% 告警，满额后文本与评论仍继续同步

## 外部 Agent 运维

外部 Agent 不应获得数据库、Shell、文件系统或公网任意 HTTP 权限。推荐把 Agent 与 VTB Monitor 部署在同一主机或同一受控网络命名空间，只向它提供：

1. `127.0.0.1:4312/v1` 管理 API。
2. 后台生成的最小权限 Bearer Token。
3. systemd 的只读状态与受控 restart 能力，仅在确实需要进程管理时单独授权。

管理 API 支持状态、任务、告警、审计、主播配置、动态版本、半年刷新和单动态刷新。所有写操作使用 `Idempotency-Key`，配置更新使用乐观版本号，敏感操作写入审计日志。

推荐的日常运维 Token scopes：

```text
status:read config:read ops:run audit:read
```

不要默认授予 `config:write`、`secrets:read` 或 `secrets:write`。API 不提供任意 SQL、命令执行、文件读写、任意 URL 请求、服务关闭或删除归档能力。

完整说明见：

- [系统架构](docs/ARCHITECTURE.md)
- [外部 Agent 运维](docs/AGENT_OPERATIONS.md)
- [管理 API](docs/MANAGEMENT_API.md)
- [部署、备份与恢复](docs/DEPLOYMENT.md)

## 验证

```bash
npm run check
npm test
npm run build
npm run test:e2e
npm run test:performance
npm run doctor
```

CI 在 push 和 pull request 时执行依赖审计、类型检查、单元测试、生产构建和 Playwright 测试。

## 安全与平台兼容

B 站接口属于非官方兼容层，可能随平台更新变化。建议使用专用低权限 Cookie，控制刷新频率并遵守平台规则与适用法律。动态、评论和图片均视为不可信输入；它们不会被解释为 Agent 指令。
