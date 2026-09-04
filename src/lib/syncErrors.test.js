import { describe, it, expect, vi } from 'vitest';
import {
  SYNC_ERROR_CODES,
  SyncRequestError,
  categorizeSyncFailure,
  pickPrimaryCategory,
  readSyncFailure,
  syncFailureMessage,
} from './syncErrors';

describe('categorizeSyncFailure — code は status と整合するときだけ信頼する', () => {
  it.each([
    [SYNC_ERROR_CODES.conflict, 409, 'conflict'],
    [SYNC_ERROR_CODES.unprocessable, 422, 'unprocessable'],
    [SYNC_ERROR_CODES.forbidden, 403, 'forbidden'],
    [SYNC_ERROR_CODES.repoMissing, 404, 'not_found'],
    [SYNC_ERROR_CODES.manifestMissing, 404, 'not_found'],
    [SYNC_ERROR_CODES.contentMissing, 404, 'not_found'],
    [SYNC_ERROR_CODES.workspaceInconsistent, 404, 'workspace_inconsistent'],
    [SYNC_ERROR_CODES.remoteCorrupt, 502, 'corrupt'],
    [SYNC_ERROR_CODES.upstream, 502, 'upstream'],
    [SYNC_ERROR_CODES.server, 500, 'server'],
  ])('code %s（status %d）は %s に分類する', (code, status, expected) => {
    expect(categorizeSyncFailure(status, code)).toBe(expected);
  });

  // 応答本文だけを書き換えられる中間層が、HTTP 500 に sync_conflict を載せるだけで
  // 「再同期すれば直る」と誤誘導できてしまう経路を塞ぐ。整合しなければ code を捨てる。
  it.each([
    [500, SYNC_ERROR_CODES.conflict, 'server'],
    [403, SYNC_ERROR_CODES.conflict, 'forbidden'],
    [502, SYNC_ERROR_CODES.manifestMissing, 'upstream'],
    [200, SYNC_ERROR_CODES.conflict, 'server'],
  ])('status %d に不整合な code %s は無視して status で分類する', (status, code, expected) => {
    expect(categorizeSyncFailure(status, code)).toBe(expected);
  });
});

describe('categorizeSyncFailure — status フォールバック', () => {
  it.each([
    [401, 'auth'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'unprocessable'],
    [502, 'upstream'],
    [503, 'upstream'],
    [504, 'upstream'],
    [429, 'upstream'],
    [400, 'internal'],
    [413, 'too_large'],
    [500, 'server'],
  ])('code 不在なら status %d は %s', (status, expected) => {
    expect(categorizeSyncFailure(status, null)).toBe(expected);
  });

  it('409 と 422 を同一視しない', () => {
    expect(categorizeSyncFailure(409, null)).not.toBe(categorizeSyncFailure(422, null));
  });

  it.each([
    ['sync_conflict ', '近傍: 末尾空白'],
    ['SYNC_CONFLICT', '近傍: 大文字'],
    ['sync_conflict_x', '近傍: 接尾辞'],
    ['conflict', '近傍: 接頭辞なし'],
  ])('未知 code (%s) は code 一致とみなさず status へ落とす（%s）', (code) => {
    expect(categorizeSyncFailure(500, code)).toBe('server');
    expect(categorizeSyncFailure(409, code)).toBe('conflict');
  });

  // JSON の重複キーは後勝ちで解釈される。既存 code を消さず追記するだけの改変でも
  // 分類を乗っ取れないこと（status との整合を要求しているため）。
  it('重複キーで後勝ちした code も status と整合しなければ効かない', async () => {
    const res = {
      status: 500,
      json: () => Promise.resolve(JSON.parse('{"code":"zzz","code":"sync_conflict"}')),
    };

    expect((await readSyncFailure(res)).category).toBe('server');
  });

  it.each([[undefined], [null], ['']])('code が %s でも status で分類できる', (code) => {
    expect(categorizeSyncFailure(409, code)).toBe('conflict');
  });
});

describe('pickPrimaryCategory', () => {
  it('競合を最優先で代表にする', () => {
    expect(pickPrimaryCategory(['upstream', 'conflict', 'server'])).toBe('conflict');
  });

  it('競合がなければ優先順の上位を採る', () => {
    expect(pickPrimaryCategory(['server', 'forbidden'])).toBe('forbidden');
  });

  it('空配列では null', () => {
    expect(pickPrimaryCategory([])).toBeNull();
  });

  it('未知 category しかなければ先頭を返す', () => {
    expect(pickPrimaryCategory(['未知'])).toBe('未知');
  });
});

