import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '../tests/e2e', timeout: 45000, fullyParallel: false, workers: 1,
  reporter: [['list'], ['json', { outputFile: 'hybrid/results/playwright.json' }]],
  use: { baseURL: 'http://127.0.0.1:4313', trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  webServer: { cwd: fileURLToPath(new URL('..', import.meta.url)), command: 'node hybrid/e2e-server.mjs', url: 'http://127.0.0.1:4313/healthz', reuseExistingServer: false, timeout: 45000 }
});
