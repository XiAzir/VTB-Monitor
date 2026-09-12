# Rust core + 原版 Svelte WebUI + 原版 TypeScript Pi

本分支默认运行混合版本：Rust 常驻承担采集、直播观测、持久队列、媒体和统一入口；原 SvelteKit 服务端与 TypeScript Pi 在一个私有、按需启动的 Node 子进程中运行。**不是纯 Rust、不是零 Node 内存**。`src/routes/**/*.svelte`、`src/lib/components/**/*.svelte` 和原 CSS 不重新仿写；原页面、表单动作、Cookie、管理 API 和 Pi 流式回复仍由原实现处理。

旧实验中的 Rust Pi/简化静态界面不再是默认路径。仅显式 `VTBM_NATIVE_EXPERIMENTAL=1` 才能启用旧实验模式；不建议生产使用。旧实验的二十多 MiB 成绩不能用于证明混合版内存。

## 本地构建

需要 Linux 对应架构的 Rust 工具链、Node 24（原项目最低 >=22.19）、生产 npm 依赖。开发机或 CI 构建，不在 1C1G 生产机上编译。

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
cargo test --manifest-path rust/Cargo.toml --all-targets
cargo build --manifest-path rust/Cargo.toml --release --bin vtb-monitor-rs
```

从仓库根目录启动 `rust/target/release/vtb-monitor-rs`。必须同时部署 `build/`、`hybrid/sidecar.mjs` 和匹配锁文件的生产 `node_modules/`；单独复制 Rust 二进制不能运行原界面/Pi。不要上传 Windows 的 node_modules 到 Linux。

```sh
export VTBM_APP_ROOT=/opt/vtb-monitor
export VTBM_NODE=/usr/bin/node
export DATA_DIR=/var/lib/vtb-monitor-hybrid
export DATABASE_PATH=/var/lib/vtb-monitor-hybrid/vtb-monitor.sqlite
export MEDIA_DIR=/var/lib/vtb-monitor-hybrid/media
export APP_ENCRYPTION_KEY='与原版相同的32字节base64主密钥'
export NODE_ENV=production
export HOST=127.0.0.1
export PORT=4311
export MANAGEMENT_PORT=4312
export ORIGIN=https://你的站点域名
# 初次核对数据时关闭采集，完成验证再删除这一行。
export DISABLE_SCHEDULER=1
./rust/target/release/vtb-monitor-rs
```

主密钥必须沿用，不能为了让新服务启动而重新生成后覆盖旧密文。已有管理员时不覆盖密码。新空库可使用 `ADMIN_INITIAL_PASSWORD` 一次初始化，登录后更改并移除变量。

## 数据迁移与唯一调度器

先暂停旧归档写入，保存数据库、媒体、配置及主密钥的一致性备份；演练用新目录与不同端口，不操作唯一的生产副本。

```sh
./rust/target/release/vtb-monitor-rs migrate-copy /old/vtb-monitor.sqlite /new/vtb-monitor.sqlite
```

命令拒绝覆盖目标，只复制数据库并迁移副本。媒体目录需另行复制；不要把数据库已复制误认为媒体也已迁移。确认数据和新功能前不启用采集；切换时停止旧 Web 内嵌调度、旧 scheduler 和旧 worker，避免抢同一任务、双重模型计费和重复请求 B 站。

新版本的 Node 子进程由 Rust 管理，不能再单独启动 `hybrid/sidecar.mjs`；它需要一次性端口与能力令牌。也不能同时运行旧 `npm start` 与新 Rust 在同一端口。`npm start` 仍保留原程序作为独立回退路径，不是混合模式入口。

## 内存与调度边界

- 常驻一个 Rust 进程；访问 WebUI 或有 Pi 任务时启动一个 Node 辅助进程。默认空闲 30 秒回收；活跃响应和 Pi 工作结束前不会按空闲规则回收。
- Node old-space 默认 64 MiB、semi-space 2 MiB。**这些不是进程 RSS 或后端总内存上限**。OS cgroup 必须同时包含父进程和 Node 子进程。
- `VTBM_SIDECAR_IDLE_MS` 可设 1000–3600000，默认 30000。更短会增加冷启动延迟与 CPU 消耗；访问频繁时辅助进程会持续存在，不承诺永远只占 Rust 空闲内存。
- Rust 保留原始 Cookie、重定向、Svelte 增强表单协议、流式 Pi 响应与历史；API 请求并发/连接数量有界，繁忙可返回 503/Retry-After，不无限排队。
- Pi仍使用原 SDK、provider、thinking/session 设置和原业务工具。图片批次只先读取元数据，执行时再加载一批；不再预先把所有图片批次转成 base64。单批 10 MiB；超限或缺图明确失败/等待，不把部分证据说成识别完成。自动图像切片仍未实现。
- 新 Pi 对话存储不重复写内联图片，图片仍在媒体归档中。旧历史不会在上线时被破坏性清理。
- 动态新增按原分析版本去重；动态编辑走原 `pi_revision`，保留旧事件供 Pi 判断，不先行清空。未来固定周表到期的投影仍走原 store 逻辑。

## 验证

```sh
npx playwright install chromium
npx playwright test --config hybrid/playwright.config.ts
# 独立 Linux 测试环境，需要 cgroup v2 与管理员权限。
sudo env PATH="$PATH" python3 hybrid/acceptance.py --memory-mib 150
```

浏览器测试使用原 e2e 流程，并输出桌面/移动端截图。UI源码保真检查以 `cdb62d9` 为基准；空源码差异并不替代浏览器功能测试。

Pi集成使用真实 TypeScript Pi/SDK，供应商是本地确定性 SSE 模拟服务，不调用付费模型/B站。测试包括登录、管理端隔离、Pi逐段回复、历史、9 MiB图像到达供应商、周表工具写入、空闲回收和重新启动。**Rust及其Node子进程在同一个150 MiB cgroup中**；测试生成器/浏览器/模拟供应商在组外。结果需看同一次提交的 `hybrid/results/acceptance.json`，不能只用 Rust 的 VmRSS 来报告总量。

真实模型准确率、每个供应商自定义网关、长期泄漏、生产数据量和更低的100 MiB限额仍需单独验收。原 TypeScript Pi 的历史时间语义缺陷并不会因为保留 SDK 自动消失；本轮侧重恢复原 UI/Pi 兼容性，不宣称已修复全部历史业务问题。