describe('syncFailureMessage', () => {
  it('category ごとに異なる文言を返す', () => {
    const messages = ['conflict', 'unprocessable', 'forbidden', 'upstream', 'server'].map(
      syncFailureMessage,
    );
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('未知 category は server 相当へフォールバックする', () => {
    expect(syncFailureMessage('未知')).toBe(syncFailureMessage('server'));
  });
});

describe('readSyncFailure', () => {
  it('code を読み取り typed error にする', async () => {
    const res = { status: 409, json: () => Promise.resolve({ code: SYNC_ERROR_CODES.conflict }) };

    const err = await readSyncFailure(res, 'push manifest');

    expect(err).toBeInstanceOf(SyncRequestError);
    expect(err.category).toBe('conflict');
    expect(err.code).toBe(SYNC_ERROR_CODES.conflict);
    expect(err.status).toBe(409);
    expect(err.operation).toBe('push manifest');
  });

  it('本文が JSON でなくても status で分類する', async () => {
    const res = { status: 409, json: () => Promise.reject(new Error('not json')) };

    const err = await readSyncFailure(res);

    expect(err.category).toBe('conflict');
    expect(err.code).toBeNull();
  });

  it('code が文字列でない場合は無視して status へ落とす', async () => {
    const res = { status: 422, json: () => Promise.resolve({ code: { evil: true } }) };

    const err = await readSyncFailure(res);

    expect(err.code).toBeNull();
    expect(err.category).toBe('unprocessable');
  });

  // worker の応答本文を表示へ転用しない。sync route 以外のミドルウェア応答
  // （unauthorized / session expired / csrf token invalid 等の内部英語文字列）も
  // 同じ fetch 経路を通るため、本文を載せると日本語 UI にそれらが露出する。
  it.each([['csrf token invalid'], ['unauthorized'], ['session expired']])(
    'worker の応答本文（%s）を表示文言に使わない',
    async (workerText) => {
      const res = { status: 403, json: () => Promise.resolve({ error: workerText }) };

      const err = await readSyncFailure(res);

      expect(err.message).not.toContain(workerText);
      expect(err.message).toBe(syncFailureMessage('forbidden'));
    },
  );

  it('code つきでも本文の文言は採用しない', async () => {
    const res = {
      status: 409,
      json: () => Promise.resolve({ code: SYNC_ERROR_CODES.conflict, error: 'worker 側の文言' }),
    };

    expect((await readSyncFailure(res)).message).toBe(syncFailureMessage('conflict'));
  });
});

describe('categorizeThrown', () => {
  it('SyncRequestError はその category を保つ', async () => {
    const { SyncRequestError: E, categorizeThrown } = await import('./syncErrors');
    expect(categorizeThrown(new E('conflict'))).toBe('conflict');
  });

  // fetch の拒否は workerClient の境界で SyncRequestError('network') に型付けされる。
  it('境界で型付けされた fetch 拒否は network を保つ', async () => {
    const { SyncRequestError: E, categorizeThrown } = await import('./syncErrors');
    expect(categorizeThrown(new E('network'))).toBe('network');
  });

  // TypeError を network の判定条件にすると、HTTP 200 で null が返る等の応答形状不正まで
  // 「通信エラー」として表示・集計され、remote / client の破損が誰にも気づかれない。
  it.each([
    [new TypeError("Cannot read properties of null (reading 'files')")],
    [new SyntaxError('Unexpected token')],
    [new Error('idb write failed')],
  ])('typed でない失敗は TypeError を含めて internal', async (thrown) => {
    const { categorizeThrown } = await import('./syncErrors');
    expect(categorizeThrown(thrown)).toBe('internal');
  });
});

// fetch の拒否だけを network として型付けする境界（workerClient）。ここで包まないと
// categorizeThrown 側で TypeError を network 判定に使うことになり、応答形状の不正まで
// 「通信エラー」に紛れる（#608）。
describe('workerFetch の network 型付け境界', () => {
  it('fetch の拒否は SyncRequestError(network) になる', async () => {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const { workerFetch } = await import('./workerClient');

    await expect(workerFetch('/sync/manifest')).rejects.toMatchObject({
      name: 'SyncRequestError',
      category: 'network',
    });
    vi.unstubAllGlobals();
  });

  // csrf token invalid 後の再送だけが境界を通っていないと、オフラインでの再送拒否が
  // 生の TypeError になり「安全のため同期を中止しました（整合性チェック）」と案内される。
  it('csrf 再送の fetch 拒否も network になる', async () => {
    vi.resetModules();
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url) => {
        if (String(url).includes('/auth/csrf-token'))
          return Promise.resolve({
            status: 200,
            ok: true,
            json: () => Promise.resolve({ csrfToken: `t${(call += 1)}`, expiresIn: 3600 }),
          });
        // 1 回目の書き込みは csrf token invalid、再送は通信断。
        if (call === 1)
          return Promise.resolve({
            status: 403,
            ok: false,
            clone: () => ({ json: () => Promise.resolve({ error: 'csrf token invalid' }) }),
            json: () => Promise.resolve({ error: 'csrf token invalid' }),
          });
        return Promise.reject(new TypeError('Failed to fetch'));
      }),
    );
    const { workerFetchWithCSRF } = await import('./workerClient');

    await expect(workerFetchWithCSRF('/sync/manifest', { method: 'PUT' })).rejects.toMatchObject({
      name: 'SyncRequestError',
      category: 'network',
    });
    vi.unstubAllGlobals();
  });

  it('応答が返れば（形状が不正でも）network にしない', async () => {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(null) })),
    );
    const { workerFetch } = await import('./workerClient');

    await expect(workerFetch('/sync/manifest')).resolves.toMatchObject({ status: 200 });
    vi.unstubAllGlobals();
  });
});

