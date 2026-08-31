import { expect, test } from '@playwright/test';

test('public monitor, forecast range, archive filters and pagination render', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '主播监控台' })).toBeVisible();
  await expect(page.getByText('端到端测试主播')).toBeVisible();
  await expect(page.getByText('时间范围')).toBeVisible();
  await page.goto('/streamers/e2e-streamer');
  await expect(page.getByText('目标周表动态 第二版')).toBeVisible();
  await expect(page.getByRole('link', { name: '加载更早动态' })).toBeVisible();
  await page.getByPlaceholder('搜索正文').fill('目标周表');
  await page.getByRole('button', { name: '筛选' }).click();
  await expect(page.getByText('目标周表动态 第二版')).toBeVisible();
  await expect(page.getByText('归档动态 1', { exact: true })).toHaveCount(0);
});

test('dynamic revision comparison and schedule review workflow work', async ({ page }) => {
  await page.goto('/dynamics/e2e-dynamic-00');
  const revision = page.getByRole('link', { name: /第一版/ });
  await expect(revision).toBeVisible();
  await revision.click();
  await expect(page.getByText('版本变化')).toBeVisible();
  await expect(page.locator('.text-diff .added')).toContainText('二');
  await expect(page.locator('.text-diff .removed')).toContainText('一');

  await page.goto('/dynamics/e2e-media-alias');
  await page.getByRole('link', { name: /别名第二版/ }).click();
  const archivedImage = page.locator('.media-grid img');
  await expect(archivedImage).toBeVisible();
  await expect.poll(() => archivedImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

  await page.goto('/admin');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('E2E-Review-2026!');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('link', { name: '审核周表识别' }).click();
  await page.getByRole('link', { name: /端到端测试主播/ }).first().click();
  await expect(page.getByText('结构化条目 JSON')).toBeVisible();
  await page.getByLabel('只有星期时所对应的周一').fill('2026-08-24');
  await page.getByRole('button', { name: '确认周表' }).click();
  await expect(page.getByText('已确认 1 条单周安排')).toBeVisible();
});

test('video submissions and forwarded dynamics render as structured cards', async ({ page }) => {
  await page.goto('/dynamics/e2e-video-card');
  await expect(page.getByText('投稿视频完整卡片')).toBeVisible();
  await expect(page.getByText('03:48')).toBeVisible();
  await expect(page.getByRole('link', { name: /投稿视频完整卡片/ })).toHaveAttribute('href', 'https://www.bilibili.com/video/BV1e2e');

  await page.route('**/api/image-proxy/**', async (route) => route.fulfill({
    status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
  }));
  await page.goto('/dynamics/e2e-forward-card');
  await expect(page.getByText('转发动态')).toBeVisible();
  await expect(page.getByText('原动态作者')).toBeVisible();
  await expect(page.getByText(/原动态正文/)).toBeVisible();
  const emoji = page.locator('img.inline-emoji');
  await expect(emoji).toHaveCount(2);
  await expect.poll(() => emoji.evaluateAll((images: HTMLImageElement[]) => images.every((image) => image.naturalWidth > 0))).toBe(true);
});

test('local management health endpoint is available', async ({ request }) => {
  const response = await request.get('http://127.0.0.1:4314/v1/healthz');
  expect(response.ok()).toBe(true);
  expect((await response.json()).status).toBe('ok');
});
