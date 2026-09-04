import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncRequestError } from './syncErrors';

vi.mock('./workerClient', () => ({
  workerFetch: vi.fn(),
  workerFetchWithCSRF: vi.fn(),
}));

import { workerFetch, workerFetchWithCSRF } from './workerClient';
import { getUser, commitFile, createPR, mergePR } from './github';

function okJson(body) {
  return { ok: true, status: 200, json: async () => body, headers: new Headers() };
}

function errJson(status, body, headers = new Headers()) {
  return { ok: false, status, json: async () => body, headers };
}

// テスト間の mock 状態をリセットする。it.each で複数ケースを回す際に、前ケースの
// mockResolvedValue/呼び出し履歴が次ケースへ漏れないようにする。
beforeEach(() => {
  vi.clearAllMocks();
});

// 変更系（PUT/POST）は CSRF token 付き workerFetchWithCSRF を使う（Finding M1）。
// 読み取り系（GET）は CSRF 不要な workerFetch のまま（getUser を対照として1件だけ残す。
// 他の GET 関数（listRepos/getRepo/getContents/getFileContent/listBranches/listPRs）は
// 同じ `workerFetch(...)` 呼び出しパターンで、getUser と重複するため個別テストは持たない）。
describe('github.js — CSRF 適用境界（Finding M1）', () => {
  it('commitFile（contents PUT）は workerFetchWithCSRF を使う', async () => {
    workerFetchWithCSRF.mockResolvedValue(okJson({ content: { sha: 'new-sha' } }));

    await commitFile('owner', 'repo', 'works/chapter1.md', 'msg', 'content', null, 'main');

    expect(workerFetchWithCSRF).toHaveBeenCalledOnce();
    expect(workerFetch).not.toHaveBeenCalled();
    const [path, opts] = workerFetchWithCSRF.mock.calls[0];
    expect(path).toBe('/github/repos/owner/repo/contents/works/chapter1.md');
    expect(opts.method).toBe('PUT');
  });

  it('createPR（pulls POST）は workerFetchWithCSRF を使う', async () => {
    workerFetchWithCSRF.mockResolvedValue(okJson({ number: 1 }));

    await createPR('owner', 'repo', { title: 't', head: 'feature', base: 'main' });

    expect(workerFetchWithCSRF).toHaveBeenCalledOnce();
    expect(workerFetch).not.toHaveBeenCalled();
    const [path, opts] = workerFetchWithCSRF.mock.calls[0];
    expect(path).toBe('/github/repos/owner/repo/pulls');
    expect(opts.method).toBe('POST');
  });

  it('mergePR（merge PUT）は workerFetchWithCSRF を使う', async () => {
    workerFetchWithCSRF.mockResolvedValue(okJson({ merged: true }));

    await mergePR('owner', 'repo', 42);

    expect(workerFetchWithCSRF).toHaveBeenCalledOnce();
    expect(workerFetch).not.toHaveBeenCalled();
    const [path, opts] = workerFetchWithCSRF.mock.calls[0];
    expect(path).toBe('/github/repos/owner/repo/pulls/42/merge');
    expect(opts.method).toBe('PUT');
  });

  it('getUser（GET）は workerFetch のまま（CSRF 不要）', async () => {
    workerFetch.mockResolvedValue(okJson({ login: 'testuser' }));

    await getUser();

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(workerFetchWithCSRF).not.toHaveBeenCalled();
  });

  // workerFetchWithCSRF へ切替した結果、新たに生まれた失敗経路: CSRF token 取得自体が
  // 失敗した場合（worker/src/lib/workerClient.js の getCSRFToken() が /auth/csrf-token の
  // 応答不良で null を返す）、workerFetchWithCSRF は実際の PUT/POST を送信する前に
  // SyncRequestError を throw する。commitFile がその throw を握り潰さず、かつ
  // workerFetch へのフォールバックもしないことを固定する（切替前は workerFetch 使用のため
  // この失敗経路自体が存在しなかった＝未テストのまま）。
  it('CSRF token 取得失敗（/auth/csrf-token 障害）時、commitFile は送信前に throw する', async () => {
    const csrfFailure = new SyncRequestError('server', { operation: 'acquire csrf token' });
    workerFetchWithCSRF.mockRejectedValue(csrfFailure);

    await expect(
      commitFile('owner', 'repo', 'works/chapter1.md', 'msg', 'content', null, 'main'),
    ).rejects.toBe(csrfFailure);

    expect(workerFetch).not.toHaveBeenCalled();
  });
});

// parseError（github.js 内部）の 403 分岐: CSRF 専用文言と汎用文言の切り分け（F-3）。
// parseError 自体は export されていないため、workerFetchWithCSRF の応答経由で
// commitFile に間接的に発火させ、throw されるメッセージで観測する。
describe('github.js — parseError の CSRF 専用文言判定', () => {
  it.each([
    ['csrf token missing', 'セッション情報の更新が必要です。ページを再読み込みしてください。'],
    ['csrf token invalid', 'セッション情報の更新が必要です。ページを再読み込みしてください。'],
  ])('403 + body.error=%s は CSRF 専用文言を throw する', async (bodyError, expectedMessage) => {
    workerFetchWithCSRF.mockResolvedValue(errJson(403, { error: bodyError }));

    await expect(
      commitFile('owner', 'repo', 'works/chapter1.md', 'msg', 'content', null, 'main'),
    ).rejects.toThrow(expectedMessage);
  });

  it.each([
    [{ message: 'Forbidden' }, undefined],
    [{}, undefined],
    [{ message: 'insufficient scope' }, '0'],
  ])('403 + 他 body（%o、X-RateLimit-Remaining=%s）は CSRF 専用文言にならない', async (body, rateLimitRemaining) => {
    const headers = new Headers();
    if (rateLimitRemaining !== undefined) headers.set('X-RateLimit-Remaining', rateLimitRemaining);
    workerFetchWithCSRF.mockResolvedValue(errJson(403, body, headers));

    await expect(
      commitFile('owner', 'repo', 'works/chapter1.md', 'msg', 'content', null, 'main'),
    ).rejects.not.toThrow('セッション情報の更新が必要です。ページを再読み込みしてください。');
  });
});
