import { defineConfig } from '@playwright/test';

// One fixture process serves every spec: the Canvas service on 4318 and the OpenChamber pane harness on 4319.
// It reads the built dist/, so run this through `npm run test:browser`, which builds first.
export default defineConfig({
  testDir: 'test/browser', workers: 1, fullyParallel: false, timeout: 60_000, expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    channel: 'chrome', headless: true, viewport: { width: 1380, height: 1000 }, colorScheme: 'dark',
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --import tsx test/browser-fixture.ts', url: 'http://127.0.0.1:4319/health',
    reuseExistingServer: false, timeout: 60_000, stdout: 'pipe', stderr: 'pipe',
    // SIGTERM lets the fixture stop the service and bridge and delete its temp data.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
