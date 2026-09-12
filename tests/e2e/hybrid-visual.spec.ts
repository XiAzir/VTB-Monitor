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

test('original admin controls and responsive Pi panel are retained', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/admin');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('E2E-Review-2026!');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: '后台管理', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '审核周表识别' })).toBeVisible();
  await expect(page.getByText('Pi Provider', { exact: true })).toBeVisible();
  await mkdir('hybrid/results/screenshots', { recursive: true });
  await page.screenshot({ path: 'hybrid/results/screenshots/admin-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: '后台管理', exact: true })).toBeVisible();
  await page.screenshot({ path: 'hybrid/results/screenshots/admin-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
