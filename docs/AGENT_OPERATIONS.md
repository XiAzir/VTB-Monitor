# 外部 Agent 运维指南

本文定义外部运维 Agent 的推荐权限、工作流和故障处置边界。目标是让 Agent 能观察和修复业务状态，但不能获得通用主机控制能力。

## 推荐拓扑

```text
external agent
  |-- Bearer token --> 127.0.0.1:4312/v1
  |-- optional sudo --> systemctl status/restart vtb-monitor
  `-- no access ----> SQLite, media files, application secrets, arbitrary network
```

Agent 最好与应用运行在同一主机。若必须跨主机访问，应通过受认证的私有隧道映射 4312，不能直接监听 `0.0.0.0` 或暴露到公网。

## 权限配置

日常观察与恢复 Token：

```text
status:read config:read ops:run audit:read
```

配置维护时临时增加 `config:write`。`secrets:read` 会返回明文密钥，原则上不授予自动 Agent；写入新 Cookie 或 API Key 时可签发短期 `secrets:write` Token，完成后立即撤销。

Agent 不需要、也不应拥有：

- SQLite 文件权限
- 项目目录写权限
- 通用 Shell
- 任意 URL 请求能力
- `secrets:read`
- 删除归档或媒体的能力

## 启动检查

1. `GET /healthz`，确认监听器工作。
2. `GET /status`，检查 pending jobs 和 open alerts。
3. `GET /alerts`，按 `critical`、`warning` 排序处置。
4. `GET /jobs`，检查持续 retry/failed 的任务及 `last_error`。
5. `GET /streamers`，确认主播启用状态、配置版本和最近检查时间。

健康检查无需 Token，其余请求必须携带 Bearer Token。

## 标准恢复动作

| 现象 | Agent 动作 | 不应自动执行 |
| --- | --- | --- |
| 单主播数据滞后 | `operations/sync` | 修改 UID/房间号 |
| 半年归档可能不一致 | `operations/refresh` | 删除旧归档 |
| 单动态正文、图片异常 | `dynamics/{id}/operations/refresh` | 手工改数据库 |
| 预测滞后 | `operations/reanalyze` 或 `reforecast` | 覆盖人工锁定预测 |
| Cookie 失效 | 告警并请求人工更新 | 读取浏览器 Cookie |
| 媒体配额满 | 告警并请求扩容/人工清理 | 自动删除历史图片 |
| API 无响应 | 检查 systemd，必要时受控 restart | kill 任意 Node 进程 |
| SQLite integrity 失败 | 停止写入并升级人工处置 | 自动覆盖数据库 |

## 幂等与轮询

所有 POST/PATCH 使用唯一 `Idempotency-Key`。建议格式：

```text
agent-name:operation:entity-id:2026-08-22T04:00Z
```

服务在同一 Token 下保存 24 小时结果。网络超时时应重用原 key，不要生成新 key，否则可能重复排队。

操作接口返回 `202` 和 `jobId`，代表已入队，不代表已完成。Agent 应以退避方式查询 `/jobs`：2 秒、5 秒、15 秒、30 秒，之后最多每分钟一次。不要高频轮询。

## 配置更新

1. `GET /streamers` 获取当前对象和 `version`。
2. 仅修改必要字段。
3. `PATCH /streamers/{id}`，正文必须带当前 `version`。
4. 收到版本冲突时重新 GET、重新评估，不能盲目覆盖。

创建或更新主播时，`biliUid` 是身份主键；直播间短号只作为别名，不能代替 UID 做身份判断。

## systemd 最小授权

业务 API 故意不提供进程启停。确需自动恢复时，可通过 sudoers 只授权以下固定命令：

```text
/usr/bin/systemctl status vtb-monitor
/usr/bin/systemctl restart vtb-monitor
/usr/bin/journalctl -u vtb-monitor --since ...
```

不要授权任意 `systemctl`、`journalctl` 参数、Shell 包装器或项目目录写权限。升级、迁移、恢复备份始终需要人工批准。

## 告警升级

以下情况必须停止自动尝试并通知管理员：

- Cookie 连续无效或 B 站持续返回风控错误
- 同一任务达到最大重试次数
- SQLite integrity check 非 `ok`
- 数据目录只读或磁盘空间不足
- 媒体配额已满
- 配置版本反复冲突
- 需要读取/替换密钥、删除数据、恢复备份或升级代码

## 审计

Agent 每轮操作后读取 `/audit`，确认 actor 为自己的 token，操作对象和预期一致。Token 应按 Agent 实例分别签发，禁止多 Agent 共用，以便追责和撤销。
