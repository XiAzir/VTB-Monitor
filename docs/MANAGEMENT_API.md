# 本机管理 API

管理监听器默认为 `http://127.0.0.1:4312/v1`。它与网站使用不同端口，并在服务内部标记请求；通过 4311 访问相同路由会返回 404。

- `GET /healthz`：无需认证
- `GET /openapi.json`：无需认证
- 其他接口：`Authorization: Bearer <token>`
- POST/PATCH：还必须提供不超过 200 字符的 `Idempotency-Key`

Token 在 `/admin` 创建，只显示一次。可用 scopes：

| Scope | 能力 |
| --- | --- |
| `status:read` | 状态、任务、告警 |
| `config:read` | 主播、动态和版本读取 |
| `config:write` | 新增、修改主播 |
| `ops:run` | 排队同步、刷新、分析和确认告警 |
| `audit:read` | 审计日志 |
| `secrets:read` | 密钥元数据及明文读取，高风险 |
| `secrets:write` | 写入 Cookie/API Key 等密钥 |

## 接口

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | `/healthz` | 无 | 进程健康检查 |
| GET | `/openapi.json` | 无 | OpenAPI 3.1 文档 |
| GET | `/status` | `status:read` | 主播、动态、评论、任务和告警计数 |
| GET | `/jobs` | `status:read` | 最近 100 个任务及错误 |
| GET | `/alerts` | `status:read` | 当前告警 |
| POST | `/alerts/{id}/acknowledge` | `ops:run` | 确认告警 |
| GET | `/audit` | `audit:read` | 最近 200 条审计记录 |
| GET | `/streamers` | `config:read` | 主播配置与乐观锁版本 |
| POST | `/streamers` | `config:write` | 新增主播 |
| PATCH | `/streamers/{id}` | `config:write` | 更新主播，正文需含 `version` |
| GET | `/streamers/{id}/dynamics` | `config:read` | 最近 50 条归档动态 |
| POST | `/streamers/{id}/operations/sync` | `ops:run` | 同步最新动态 |
| POST | `/streamers/{id}/operations/refresh` | `ops:run` | 全量比对最近半年 |
| POST | `/streamers/{id}/operations/reanalyze` | `ops:run` | 重新进行 Pi 分析 |
| POST | `/streamers/{id}/operations/reforecast` | `ops:run` | 重新生成预测 |
| GET | `/dynamics/{id}/revisions` | `config:read` | 查看动态历史版本 |
| POST | `/dynamics/{id}/operations/refresh` | `ops:run` | 刷新单条动态并检测删除 |
| GET | `/secrets` | `secrets:read` | 密钥状态，不返回值 |
| GET | `/secrets/{key}/reveal` | `secrets:read` | 返回明文，`no-store`，会审计 |
| POST | `/secrets/{key}` | `secrets:write` | 写入加密密钥 |

`sync` 只追踪近期新内容；`refresh` 按当前时刻向前重新获取六个月，保留变化前版本，不覆盖半年以前的归档。

## 示例

PowerShell：

```powershell
$headers = @{ Authorization = "Bearer $env:VTBM_TOKEN" }
Invoke-RestMethod http://127.0.0.1:4312/v1/status -Headers $headers

$headers['Idempotency-Key'] = "ops:refresh:STREAMER_ID:20260822T0400Z"
Invoke-RestMethod -Method Post `
  http://127.0.0.1:4312/v1/streamers/STREAMER_ID/operations/refresh `
  -Headers $headers
```

curl：

```bash
curl -H "Authorization: Bearer $VTBM_TOKEN" \
  http://127.0.0.1:4312/v1/streamers

curl -X POST \
  -H "Authorization: Bearer $VTBM_TOKEN" \
  -H "Idempotency-Key: ops:dynamic:DYNAMIC_ID:20260822T0410Z" \
  http://127.0.0.1:4312/v1/dynamics/DYNAMIC_ID/operations/refresh
```

新增主播：

```json
{
  "name": "阿梓从小就很可爱",
  "slug": "azi",
  "biliUid": "7706705",
  "roomId": "510"
}
```

更新主播时发送当前版本和需要修改的字段：

```json
{
  "version": 3,
  "dynamicPollSeconds": 600,
  "enabled": true
}
```

## 响应与错误

- `200/201`：读取、创建或更新成功
- `202`：任务已入队，使用 `/jobs` 跟踪
- `400`：缺少幂等键、参数无效
- `401`：Token 缺失、过期或已撤销
- `403`：缺少 scope
- `404`：接口或对象不存在

幂等结果保存 24 小时。同一 Token 重试相同操作时必须重用同一 key。密钥响应包含 `Cache-Control: no-store, private`，密钥读取、写入和配置修改都会进入审计日志。
