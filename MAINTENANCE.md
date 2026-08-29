# VTB-Monitor 维护文档

## 最近修改记录 (2026-08-22)

### 问题修复

#### 1. B站API请求增强
**问题**：获取动态时可能失败，触发B站风控机制
**修复内容**：
- 在 `src/lib/server/bilibili.ts` 的 `fetchResponse` 方法中添加完整的浏览器请求头
- 新增请求头：
  - `accept: application/json, text/plain, */*`
  - `accept-language: zh-CN,zh;q=0.9,en;q=0.8`
  - `accept-encoding: gzip, deflate, br`
  - `sec-ch-ua: "Chromium";v="124", "Not(A:Brand";v="99"`
  - `sec-ch-ua-mobile: ?0`
  - `sec-ch-ua-platform: "Windows"`
  - `sec-fetch-dest: empty`
  - `sec-fetch-mode: cors`
  - `sec-fetch-site: same-site`
  - `origin: https://space.bilibili.com`

**测试结果**：配合有效Cookie，成功获取动态数据，无412错误

#### 2. 图片防盗链解决方案
**问题**：主播头像和动态图片无法显示，B站CDN防盗链保护
**修复内容**：

**2.1 服务器端URL规范化**
- 新增 `normalizeImageUrl` 函数处理：
  - 协议相对URL（`//example.com/image.jpg`）
  - HTTP自动升级为HTTPS
  - 确保所有图片URL使用标准协议

**2.2 图片代理服务**
- 创建 `src/routes/api/image-proxy/[...path]/+server.ts`
- 服务器端代理B站图片请求，添加正确的Referer头
- 仅允许B站域名（`hdslb.com`）通过代理
- 支持缓存控制和CORS

**2.3 前端集成**
- 创建 `src/lib/image.ts` 辅助函数 `proxyBilibiliImage`
- 自动识别B站图片URL并转换为代理路径
- 更新页面组件：
  - `src/routes/+page.svelte` - 主页主播头像
  - `src/routes/streamers/[slug]/+page.svelte` - 详情页头像
  - `src/routes/dynamics/[id]/+page.svelte` - 评论头像

**测试结果**：图片代理返回200 OK，头像和图片正常显示

#### 3. CSRF保护配置
**问题**：访问后台登录页面出现 "Cross-site POST form submissions are forbidden"
**修复内容**：
- 在 `svelte.config.js` 的 `csrf.trustedOrigins` 中添加：
  ```javascript
  'http://127.0.0.1:3000',
  'http://localhost:3000'
  ```

**测试结果**：后台登录功能正常

#### 4. 动态详情请求优化
**问题**：连续请求动态详情页触发B站风控，产生大量412告警
**修复内容**：
- 在 `src/lib/server/scheduler.ts` 的 `syncStreamer` 方法中：
  - 添加2-3秒随机延迟（`await delay(2000 + Math.floor(Math.random() * 1000))`）
  - 仅在非412错误时创建告警，避免告警泛滥
  - 跟踪已获取的详情数量

**测试结果**：降低风控触发概率，告警更清晰

### 修改文件清单

**新增文件**：
- `src/lib/image.ts` - 图片代理辅助函数
- `src/routes/api/image-proxy/[...path]/+server.ts` - 图片代理API端点

**修改文件**：
- `src/lib/server/bilibili.ts` - 增强请求头 + URL规范化
- `src/lib/server/scheduler.ts` - 动态详情请求延迟优化
- `src/routes/+page.svelte` - 使用图片代理
- `src/routes/streamers/[slug]/+page.svelte` - 使用图片代理
- `src/routes/dynamics/[id]/+page.svelte` - 使用图片代理
- `svelte.config.js` - CSRF信任源配置

### 技术细节

#### 请求头模拟
增强后的请求头模拟完整的Chrome 124浏览器标识，降低被B站识别为爬虫的概率。

#### 图片代理原理
```
浏览器 → /api/image-proxy/i2.hdslb.com/bfs/face/xxx.jpg
       ↓
服务器添加 Referer: https://www.bilibili.com/
       ↓
B站CDN → 返回图片
       ↓
浏览器显示图片
```

#### 风控应对策略
1. **使用有效Cookie**：配置B站登录Cookie可显著降低风控概率
2. **请求延迟**：动态详情请求间隔2-3秒
3. **渐进式获取**：失败的详情会在下次同步时重试
4. **告警过滤**：不为预期的风控响应创建告警

### 配置建议

#### 1. B站Cookie配置
在后台管理页面（`/admin`）的"密钥管理"中配置 `bilibili_cookie`：
- 从已登录的浏览器中导出Cookie
- Cookie包含：SESSDATA、bili_jct、DedeUserID等字段
- 定期更新以保持有效性

#### 2. 端口配置
默认端口配置在 `.env` 或环境变量中：
- `PORT=3000` - Web服务端口
- `MANAGEMENT_PORT=4312` - 管理端口

修改端口后需要同步更新 `svelte.config.js` 中的 `csrf.trustedOrigins`。

#### 3. 图片代理安全
图片代理仅允许 `hdslb.com` 域名，防止被滥用为通用代理。如需支持其他域名，在 `src/routes/api/image-proxy/[...path]/+server.ts` 中修改白名单。

### 已知问题与限制

1. **B站风控**：即使有Cookie和延迟，高频访问仍可能触发412。建议根据实际需求调整轮询间隔。

2. **Cookie有效期**：B站Cookie会过期，需要定期更新。系统会在Cookie失效时自动回退到匿名模式并发送告警。

3. **动态详情获取**：如果详情获取失败，基本信息（从列表获取）仍然可用，完整内容会在下次同步时重试。

### 调试工具

#### 测试B站API（使用项目Cookie）
```bash
npx tsx test_api.ts
```

创建 `test_api.ts`：
```typescript
import { BilibiliClient } from './src/lib/server/bilibili';
import { getSecret } from './src/lib/server/store';

const cookie = getSecret('bilibili_cookie');
const client = new BilibiliClient(cookie);

// 验证Cookie
const validation = await client.validateCookie();
console.log('Cookie状态:', validation);

// 获取动态
const dynamics = await client.fetchSpaceDynamics('7706705', 5);
console.log('获取动态数:', dynamics.items.length, '是否完整:', dynamics.complete);
```

#### 检查图片代理
```bash
curl -I http://localhost:3000/api/image-proxy/i2.hdslb.com/bfs/face/xxx.jpg
```

#### 查看告警
访问 `/admin` 后台管理页面，查看"活动告警"部分。

### 部署检查清单

- [ ] 配置有效的B站Cookie
- [ ] 设置环境变量 `APP_ENCRYPTION_KEY`（生产环境必需）
- [ ] 确认端口配置与CSRF信任源一致
- [ ] 运行 `npm run build` 构建生产版本
- [ ] 运行 `npm run doctor` 检查系统状态
- [ ] 测试图片代理功能
- [ ] 监控告警面板

### 性能优化建议

1. **调整轮询间隔**：根据主播活跃度调整 `dynamic_poll_seconds`
2. **限制详情获取数量**：在 `scheduler.ts` 中调整 `detailBudget` 的值
3. **图片缓存**：考虑在代理层添加Redis缓存
4. **数据库优化**：定期运行 `VACUUM` 清理SQLite数据库

### 更新日志

**2026-08-22**
- 增强B站API请求头，提升抓取成功率
- 实现图片代理解决防盗链问题
- 修复CSRF配置，支持localhost:3000
- 优化动态详情请求，添加延迟机制
- 抑制412风控告警，减少噪音

---

## 贡献者
- Claude (AI Assistant) - 问题诊断与修复实现