// CSRF トークン取得の失敗が「整合性チェックのため中止」に潰れると、通信障害・
// セッション失効・サーバー障害の区別が利用者にも運用にも届かない（#608）。
describe('CSRF トークン取得失敗の category', () => {
  it.each([
    [401, 'auth'],
    [500, 'server'],
    [502, 'upstream'],
  ])('status %d は %s に分類する', async (status, expected) => {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ status, ok: false, json: () => Promise.resolve({}) })),
    );
    const { workerFetchWithCSRF } = await import('./workerClient');

    await expect(workerFetchWithCSRF('/sync/manifest', { method: 'PUT' })).rejects.toMatchObject({
      category: expected,
    });
    vi.unstubAllGlobals();
  });

  // fetch は成功しているのに応答が解析できない場合まで network にすると、
  // worker / 中間層の応答不正を「通信に失敗しました」と誤案内する。
  it.each([
    ['非 JSON', () => Promise.reject(new SyntaxError('Unexpected token'))],
    ['csrfToken 欠落', () => Promise.resolve({})],
    ['csrfToken が非文字列', () => Promise.resolve({ csrfToken: 123 })],
  ])('HTTP 200 の応答不正（%s）は server に分類する', async (_label, json) => {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ status: 200, ok: true, json })),
    );
    const { workerFetchWithCSRF } = await import('./workerClient');

    await expect(workerFetchWithCSRF('/sync/manifest', { method: 'PUT' })).rejects.toMatchObject({
      category: 'server',
    });
    vi.unstubAllGlobals();
  });

  it('fetch 自体が投げたら network に分類する', async () => {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const { workerFetchWithCSRF } = await import('./workerClient');

    await expect(workerFetchWithCSRF('/sync/manifest', { method: 'PUT' })).rejects.toMatchObject({
      category: 'network',
    });
    vi.unstubAllGlobals();
  });

  // 送信済みトークンが csrf token invalid になった後の再取得が失敗したとき、元の 403 を
  // そのまま返すと同期側は forbidden（権限・アクセス制限）と誤案内する。
  it('再取得の失敗も記録済み category で投げる', async () => {
    vi.resetModules();
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url) => {
        if (String(url).includes('/auth/csrf-token')) {
          call += 1;
          // 1 回目は成功（トークン取得）、2 回目（再取得）は通信断
          if (call === 1)
            return Promise.resolve({
              status: 200,
              ok: true,
              json: () => Promise.resolve({ csrfToken: 't', expiresIn: 3600 }),
            });
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        // 書き込みは csrf token invalid の 403 を返す
        return Promise.resolve({
          status: 403,
          ok: false,
          clone: () => ({ json: () => Promise.resolve({ error: 'csrf token invalid' }) }),
          json: () => Promise.resolve({ error: 'csrf token invalid' }),
        });
      }),
    );
    const { workerFetchWithCSRF } = await import('./workerClient');

    await expect(workerFetchWithCSRF('/sync/manifest', { method: 'PUT' })).rejects.toMatchObject({
      category: 'network',
    });
    vi.unstubAllGlobals();
  });
});
