import { expect, test } from '@playwright/test';

test('public monitor and empty state render', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '主播监控台' })).toBeVisible();
  await expect(page.getByText('尚未配置监控主播')).toBeVisible();
  await expect(page.getByRole('link', { name: '进入后台配置' })).toHaveAttribute('href', '/admin');
});

test('local management health endpoint is available', async ({ request }) => {
  const response = await request.get('http://127.0.0.1:4314/v1/healthz');
  expect(response.ok()).toBe(true);
  expect((await response.json()).status).toBe('ok');
});
