# VTB Monitor Rust：低内存重构候选版

本目录是可编译、可启动的 Rust 后端，包含静态管理页面、SQLite 数据层、采集与持久任务、媒体下载与代理、日程/预测、模型 HTTP 适配器、管理员认证、令牌和 SMTP 告警。运行时不需要 Node、tsx、Svelte SSR、Redis 或另一个 worker 进程。

**这是隔离分支上的候选实现，不是已经完成全量功能等价认证的原地升级版本。不要将它直接指向唯一的生产数据库。** 主分支保持原样；本目录保留对旧数据库结构的兼容，不表示所有旧 URL、API 响应和 UI 交互完全一致。

## 构建与启动

在开发机/CI 构建，不在 1C1G 生产机器上编译：

```sh
cd rust
cargo build --locked --release --bin vtb-monitor-rs
```

CI 的源码包包含本次解析并测试过的 `Cargo.lock`。分支首次构建没有锁文件时，先运行 `cargo generate-lockfile`，审核锁文件后再使用 `--locked`。实测环境及实际 Rust 版本见 CI `environment.txt`，不将 Cargo.toml 声明的最低版本视为已经验证。

启动前提供环境变量：

```sh
export DATA_DIR=/path/to/separate-rust-data
export DATABASE_PATH="$DATA_DIR/vtb-monitor.sqlite"
export MEDIA_DIR="$DATA_DIR/media"
export HOST=127.0.0.1
export PORT=4411
export MANAGEMENT_PORT=4412
export ORIGIN=http://127.0.0.1:4411
export APP_ENCRYPTION_KEY='原项目使用的32字节base64主密钥'
# 仅空数据库初始化时设置；已有管理员时不会覆盖其密码。
# export ADMIN_INITIAL_PASSWORD='自行生成的长随机密码'
./target/release/vtb-monitor-rs
```

正式发布二进制不允许 Bilibili mock 环境变量。`bench-ablation` 构建仅供测试；不得作为生产发布包。提供的 Linux x86_64 构建使用 glibc，SMTP 模块还依赖 OpenSSL 3；兼容系统以 `linked-libraries.txt` 为准。其他架构应在匹配环境重新构建。

## 安全迁移和回滚

1. 对原数据目录、媒体和主密钥分别建立备份。迁移演练用数据库副本；原 Node 服务和 Rust 服务不能同时写同一份数据库/媒体目录。
2. 将原媒体目录复制到新的 Rust DATA_DIR。复制媒体与数据库时应暂停原归档写入或使用一致性快照，以免得到时间点不一致的副本。
3. 使用只读源连接创建新的数据库副本：

```sh
./vtb-monitor-rs migrate-copy /original/vtb-monitor.sqlite /new-rust-data/vtb-monitor.sqlite
```

命令拒绝覆盖目标文件，使用 SQLite Online Backup API 复制并检查数据库；不会迁移/复制媒体、环境密钥、外部 Pi 会话库或其他目录。原始 Node AES-256-GCM 密钥密文和 scrypt 密码格式保持兼容。

4. 初次启动可设 `DISABLE_SCHEDULER=1`，使用不同端口核对归档、登录、日程和配置。开启采集前应停止旧进程，避免对 B 站重复请求。
5. 回滚时停止 Rust 并重新指向原先未修改的 Node 数据副本。不要认为 Rust 写入后的数据库/新增业务状态已经验证可无损降级。

## 内存约束的实现

- 单后端进程：单线程 Tokio 事件循环，SQLite 在一个专用线程中运行，阻塞线程池最多 2 个线程。
- SQLite 请求队列 16 项；普通 API 同时最多 4 项，媒体传输最多 2 项；登录哈希、视觉 AI、历史预测、管理聊天和 SMTP 使用同一个昂贵操作信号量。
- 公网监听实际只绑定 loopback，由现有 TLS 反向代理转发；Web 最多 16 个已接受连接、管理端最多 4 个。繁忙时有界拒绝，不在内存中无限排队。
- 媒体按 64 KiB 流式读写与哈希；动态归档媒体最大 25 MiB。AI 一般每批最多两图、6 MiB；单张可达 10 MiB。超过视觉预算的图片保留归档与审核记录，不假装已完成识别；本版未实现自动缩放/切块服务。
- SQLite 使用 WAL，建议页缓存 2 MiB，临时结果 FILE，mmap 关闭；查询同时限制行数和返回字节，不把全量历史 JSON 载入进程。
- 历史数据和模型结果存于 SQLite。每条内容的版本、发布时间、时区、图片摘要和模型配置参与缓存标识；不是仅按正文字符串复用绝对日期。

