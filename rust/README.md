# Rust core + 原版 Svelte WebUI + 原版 TypeScript Pi

默认架构：Rust 常驻负责统一入口、采集、直播观测、持久队列、媒体和数据库访问；原 SvelteKit 服务端与原 TypeScript Pi/SDK 运行于私有、按需启动的 Node 子进程。**不是纯 Rust，不是零 Node 内存。**原 8 个 `.svelte` 文件及 CSS 与 `cdb62d9` 完全一致，原页面、表单、Cookie、管理 API、Pi 逐段回复与历史使用原实现。

旧 Rust Pi/简化页面不再走默认路径，仅显式 `VTBM_NATIVE_EXPERIMENTAL=1` 启用；它的旧内存成绩不能用来证明本混合版。

## 构建与运行

在开发机或 CI 构建，不在 1C1G 生产机编译。需要对应 Linux 架构的 Rust 工具链、Node 24（原项目最低 >=22.19）及 npm 依赖。

```sh
npm ci --ignore-scripts
npm run check
npm test
node --test hybrid/request-memory.test.mjs
npm run build
cargo test --manifest-path rust/Cargo.toml --all-targets --locked
cargo build --manifest-path rust/Cargo.toml --release --bin vtb-monitor-rs --locked
```

部署必须包含 `build/`、`hybrid/sidecar.mjs`、`hybrid/request-memory.mjs`、Rust 二进制及匹配锁文件的生产 `node_modules/`。单独复制 Rust 二进制不能运行原界面/Pi。不要上传 Windows node_modules 到 Linux。`npm start` 仍是原 Node 程序的回退入口，不是本混合程序入口。

```sh
export VTBM_APP_ROOT=/opt/vtb-monitor
export VTBM_NODE=/usr/bin/node
export DATA_DIR=/var/lib/vtb-monitor-hybrid
export DATABASE_PATH=/var/lib/vtb-monitor-hybrid/vtb-monitor.sqlite
export MEDIA_DIR=/var/lib/vtb-monitor-hybrid/media
export NODE_ENV=production
export HOST=127.0.0.1
export PORT=4311
export MANAGEMENT_PORT=4312
export ORIGIN=https://你的站点域名
# APP_ENCRYPTION_KEY 必须通过受保护环境配置沿用原32字节base64主密钥。
# 首次演练关闭采集，核对通过后移除这一项。
export DISABLE_SCHEDULER=1
./rust/target/release/vtb-monitor-rs
```

主密钥必须沿用，不得重新生成后覆盖旧密文。新空库支持 `ADMIN_INITIAL_PASSWORD` 一次初始化，登录改密后移除。只有 Rust 启动辅助进程，不能单独运行 sidecar；其端口和能力令牌不对外发布。

服务示例：`hybrid/vtb-monitor-hybrid.service`，使用独立的 `/etc/vtb-monitor-hybrid.env` 与 `/var/lib/vtb-monitor-hybrid`，避免误用旧服务的数据路径。从原受保护配置中沿用同一主密钥；环境文件权限设为 0600，并核对 `DATA_DIR`、`DATABASE_PATH`、`MEDIA_DIR` 三者一致。自定义数据位置时同时调整服务的写入允许目录。反代配置片段：`hybrid/nginx-location.conf`，包含 Pi 路由关闭响应缓冲。不要公开4312或Node的随机私有端口。

## 数据与调度切换

先保存数据库、媒体、配置及主密钥的一致性备份，在独立目录/端口演练：

```sh
./rust/target/release/vtb-monitor-rs migrate-copy /old/vtb-monitor.sqlite /new/vtb-monitor.sqlite
```

复制命令拒绝覆盖目标；原数据库不修改。**媒体目录需另行复制**。核对通过前关闭采集，切换时停止旧 Web 内嵌调度、旧 scheduler、旧 worker，避免同库抢任务、重复计费。不要将候选代码指向唯一的生产数据副本。

## 内存与行为边界

默认 Node old-space 48 MiB、semi-space 1 MiB，辅助进程空闲30秒回收。OS cgroup必须同时包含Rust与其Node子进程；V8参数不是RSS上限。访问频繁时Node持续存在，冷启动有延迟。

原Pi SDK/provider、thinking/session设置、业务工具、普通多轮聊天保留。唯一有意缩短的流程是：周表/编辑分析的最终结构化提交成功，且本轮所有工具都成功后，使用SDK `shouldStopAfterTurn`结束；不再把同图重新发送只为生成结束语。空草稿可正常提交；工具失败仍可修复；普通聊天和主播分析不使用这一提前结束钩子。

周表只规划元数据，执行时逐批读取；单批10MiB，缺图等待/失败，不提交部分证据。超大图自动切片未实现。新Pi历史不重复存base64，媒体归档保留；不会上线即删除旧历史。

大 HTTP 请求边界主动 GC 现为默认关闭，仅显式 `VTBM_REQUEST_GC=1` 开启。前一轮三次重复中未显示降低峰值的收益，因此不再默认启用；新消融使用 `default`（关闭）与 `with_request_boundary_gc`（开启）两组。同样的原 SDK、图片字节和工具流均保留，不以减少模型输入换取成绩。后台任务仍有有界截止时间与重试；超长模型/多图任务需要在目标环境验证。

## 验证与结果解释

```sh
npx playwright install chromium
npx playwright test --config hybrid/playwright.config.ts
sudo env PATH="$PATH" python3 hybrid/acceptance.py --memory-mib 150
sudo env PATH="$PATH" python3 hybrid/repeat-acceptance.py --memory-mib 150 --repetitions 3
```

最后两项必须在独立、支持cgroup v2的Linux测试环境运行。无法施加请求的限制就失败，不静默退化。原Pi和SDK实际运行，供应商是本地确定性SSE模拟服务，不访问真实B站/付费模型。9MiB GIF是合成字节负载，不代表OCR准确率测试。

内存以**完整后端cgroup**计量；不包含组外浏览器、模拟供应商、测试驱动或公用Nginx。各次原始采样、断言、OOM记录在对应CI artifact。短时通过不等于100MiB可用、全天稳定、每个自定义网关均兼容。请使用与源码提交一致的测试记录，勿引用早期纯Rust数据。
