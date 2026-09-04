import { test } from '@playwright/test';
import { execSync } from 'node:child_process';

const WEBKIT_PROCS = [
  'Playwright.exe',
  'WebKitGPUProcess.exe',
  'WebKitNetworkProcess.exe',
  'WebKitWebProcess.exe',
];

test('webkit 残留プロセスの強制終了', async () => {
  if (process.platform !== 'win32') return;
  for (const name of WEBKIT_PROCS) {
    try {
      execSync(`taskkill /F /IM ${name}`, { stdio: 'ignore' });
    } catch {
      // 対象プロセスが存在しない場合は無視
    }
  }
});
