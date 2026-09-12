import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('original desktop and mobile UI renders without page errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '主播监控' })).toBeVisible();
  await expect(page.getByText('端到端测试主播')).toBeVisible();
  await mkdir('hybrid/results/screenshots', { recursive: true });
  await page.screenshot({ path: 'hybrid/results/screenshots/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: '主播监控' })).toBeVisible();
  await page.screenshot({ path: 'hybrid/results/screenshots/mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