`MemoryMax` 是隔离边界，不是无论输入如何都不会 OOM 的数学证明。测试报告必须同时检查工作完成、输出一致、OOM、延迟、拒绝率和 cgroup 峰值。设置硬上限后任务全被阻塞/杀死，不算优化成功。

## 功能兼容矩阵

| 项目 | 本版状态 |
| --- | --- |
| 登录、密码轮换、原 scrypt/AES-GCM 格式 | 已实现；有跨 Node/Rust 测试 |
| 主播配置、版本冲突、令牌与权限、审计、幂等回执 | 已实现；回执加密，业务写入与回执同事务 |
| 动态、评论、楼中楼、历史修订与媒体留档 | 已实现主要路径；真实平台类型覆盖尚需原样本回放 |
| 媒体下载、去重、本地服务、代理 | 有界流式；字节一致性和主机白名单测试 |
| 最新动态、完整历史扫描、独立扫描删除判断 | 已实现分页任务；183 天窗口与原“六个月”定义有差异 |
| 直播观测、房间身份核对、历史场次 | 已实现；初次已在播不伪造准确开始时刻 |
| 固定日程、周表审核、取消、人工覆盖 | 已实现；取消作用域与人工锁有回归测试 |
| 图文提取、模糊日期审核、历史预测与缓存 | 已实现；确定性模型 mock 不证明真实识别准确率 |
| OpenAI/Anthropic/Google/OpenRouter HTTP 适配 | 已编写；并未逐一在真实付费账户验收 |
| 管理聊天与受限业务动作 | 有界历史和动作；当前返回整段 JSON，不保留原逐字流式体验 |
| SMTP 告警 | 已编写；失败任务监测在同进程；真实 SMTP 端到端未验收 |
| 原 Svelte UI、原 URL、管理 OpenAPI 完整契约 | **不是等价替换**：新静态界面，部分旧深链接、富文本/表情、分页交互和返回结构尚未完全对齐 |
| Pi SDK thinking/session affinity、人工单轮附加指令 | **尚未完整移植**，不宣称行为等价 |
| 旧媒体引用全面回填、媒体垃圾回收、旧 Pi 会话压缩 | **未自动执行破坏性清理**；保留原档案，不以删除功能或资料降低内存 |
| 超大/长周表自动图像切块 | **未实现**；超限进入审核，不静默丢图 |

因此，本版适合在副本上验证与继续收敛；不能仅凭内存成绩宣称已经满足“全部旧功能无差异”。

## 测试与消融

```sh
cargo test --all-targets --features bench-ablation
cargo build --release --bins --features bench-ablation
cd ..
sudo python3 rust/tests/acceptance.py --binary rust/target/release/vtb-monitor-rs --memory-mib 150
sudo python3 rust/tests/soak.py --binary rust/target/release/vtb-monitor-rs --memory-mib 100 --seconds 90
sudo python3 rust/tests/ablation.py --binary rust/target/release/vtb-monitor-rs --memory-mib 150 --repetitions 3
```

cgroup 测试必须在有 root 权限的独立 Linux 测试环境运行。无法设置限制会失败，不会偷偷退化成无限内存测试。禁止 swap，CPU quota 为一个核的算力；mock 和压测驱动在组外，后端页缓存、线程和子进程在组内。

消融在同一 Rust 实现中逐一撤掉流式媒体、有界图像批次、游标读取和 AI 并发约束，并包含组合撤除。媒体对照两组均为 2 并发。测试核对同样输入字节/行和摘要，但不等于 Node-vs-Rust 对比、不等于视觉模型准确率等价。90 秒混合测试也不是 24 小时泄漏测试。

每次 CI 保存源码提交、二进制摘要、生产/测试构建区分、原始 JSON、日志和采样。以对应提交的实际结果为准；失败的测试不能因为其他组通过就省略。
