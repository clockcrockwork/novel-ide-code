import { createRequire } from 'node:module';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);
const vercelConfig = require('./vercel.json');

const PREVIEW_SKIP = new Set(['Strict-Transport-Security']);
const headersList = vercelConfig?.headers?.[0]?.headers;
if (!headersList) {
  throw new Error('vercel.json の headers 構造が不正です。セキュリティヘッダーを適用できません。');
}
const previewHeaders = Object.fromEntries(
  headersList.filter(({ key }) => !PREVIEW_SKIP.has(key)).map(({ key, value }) => [key, value]),
);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.js'],
    exclude: [
      ...configDefaults.exclude,
      'worker/**',
      'tests/**/*.test.js',
      'e2e/**',
      '**/.claude/**',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['**/*.test.js', '**/*.test.jsx', 'src/__tests__/**', '**/.claude/**'],
      reporter: ['text', 'html'],
    },
  },
  server: {
    proxy: {
      '/auth': 'http://localhost:8787',
      '/github': 'http://localhost:8787',
      '/sync': 'http://localhost:8787',
    },
  },
  preview: {
    headers: previewHeaders,
  },
});
