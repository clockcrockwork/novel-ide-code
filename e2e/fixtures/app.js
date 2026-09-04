import { test as base } from '@playwright/test';
import { DB_NAME, DB_VERSION } from '../../src/lib/db.js';

export const test = base.extend({
  appPage: async ({ page, baseURL }, runFixture) => {
    await page.goto(baseURL);
    await runFixture(page);
  },
});

export { expect } from '@playwright/test';
export { DB_NAME, DB_VERSION };
