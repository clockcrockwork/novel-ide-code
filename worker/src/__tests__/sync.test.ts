import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appFetch,
  decodeGitHubContent,
  encodeGitHubContent,
  env,
  jsonResponse,
  mockFetch,
  seedCSRF,
  seedSession,
} from './test-utils';

const sessionToken = 'sess-sync';
const csrfToken = 'd9defb89-d280-4c1c-83bf-c4958709f828';
const cookies = { 'novel-ide-session': sessionToken };
const csrfHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };

beforeEach(async () => {
  await seedSession(sessionToken);
  await seedCSRF(sessionToken, csrfToken);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockGitHubByPath(routes: Record<string, Response>) {
  return mockFetch((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = ((input instanceof Request ? input.method : init?.method) ?? 'GET').toUpperCase();
    const path = new URL(url).pathname;
    return (
      routes[`${method} ${path}`] ??
      routes[path] ??
      jsonResponse({ message: `unexpected ${method} ${path}` }, { status: 500 })
    );
  });
}

describe('/sync/manifest', () => {
  it('manifest 成功時は _sha と _branch を付けて返す', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ default_branch: 'main' }),
      '/repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent({ version: 2, title: '日本語', files: {} }),
        sha: 'manifest-sha',
      }),
    });

    const res = await appFetch('/sync/manifest', {}, cookies);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      version: 2,
      title: '日本語',
      files: {},
      _sha: 'manifest-sha',
      _branch: 'main',
    });
  });

  it('PUT は _branch 必須で、欠落時は GitHub に転送しない', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));

    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ files: {} }),
    }, cookies);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid _branch' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PUT は _sha と _branch を保存 content から除外する', async () => {
    // capability チェックが書き込み前に manifest を独立に読み直す（#609）。既存 manifest を
    // 検査可能な v2 として返し、その読み取りが通常の書き込みを妨げないことも同時に確認する。
    // 404（存在しない）ではなく version 2 の既存 manifest を返す: request が非 null の
    // _sha（既存更新のつもり）を送るのに GET が 404 を返すのは矛盾したシグナルとして
    // fail-closed で拒否されるため（別テストで検証）、ここでは整合するレスポンスにする。
    const fetchMock = mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent({ version: 2, files: {} }),
        sha: 'old-sha',
      }),
      'PUT /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: { sha: 'new-manifest-sha' },
      }),
    });

    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _sha: 'old-sha', _branch: 'main', files: {}, title: '日本語' }),
    }, cookies);
    const responseBody = await res.json() as { sha: string };
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    const requestBody = JSON.parse(putCall?.[1]?.body as string) as Record<string, string>;
    const content = decodeGitHubContent(requestBody.content);

    expect(res.status).toBe(200);
    expect(responseBody.sha).toBe('new-manifest-sha');
    expect(requestBody).toMatchObject({
      message: 'sync: update manifest',
      branch: 'main',
      sha: 'old-sha',
    });
    expect(content).toEqual({ files: {}, title: '日本語' });
  });

  it('GitHub 5xx は upstream 障害として返す（404 に潰さない）', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ message: 'down' }, { status: 500 }),
    });

    const res = await appFetch('/sync/manifest', {}, cookies);

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'sync_upstream_error' });
  });
});

describe('/sync/file/:id', () => {
  it('GET は UTF-8 JSON content を壊さず decode する', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide/contents/files/novel-1.json': jsonResponse({
        content: encodeGitHubContent({ name: '第一話', body: '本文です' }),
        sha: 'file-sha',
      }),
    });

    const res = await appFetch('/sync/file/novel-1', {}, cookies);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({ name: '第一話', body: '本文です', _sha: 'file-sha' });
  });

  // legacy entry（sha フィールドを持たない旧 manifest）: worker は client の _sha を素通し
  // せず、entry 無しと同じ create-only 経路（実在確認）に倒す（#609 round2 F1。反転済み。
  // 素通し時に実在確認をすり抜けられる問題があった）。
  it('legacy entry（sha 無し）は create-only 経路に倒す（実在すれば 409 orphan）', async () => {
    const fetchMock = mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent({ version: 2, files: { 'novel-1': { id: 'novel-1', name: '旧題' } } }),
        sha: 'manifest-sha',
      }),
      'GET /repos/testuser/.novel-ide/contents/files/novel-1.json': jsonResponse({
        content: encodeGitHubContent({ name: '他端末の本文' }),
        sha: 'their-sha',
      }),
    });

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({
        _sha: 'old-file-sha', _manifestSha: 'manifest-sha', _branch: 'main',
        name: '第一話', body: '本文です',
      }),
    }, cookies);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'sync_entity_orphan' });
    const putCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });

  it('legacy entry（sha 無し）で entity が不在なら sha なしで create する', async () => {
    const fetchMock = mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent({ version: 2, files: { 'novel-1': { id: 'novel-1', name: '旧題' } } }),
        sha: 'manifest-sha',
      }),
      'GET /repos/testuser/.novel-ide/contents/files/novel-1.json': jsonResponse({}, { status: 404 }),
      'PUT /repos/testuser/.novel-ide/contents/files/novel-1.json': jsonResponse({
        content: { sha: 'new-file-sha' },
      }),
    });

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({
        _sha: 'old-file-sha', _manifestSha: 'manifest-sha', _branch: 'main',
        name: '第一話', body: '本文です',
      }),
    }, cookies);
    const responseBody = await res.json() as { sha: string };
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    const requestBody = JSON.parse(putCall?.[1]?.body as string) as Record<string, string>;

    expect(res.status).toBe(200);
    expect(responseBody.sha).toBe('new-file-sha');
    // legacy entry でも client の _sha は使わず create-only（sha 無し）で書く。
    expect(requestBody.sha).toBeUndefined();
  });
});

// ── entity write の世代拘束（#609 A-2） ────────────────────────────────────────
// docs/data-model/sync-contract.md「entity write の世代拘束と reconcile」を正本とする。
describe('PUT /sync/file/:id の世代拘束（#609 A-2）', () => {
  const baseBody = { _branch: 'main', name: 'novel-1', body: 'x' };

  function mockManifestAndFile(manifestContent: object | null, fileExisting: Response | null) {
    return mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json':
        manifestContent === null
          ? jsonResponse({}, { status: 404 })
          : jsonResponse({ content: encodeGitHubContent(manifestContent), sha: 'manifest-sha' }),
      ...(fileExisting
        ? { 'GET /repos/testuser/.novel-ide/contents/files/novel-1.json': fileExisting }
        : {}),
      'PUT /repos/testuser/.novel-ide/contents/files/novel-1.json': jsonResponse({
        content: { sha: 'written-sha' },
      }),
    });
  }

  it('_manifestSha が無ければ 426 sync_manifest_ref_required を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({}, { status: 500 }));

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders, body: JSON.stringify(baseBody),
    }, cookies);

    expect(res.status).toBe(426);
    expect(await res.json()).toMatchObject({ code: 'sync_manifest_ref_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('_manifestSha が空文字なら 426 を返す', async () => {
    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders, body: JSON.stringify({ ...baseBody, _manifestSha: '' }),
    }, cookies);

    expect(res.status).toBe(426);
  });

  it('manifest が不在なら entity を書かず 404 manifest missing を返す（fail-closed）', async () => {
    const fetchMock = mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({}, { status: 404 }),
    });

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ ...baseBody, _manifestSha: 'manifest-sha', _sha: null }),
    }, cookies);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'sync_manifest_missing' });
    const putCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });

  it('manifest の sha が _manifestSha と不一致なら 409 sync_manifest_stale を返す', async () => {
    const fetchMock = mockManifestAndFile({ version: 2, files: {} }, null);

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ ...baseBody, _manifestSha: 'stale-sha', _sha: null }),
    }, cookies);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'sync_manifest_stale' });
    const putCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });

  it('remote manifest が v3・capability 未宣言なら 426 で拒否する', async () => {
    mockManifestAndFile({ version: 3, files: {} }, null);

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ ...baseBody, _manifestSha: 'manifest-sha', _sha: null }),
    }, cookies);

    expect(res.status).toBe(426);
    expect(await res.json()).toMatchObject({ code: 'sync_protocol_upgrade_required' });
  });

  // #394 C-0: entity write でも capability header を送れば v3 remote への書き込みが
  // 通ること（GitHub PUT まで到達すること）を固定する。header 未宣言の上のテストと対。
  it('remote manifest が v3・capability 宣言（3）があれば許可し、GitHub への PUT まで到達する', async () => {
    const fetchMock = mockManifestAndFile({ version: 3, files: {} }, jsonResponse({}, { status: 404 }));

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT',
      headers: { ...csrfHeaders, 'X-Novel-Ide-Format-Version': '3' },
      body: JSON.stringify({ ...baseBody, _manifestSha: 'manifest-sha', _sha: null }),
    }, cookies);

    expect(res.status).toBe(200);
    const putCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(1);
  });

  // remote が既知安全域（v2）のままなら、capability header が非数値でも
  // LEGACY_DEFAULT_FORMAT_VERSION(2) として扱われ拒否しない（回帰防止）。
  it('remote manifest が v2・capability header が非数値なら legacy default(2) として許可する', async () => {
    mockManifestAndFile({ version: 2, files: {} }, jsonResponse({}, { status: 404 }));

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT',
      headers: { ...csrfHeaders, 'X-Novel-Ide-Format-Version': 'not-a-number' },
      body: JSON.stringify({ ...baseBody, _manifestSha: 'manifest-sha', _sha: null }),
    }, cookies);

    expect(res.status).toBe(200);
  });

  it('entry.sha と _sha が不一致なら 409 sync_entity_stale を返す', async () => {
    const fetchMock = mockManifestAndFile(
      { version: 2, files: { 'novel-1': { id: 'novel-1', sha: 'entry-sha' } } }, null,
    );

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ ...baseBody, _manifestSha: 'manifest-sha', _sha: 'wrong-sha' }),
    }, cookies);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'sync_entity_stale' });
    const putCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });

  it('entry.sha と _sha が一致すれば CAS で書き込める', async () => {
    const fetchMock = mockManifestAndFile(
      { version: 2, files: { 'novel-1': { id: 'novel-1', sha: 'entry-sha' } } }, null,
    );

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ ...baseBody, _manifestSha: 'manifest-sha', _sha: 'entry-sha' }),
    }, cookies);

    expect(res.status).toBe(200);
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    const requestBody = JSON.parse(putCall?.[1]?.body as string) as Record<string, string>;
    expect(requestBody.sha).toBe('entry-sha');
  });

  it('entry が無く entity も不在なら create-only で書き込む（sha null）', async () => {
    const fetchMock = mockManifestAndFile(
      { version: 2, files: {} },
      jsonResponse({}, { status: 404 }),
    );

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ ...baseBody, _manifestSha: 'manifest-sha', _sha: null }),
    }, cookies);

    expect(res.status).toBe(200);
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    const requestBody = JSON.parse(putCall?.[1]?.body as string) as Record<string, string>;
    expect(requestBody.sha).toBeUndefined();
  });

  it('entry が無く entity が実在すれば 409 sync_entity_orphan を返す（無条件では上書きしない）', async () => {
    const fetchMock = mockManifestAndFile(
      { version: 2, files: {} },
      jsonResponse({ content: encodeGitHubContent({ name: 'theirs' }), sha: 'their-sha' }),
    );

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ ...baseBody, _manifestSha: 'manifest-sha', _sha: null }),
    }, cookies);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'sync_entity_orphan' });
    const putCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });

  // 不在確認と create の間に別端末が同じ id を作った場合、GitHub は create-only 違反を
  // 422 で返す。orphan へ読み替える（不在確認だけでは防げない窓）。
  it('entry が無く create PUT が 422 で失敗したら 409 sync_entity_orphan に読み替える', async () => {
    const fetchMock = mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent({ version: 2, files: {} }),
        sha: 'manifest-sha',
      }),
      'GET /repos/testuser/.novel-ide/contents/files/novel-1.json': jsonResponse({}, { status: 404 }),
      'PUT /repos/testuser/.novel-ide/contents/files/novel-1.json': jsonResponse(
        { message: 'Invalid request' }, { status: 422 },
      ),
    });

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ ...baseBody, _manifestSha: 'manifest-sha', _sha: null }),
    }, cookies);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'sync_entity_orphan' });
    expect(fetchMock).toHaveBeenCalled();
  });

  // #609 round3 L3: create-only write の GitHub 409 も 422 と同じく orphan へ読み替える
  // （CAS 側の 409/422 → entity_stale と対称にする）。
  it('entry が無く create PUT が 409 で失敗したら 409 sync_entity_orphan に読み替える', async () => {
    const fetchMock = mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent({ version: 2, files: {} }),
        sha: 'manifest-sha',
      }),
      'GET /repos/testuser/.novel-ide/contents/files/novel-1.json': jsonResponse({}, { status: 404 }),
      'PUT /repos/testuser/.novel-ide/contents/files/novel-1.json': jsonResponse(
        { message: 'is at abc but expected def' }, { status: 409 },
      ),
    });

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ ...baseBody, _manifestSha: 'manifest-sha', _sha: null }),
    }, cookies);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'sync_entity_orphan' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('_reconcile: true なら entry の有無に関わらず _sha で CAS write する', async () => {
    const fetchMock = mockManifestAndFile({ version: 2, files: {} }, null);

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({
        ...baseBody, _manifestSha: 'manifest-sha', _sha: 'live-sha', _reconcile: true,
      }),
    }, cookies);

    expect(res.status).toBe(200);
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    const requestBody = JSON.parse(putCall?.[1]?.body as string) as Record<string, string>;
    expect(requestBody.sha).toBe('live-sha');
  });

  it('_reconcile: true で _sha が無ければ 400 を返す', async () => {
    const fetchMock = mockManifestAndFile({ version: 2, files: {} }, null);

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ ...baseBody, _manifestSha: 'manifest-sha', _reconcile: true }),
    }, cookies);

    expect(res.status).toBe(400);
    const putCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });

  // #609 round2 F2: files をプレーンオブジェクトで素朴に索引すると、id が
  // __proto__ / constructor 等のときプロトタイプチェーン経由で継承値が返り、
  // 「entry が存在する」と誤判定して実在確認をすり抜けてしまう。
  it('id が __proto__ で files が空でも own property のみを entry とみなし実在確認する', async () => {
    const fetchMock = mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent({ version: 2, files: {} }),
        sha: 'manifest-sha',
      }),
      'GET /repos/testuser/.novel-ide/contents/files/__proto__.json': jsonResponse({
        content: encodeGitHubContent({ name: 'theirs' }), sha: 'their-sha',
      }),
    });

    const res = await appFetch('/sync/file/__proto__', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ ...baseBody, _manifestSha: 'manifest-sha', _sha: null }),
    }, cookies);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'sync_entity_orphan' });
    const putCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
    // 実在確認 GET が files/__proto__.json に対して行われたこと（誤判定で素通りしていない）。
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/contents/files/__proto__.json'),
      expect.anything(),
    );
  });

  // #609 round2 F3: sha 付きの CAS write が GitHub の 409/422 で拒否された場合、汎用の
  // sync_conflict / sync_unprocessable のままだと client の reconcile 判定に乗らない。
  it('entry.sha と _sha が一致していても GitHub 409（CAS 不一致）は sync_entity_stale に読み替える', async () => {
    const fetchMock = mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent(
          { version: 2, files: { 'novel-1': { id: 'novel-1', sha: 'entry-sha' } } },
        ),
        sha: 'manifest-sha',
      }),
      'PUT /repos/testuser/.novel-ide/contents/files/novel-1.json': jsonResponse(
        { message: 'sha mismatch' }, { status: 409 },
      ),
    });

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ ...baseBody, _manifestSha: 'manifest-sha', _sha: 'entry-sha' }),
    }, cookies);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'sync_entity_stale' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('entry.sha と _sha が一致していても GitHub 422（blob 消失等）は sync_entity_stale に読み替える', async () => {
    mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent(
          { version: 2, files: { 'novel-1': { id: 'novel-1', sha: 'entry-sha' } } },
        ),
        sha: 'manifest-sha',
      }),
      'PUT /repos/testuser/.novel-ide/contents/files/novel-1.json': jsonResponse(
        { message: 'blob not found' }, { status: 422 },
      ),
    });

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ ...baseBody, _manifestSha: 'manifest-sha', _sha: 'entry-sha' }),
    }, cookies);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'sync_entity_stale' });
  });

  // #609 round2 F3: _reconcile: true は _sha: null も受理し create-only（sha なし PUT）で書く。
  it('_reconcile: true, _sha: null なら create-only（sha なし PUT）で書き込む', async () => {
    const fetchMock = mockManifestAndFile({ version: 2, files: {} }, null);

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({
        ...baseBody, _manifestSha: 'manifest-sha', _sha: null, _reconcile: true,
      }),
    }, cookies);

    expect(res.status).toBe(200);
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    const requestBody = JSON.parse(putCall?.[1]?.body as string) as Record<string, string>;
    expect(requestBody.sha).toBeUndefined();
  });

  it('_reconcile: true, _sha: null の create-only が GitHub 422 で失敗したら 409 sync_entity_orphan に読み替える', async () => {
    mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent({ version: 2, files: {} }),
        sha: 'manifest-sha',
      }),
      'PUT /repos/testuser/.novel-ide/contents/files/novel-1.json': jsonResponse(
        { message: 'already exists' }, { status: 422 },
      ),
    });

    const res = await appFetch('/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({
        ...baseBody, _manifestSha: 'manifest-sha', _sha: null, _reconcile: true,
      }),
    }, cookies);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'sync_entity_orphan' });
  });
});

describe('/sync/settings', () => {
  it('GET 成功時は _sha と _branch を付けて返す', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ default_branch: 'main' }),
      '/repos/testuser/.novel-ide/contents/settings.json': jsonResponse({
        content: encodeGitHubContent({ theme: 'dark', font: '明朝' }),
        sha: 'settings-sha',
      }),
    });

    const res = await appFetch('/sync/settings', {}, cookies);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      theme: 'dark',
      font: '明朝',
      _sha: 'settings-sha',
      _branch: 'main',
    });
  });

  it('PUT は _sha と _branch を保存 content から除外する', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new-settings-sha' } }));

    const res = await appFetch('/sync/settings', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _sha: 'old-settings-sha', _branch: 'main', theme: 'dark', font: '明朝' }),
    }, cookies);
    const responseBody = await res.json() as { sha: string };
    const [, init] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(init?.body as string) as Record<string, string>;
    const content = decodeGitHubContent(requestBody.content);

    expect(res.status).toBe(200);
    expect(responseBody.sha).toBe('new-settings-sha');
    expect(requestBody.message).toBe('sync: update settings');
    expect(requestBody.branch).toBe('main');
    expect(requestBody.sha).toBe('old-settings-sha');
    expect(content).toEqual({ theme: 'dark', font: '明朝' });
  });

  it('正当な githubRepoPath は保存できる', async () => {
    mockFetch(() => jsonResponse({ content: { sha: 'new-settings-sha' } }));
    const res = await appFetch('/sync/settings', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _sha: null, _branch: 'main', githubRepoPath: 'novels/series-a' }),
    }, cookies);
    expect(res.status).toBe(200);
  });

  it.each([
    ['a/package.json', 'サブディレクトリのパッケージ管理ファイル'],
    ['/etc', '先頭スラッシュ'],
    ['../foo', 'パストラバーサル'],
    ['a/.github', '機微セグメント'],
    ['a?b', 'URL メタ文字'],
  ])('不正な githubRepoPath (%s) は 400 で拒否する', async (badPath) => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'x' } }));
    const res = await appFetch('/sync/settings', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _sha: null, _branch: 'main', githubRepoPath: badPath }),
    }, cookies);
    expect(res.status).toBe(400);
    // 検証で弾かれるため GitHub への書き込みは発生しない（fail-closed）
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('branch バリデーション', () => {
  it('_branch に .. を含むと 400 を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: '../../etc/passwd', files: {} }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid _branch' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('_branch に // を含むと 400 を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'main//evil', files: {} }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid _branch' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('空文字の _branch は 400 を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: '', files: {} }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('有効なブランチ名（feature/my-branch）は通過する', async () => {
    const fetchMock = mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({}, { status: 404 }),
      'PUT /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: { sha: 'new-sha' },
      }),
    });
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'feature/my-branch', files: {} }),
    }, cookies);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('ファイル名バリデーション', () => {
  it('name が 256 文字超のファイルは 400 を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const longName = 'あ'.repeat(257);
    const res = await appFetch('/sync/file/valid-id-123', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'main', name: longName }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid name' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('null バイトを含む name は 400 を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/file/valid-id-123', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'main', name: 'evil\x00name' }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('name が未設定の場合は通過する（省略可能）', async () => {
    const fetchMock = mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent({ version: 2, files: {} }),
        sha: 'manifest-sha',
      }),
      'GET /repos/testuser/.novel-ide/contents/files/valid-id-123.json': jsonResponse({}, { status: 404 }),
      'PUT /repos/testuser/.novel-ide/contents/files/valid-id-123.json': jsonResponse({
        content: { sha: 'new-sha' },
      }),
    });
    const res = await appFetch('/sync/file/valid-id-123', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'main', _manifestSha: 'manifest-sha', content: 'hello' }),
    }, cookies);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('拡張ブランチバリデーション', () => {
  it('$ を含む有効なブランチ名は通過する', async () => {
    const fetchMock = mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({}, { status: 404 }),
      'PUT /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: { sha: 'new-sha' },
      }),
    });
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'hello-$USER', files: {} }),
    }, cookies);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('@ を含む有効なブランチ名は通過する', async () => {
    const fetchMock = mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({}, { status: 404 }),
      'PUT /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: { sha: 'new-sha' },
      }),
    });
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'feat@issue-123', files: {} }),
    }, cookies);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('先頭が . のブランチは 400 を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: '.hidden-branch', files: {} }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('末尾が . のブランチは 400 を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'branch-name.', files: {} }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('スペースを含むブランチは 400 を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'branch with spaces', files: {} }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ブランチ名バリデーション追加ケース', () => {
  it('@ 単独は 400 を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: '@', files: {} }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('コンポーネント末尾が . のブランチは 400 を返す（例: feature/foo.）', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'feature/foo.', files: {} }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('@{ を含むブランチは 400 を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'feat@{0}', files: {} }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('中間コンポーネントが . 終わりでも全体が . 終わりでなければ通過する（例: foo./bar）', async () => {
    mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        sha: 'old-sha',
        content: encodeGitHubContent({ version: 2 }),
      }),
      'PUT /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({ content: { sha: 'new-sha' } }),
    });
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'foo./bar', files: {} }),
    }, cookies);
    expect(res.status).not.toBe(400);
  });
});

describe('拡張ファイル名バリデーション', () => {
  it('name が数値の場合は 400 を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/file/valid-id-123', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'main', name: 123 }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('name が配列の場合は 400 を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/file/valid-id-123', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'main', name: ['evil'] }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('name に / を含む場合は 400 を返す（パストラバーサル）', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/file/valid-id-123', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'main', name: '../evil' }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('name が . のみの場合は 400 を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/file/valid-id-123', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'main', name: '.' }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('name に制御文字を含む場合は 400 を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'unused' } }));
    const res = await appFetch('/sync/file/valid-id-123', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'main', name: 'evil\x01name' }),
    }, cookies);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sync 経路の token 失効時のセッション破棄（#288）', () => {
  it('GitHub API が 401 を返したらセッションを破棄しクライアントに 401 を返す', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ message: 'Bad credentials' }, { status: 401 }),
    });

    expect(await env.SESSIONS.get(`session:${sessionToken}`)).not.toBeNull();

    const res = await appFetch('/sync/devices', {}, cookies);

    expect(res.status).toBe(401);
    expect(await env.SESSIONS.get(`session:${sessionToken}`)).toBeNull();
  });

  it('token 失効の 401 は manifest 経路でも 401 を返す（500 に化けない）', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ message: 'Bad credentials' }, { status: 401 }),
    });

    const res = await appFetch('/sync/manifest', {}, cookies);

    expect(res.status).toBe(401);
  });

  it('403（権限不足・レート制限等）はセッションを破棄しない', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse(
        { message: 'Forbidden' },
        { status: 403 },
      ),
    });

    const res = await appFetch('/sync/devices', {}, cookies);

    expect(res.status).not.toBe(401);
    expect(await env.SESSIONS.get(`session:${sessionToken}`)).not.toBeNull();
  });
});

// ── upstream error 意味論（#608 A-1） ────────────────────────────────────────
// GitHub の status / category を潰さず client へ渡すことを固定する。409（SHA 競合）と
// 422（検証エラー）は別カテゴリであり、422 を conflict として扱わない。
// client の読み側（buildRemoteMap）が corrupt として弾く形状を、書き側でも受け入れない。
// 非対称だと client が「自分の読み側が拒否する manifest」を書けてしまう。
// client 側のガードだけでは、worker とフロントの切り替えが非同時な環境で破れる
// （旧 bundle のタブは未知 code を無視して /sync/init を呼ぶ）。信頼境界の側でも閉じる。
describe('POST /sync/init の workspace 不整合ガード', () => {
  it('manifest が無く entity がある repo では init を成功させない', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ default_branch: 'main' }),
      '/repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({ message: 'Not Found' }, { status: 404 }),
      '/repos/testuser/.novel-ide/contents/files': jsonResponse([{ name: 'a.json', type: 'file' }]),
    });

    const res = await appFetch('/sync/init', { method: 'POST', headers: csrfHeaders }, cookies);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'sync_workspace_inconsistent' });
  });

  it('manifest が無く entity も無い repo では init を成功させる', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ default_branch: 'main' }),
      '/repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({ message: 'Not Found' }, { status: 404 }),
      '/repos/testuser/.novel-ide/contents/files': jsonResponse({ message: 'Not Found' }, { status: 404 }),
    });

    const res = await appFetch('/sync/init', { method: 'POST', headers: csrfHeaders }, cookies);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: false, branch: 'main' });
  });

  it('manifest がある既存 repo は従来どおり成功する', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ default_branch: 'main' }),
      '/repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent({ version: 2, files: {} }),
        sha: 'm-sha',
      }),
    });

    const res = await appFetch('/sync/init', { method: 'POST', headers: csrfHeaders }, cookies);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: false });
  });

  // #394 E9: 新規 repo 作成時に worker が書く「橋渡し」manifest は legacy default（2）を
  // 宣言する。client の実 push（pushManifest）が直後に version 3 で上書きするため、
  // ここで v3 の manifest を worker が自ら生成しない（folders 無しの v3 を作らない）。
  it('新規 repo 作成時、初期 manifest の version は legacy default(2) を宣言する', async () => {
    let writtenBody: Record<string, unknown> | null = null;
    mockFetch((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = ((input instanceof Request ? input.method : init?.method) ?? 'GET').toUpperCase();
      const path = new URL(url).pathname;
      if (method === 'PUT' && path === '/repos/testuser/.novel-ide/contents/manifest.json') {
        writtenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ content: { sha: 'init-manifest-sha' } });
      }
      if (method === 'GET' && path === '/repos/testuser/.novel-ide') {
        return jsonResponse({ message: 'Not Found' }, { status: 404 });
      }
      if (method === 'POST' && path === '/user/repos') {
        return jsonResponse({ default_branch: 'main' }, { status: 201 });
      }
      return jsonResponse({ message: `unexpected ${method} ${path}` }, { status: 500 });
    });

    const res = await appFetch('/sync/init', { method: 'POST', headers: csrfHeaders }, cookies);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: true, branch: 'main' });

    expect(writtenBody).not.toBeNull();
    const decoded = decodeGitHubContent(writtenBody!.content as string);
    expect(decoded.version).toBe(2);
  }, 5000);
});

describe('PUT /sync/manifest の files 形状検証', () => {
  it.each([
    ['配列', []],
    ['文字列', 'abc'],
    ['数値', 3],
    ['null', null],
  ])('files が %s なら 400 で拒否する', async (_label, files) => {
    // checkFormatCapability が files 検証より先に走る（#609・Codex 指摘）ため、
    // GET manifest.json は正当な v2 応答にしておく（400 の原因は files 検証だけにする）。
    mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent({ version: 2, files: {} }),
        sha: 'old',
      }),
    });

    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _sha: 'old', _branch: 'main', files }),
    }, cookies);

    expect(res.status).toBe(400);
  });

  it('files を持たない manifest も拒否する', async () => {
    mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent({ version: 2, files: {} }),
        sha: 'old',
      }),
    });

    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _sha: 'old', _branch: 'main', fileOrder: [] }),
    }, cookies);

    expect(res.status).toBe(400);
  });

  it('正当な files は書き込める', async () => {
    mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: encodeGitHubContent({ version: 2, files: {} }),
        sha: 'old',
      }),
      'PUT /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: { sha: 'new' },
      }),
    });

    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _sha: 'old', _branch: 'main', files: {}, fileOrder: [] }),
    }, cookies);

    expect(res.status).toBe(200);
  });
});

// remote manifest の formatVersion と client の capability 宣言を突き合わせるゲート（#609 A-2）。
// matrix の最重要行は「remote v2・capability 未宣言 → 拒否しない」（1行目）。ここを壊すと
// 既存クライアントの同期が全滅する。
describe('PUT /sync/manifest の formatVersion ゲート（#609）', () => {
  function mockCurrentManifest(content: object | null) {
    return mockGitHubByPath({
      'GET /repos/testuser/.novel-ide/contents/manifest.json':
        content === null
          ? jsonResponse({}, { status: 404 })
          : jsonResponse({ content: encodeGitHubContent(content), sha: 'current-sha' }),
      'PUT /repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: { sha: 'written-sha' },
      }),
    });
  }

  function putManifest(
    headers: Record<string, string> = {},
    body: Record<string, unknown> = { _sha: 'current-sha', _branch: 'main', files: {} },
  ) {
    return appFetch('/sync/manifest', {
      method: 'PUT',
      headers: { ...csrfHeaders, ...headers },
      body: JSON.stringify(body),
    }, cookies);
  }

  it('remote が version 2・capability 未宣言なら許可する（回帰防止・matrix 1行目）', async () => {
    mockCurrentManifest({ version: 2, files: {} });

    const res = await putManifest();

    expect(res.status).toBe(200);
  });

  it('remote が version 2 以下なら、capability 宣言が remote 未満でも許可する（既知安全域は宣言不問）', async () => {
    mockCurrentManifest({ version: 2, files: {} });

    const res = await putManifest({ 'X-Novel-Ide-Format-Version': '1' });

    expect(res.status).toBe(200);
  });

  // remote が既知安全域（v2）でも、書き込む本文の version が安全域を超えるなら
  // capability 宣言不問の早期 return を通してはいけない（Codex レビュー指摘）。
  it('remote が version 2 でも、書き込む本文の version が capability を超えるなら 426 で拒否する', async () => {
    mockCurrentManifest({ version: 2, files: {} });

    const res = await putManifest(
      { 'X-Novel-Ide-Format-Version': '2' },
      { _sha: 'current-sha', _branch: 'main', version: 3, files: {} },
    );

    expect(res.status).toBe(426);
  });

  it('manifest が未作成（初回作成）なら version を問わず許可する', async () => {
    mockCurrentManifest(null);

    // 初回作成は _sha を送らない（create-only 意図。実際の client 側 pushManifest と同じ形）。
    const res = await putManifest({}, { _sha: null, _branch: 'main', files: {} });

    expect(res.status).toBe(200);
  });

  // 初回作成（manifest 不在）でも、書き込む version が capability を超えるなら同じ契約を
  // 適用する（Codex レビュー指摘。既存更新にしか効かない実装だった）。
  it('manifest が未作成でも、書き込む本文の version が capability を超えるなら 426 で拒否する', async () => {
    mockCurrentManifest(null);

    const res = await putManifest(
      { 'X-Novel-Ide-Format-Version': '2' },
      { _sha: null, _branch: 'main', version: 3, files: {} },
    );

    expect(res.status).toBe(426);
  });

  it('remote が version 3・capability 未宣言なら 426 で拒否する', async () => {
    mockCurrentManifest({ version: 3, files: {} });

    const res = await putManifest();

    expect(res.status).toBe(426);
    expect(await res.json()).toMatchObject({ code: 'sync_protocol_upgrade_required' });
  });

  it('remote が version 3・capability 宣言（3）があり、書き込む本文も version 3 なら許可する', async () => {
    mockCurrentManifest({ version: 3, files: {}, folders: {} });

    const res = await putManifest(
      { 'X-Novel-Ide-Format-Version': '3' },
      { _sha: 'current-sha', _branch: 'main', version: 3, files: {}, folders: {} },
    );

    expect(res.status).toBe(200);
  });

  // #394 C-1: v2 固有だった「files は object 必須」要求を v3 以降にも引き継ぎ、
  // folders も dict 必須にする（契約3: 読み寛容・書き厳格）。client 読み側
  // （buildRemoteMap/parseRemoteStructure）は folders 欠落・非 dict を unknown として
  // local を保持するが、worker の書き側で同じ形状を受け入れると client 自身の読み側が
  // 拒否する manifest を書けてしまう。
  it('書き込む本文が version 3 でも files が object でなければ 400（folders 欠落時と同じ形状要求）', async () => {
    mockCurrentManifest({ version: 3, files: {}, folders: {} });

    const res = await putManifest(
      { 'X-Novel-Ide-Format-Version': '3' },
      { _sha: 'current-sha', _branch: 'main', version: 3, files: ['not-an-object-shape'], folders: {} },
    );

    expect(res.status).toBe(400);
  });

  it('書き込む本文が version 3 で folders が object でなければ 400', async () => {
    mockCurrentManifest({ version: 3, files: {}, folders: {} });

    const res = await putManifest(
      { 'X-Novel-Ide-Format-Version': '3' },
      { _sha: 'current-sha', _branch: 'main', version: 3, files: {}, folders: ['not-an-object-shape'] },
    );

    expect(res.status).toBe(400);
  });

  it('書き込む本文が version 3 で folders が欠落していれば 400', async () => {
    mockCurrentManifest({ version: 3, files: {}, folders: {} });

    const res = await putManifest(
      { 'X-Novel-Ide-Format-Version': '3' },
      { _sha: 'current-sha', _branch: 'main', version: 3, files: {} },
    );

    expect(res.status).toBe(400);
  });

  // capability header で高い version を申告しながら、実際に書く本文の version は低いまま
  // （downgrade）というすり抜けを閉じる（敵対的レビュー所見）。
  it('capability 宣言はあっても書き込む本文の version が remote 未満なら 426 で拒否する（downgrade 防止）', async () => {
    mockCurrentManifest({ version: 3, files: {} });

    const res = await putManifest(
      { 'X-Novel-Ide-Format-Version': '3' },
      { _sha: 'current-sha', _branch: 'main', version: 2, files: {} },
    );

    expect(res.status).toBe(426);
  });

  // capability=3・remote=3 で書き込む本文の version が 4 の場合、remote 以上・capability 以上
  // という両方の下限チェックは通過してしまう。しかし capability は「この client が理解できる
  // version の上限」という契約なので、これを超える version を書けてしまうと、書いた client
  // 自身が理解しない manifest を作ってしまう（Codex レビュー指摘）。
  it('書き込む本文の version が capability を超えるなら 426 で拒否する（capability は書き込み上限でもある）', async () => {
    mockCurrentManifest({ version: 3, files: {} });

    const res = await putManifest(
      { 'X-Novel-Ide-Format-Version': '3' },
      { _sha: 'current-sha', _branch: 'main', version: 4, files: {} },
    );

    expect(res.status).toBe(426);
  });

  it('remote が version 3・capability 宣言が不足（2）なら 426 で拒否する', async () => {
    mockCurrentManifest({ version: 3, files: {} });

    const res = await putManifest({ 'X-Novel-Ide-Format-Version': '2' });

    expect(res.status).toBe(426);
  });

  it.each([
    ['欠落', undefined],
    ['非数値', '2.5'],
    ['文字列', '"2"'],
  ])('remote manifest の version が%sなら 2 として扱う（version 3 拒否は健在）', async (_label, version) => {
    mockCurrentManifest(version === undefined ? { files: {} } : { version, files: {} });

    const res = await putManifest();

    // 2 として扱われるため、capability 未宣言でも許可される
    expect(res.status).toBe(200);
  });

  // 負数は整数として妥当なため 2 へは倒さずそのまま扱う（下限チェックは行わない。
  // src/lib/sync.test.js の同名テストと対）。KNOWN_SAFE_FORMAT_VERSION(2) 以下なので
  // 結果としては許可されるが、根拠は「2 として扱われた」ではなく「-1 <= 2」である。
  it('remote manifest の version が負数なら 2 へは倒さずそのまま扱う（-1 <= 2 のため許可はされる）', async () => {
    mockCurrentManifest({ version: -1, files: {} });

    const res = await putManifest();

    expect(res.status).toBe(200);
  });

  it('capability ヘッダが非数値なら 2 として扱う（remote version 3 は拒否される）', async () => {
    mockCurrentManifest({ version: 3, files: {} });

    const res = await putManifest({ 'X-Novel-Ide-Format-Version': 'not-a-number' });

    expect(res.status).toBe(426);
  });

  // GET が 404（レプリケーション遅延等で「無い」ように見える）でも、request が非 null の
  // _sha を送っている＝「既存 manifest を更新するつもりでいる」場合は矛盾したシグナルであり、
  // 「未作成だから許可」へ倒してはいけない（敵対的レビュー所見）。fail-closed で 502 upstream。
  it('GET が 404 でも request が _sha を送っていれば矛盾として拒否する（レプリケーション遅延対策）', async () => {
    mockCurrentManifest(null);

    const res = await putManifest({}, { _sha: 'current-sha', _branch: 'main', files: {} });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'sync_upstream_error' });
  });
});

describe('sync upstream error 意味論', () => {
  const writeTargets: [string, string, RequestInit][] = [
    ['manifest', '/sync/manifest', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ _sha: 'old', _branch: 'main', files: {} }),
    }],
    ['file', '/sync/file/novel-1', {
      method: 'PUT', headers: csrfHeaders,
      // 世代拘束（#609 A-2）のため _manifestSha を必須で送る。blanket mock は GET/PUT を
      // 問わずすべての fetch を同じ status で応答するため、manifest GET 自体がこの status で
      // 失敗し、期待どおりの category へ分類される（entity 固有の分岐には到達しない）。
      body: JSON.stringify({ _sha: 'old', _manifestSha: 'manifest-sha', _branch: 'main', name: '第一話' }),
    }],
    ['settings', '/sync/settings', {
      method: 'PUT', headers: csrfHeaders,
      body: JSON.stringify({ _sha: 'old', _branch: 'main', theme: 'dark' }),
    }],
  ];

  it.each(writeTargets)('%s の PUT は GitHub 409 を conflict として返す', async (_n, path, opts) => {
    mockFetch(() => jsonResponse({ message: 'is at 111 but expected 222' }, { status: 409 }));

    const res = await appFetch(path, opts, cookies);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'sync_conflict' });
  });

  it.each(writeTargets)('%s の PUT は GitHub 422 を conflict ではなく validation として返す', async (_n, path, opts) => {
    mockFetch(() => jsonResponse({ message: 'Invalid request' }, { status: 422 }));

    const res = await appFetch(path, opts, cookies);

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'sync_unprocessable' });
  });

  it.each(writeTargets)('%s の PUT は GitHub 5xx を upstream 障害として返す', async (_n, path, opts) => {
    mockFetch(() => jsonResponse({ message: 'Server Error' }, { status: 502 }));

    const res = await appFetch(path, opts, cookies);

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'sync_upstream_error' });
  });

  it.each(writeTargets)('%s の PUT は GitHub 403 を権限エラーとして返す', async (_n, path, opts) => {
    mockFetch(() => jsonResponse({ message: 'Forbidden' }, { status: 403 }));

    const res = await appFetch(path, opts, cookies);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'sync_forbidden' });
  });

  it('GitHub のエラー本文を client へ透過しない', async () => {
    mockFetch(() => jsonResponse({ message: 'secret-internal-detail' }, { status: 409 }));

    const res = await appFetch('/sync/manifest', writeTargets[0][2], cookies);

    expect(JSON.stringify(await res.json())).not.toContain('secret-internal-detail');
  });

  it('GitHub のエラー本文が JSON でなくても分類できる', async () => {
    mockFetch(() => new Response('<html>gateway</html>', {
      status: 409, headers: { 'Content-Type': 'text/html' },
    }));

    const res = await appFetch('/sync/manifest', writeTargets[0][2], cookies);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'sync_conflict' });
  });

  it('devices の PUT は文字列一致に依存せず 409 を返す', async () => {
    mockFetch((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = ((input instanceof Request ? input.method : init?.method) ?? 'GET').toUpperCase();
      if (method === 'PUT') return jsonResponse({ message: 'conflict' }, { status: 409 });
      if (new URL(url).pathname.endsWith('/contents/devices.json')) {
        return jsonResponse({ content: encodeGitHubContent({ devices: {} }), sha: 'dev-sha' });
      }
      return jsonResponse({ message: 'unexpected' }, { status: 500 });
    });

    const res = await appFetch('/sync/devices/dev-1', {
      method: 'PUT', headers: csrfHeaders, body: JSON.stringify({ _branch: 'main', name: 'PC' }),
    }, cookies);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'sync_conflict' });
  });
});

// ── manifest 404 の種別（#608 A-1） ─────────────────────────────────────────
// repo 不在と manifest 不在を client が区別できることを固定する。区別できないと、
// 一時的な取得失敗まで初回同期（local 全ファイルの無条件 push）へ倒れる。
describe('GET /sync/manifest の 404 種別', () => {
  it('repo 不在は sync_repo_missing を返す', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ message: 'Not Found' }, { status: 404 }),
    });

    const res = await appFetch('/sync/manifest', {}, cookies);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'sync_repo_missing' });
  });

  it('repo 存在 + manifest 不在 + entity なしは sync_manifest_missing を返す', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ default_branch: 'main' }),
      '/repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({ message: 'Not Found' }, { status: 404 }),
      '/repos/testuser/.novel-ide/contents/files': jsonResponse({ message: 'Not Found' }, { status: 404 }),
    });

    const res = await appFetch('/sync/manifest', {}, cookies);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'sync_manifest_missing' });
  });

  // manifest が取れないだけで「remote には何も無い」と断定すると、一時的な 404
  // （repo 作成直後のレプリケーション遅延等）で全件 push へ倒れ、他端末が push 済みの
  // 新しい本文を上書きしうる。entity の実在を確認して別 code にする。
  it('repo 存在 + manifest 不在でも entity があれば workspace 不整合として返す', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ default_branch: 'main' }),
      '/repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({ message: 'Not Found' }, { status: 404 }),
      '/repos/testuser/.novel-ide/contents/files': jsonResponse([
        { name: 'novel-1.json', type: 'file' },
      ]),
    });

    const res = await appFetch('/sync/manifest', {}, cookies);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'sync_workspace_inconsistent' });
  });

  // #394 E11: v3（manifest.version を 3 に上げるだけ・entity path space 据え置き。
  // #394 C-1 (a)）でも hasSyncedEntities は `files/` を走査するだけで version を読まない
  // ため、そのまま正しく動く。folders dict は manifest 側にあり、entity 実在確認とは
  // 無関係（既知の制約を解消。sync-contract.md 参照）。
  it('v3 manifest が失われていても entity（files/）が残っていれば workspace 不整合として返す', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ default_branch: 'main' }),
      '/repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({ message: 'Not Found' }, { status: 404 }),
      '/repos/testuser/.novel-ide/contents/files': jsonResponse([
        { name: 'novel-1.json', type: 'file' },
      ]),
    });

    const res = await appFetch('/sync/manifest', {}, cookies);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'sync_workspace_inconsistent' });
  });

  it('entity 一覧の取得が失敗したら不在と断定しない', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ default_branch: 'main' }),
      '/repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({ message: 'Not Found' }, { status: 404 }),
      '/repos/testuser/.novel-ide/contents/files': jsonResponse({ message: 'down' }, { status: 500 }),
    });

    const res = await appFetch('/sync/manifest', {}, cookies);

    expect(await res.json()).toMatchObject({ code: 'sync_upstream_error' });
  });

  // 配列でない listing（submodule / symlink / 単一ファイル）は「entity 無し」の根拠に
  // ならない。init を許可する側なので曖昧さは fail-closed に倒す。
  it('files が配列でない応答は entity なしと断定しない', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ default_branch: 'main' }),
      '/repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({ message: 'Not Found' }, { status: 404 }),
      '/repos/testuser/.novel-ide/contents/files': jsonResponse({ type: 'submodule', name: 'files' }),
    });

    const res = await appFetch('/sync/manifest', {}, cookies);

    expect(await res.json()).toMatchObject({ code: 'sync_workspace_inconsistent' });
  });

  it('空の files ディレクトリは entity なしとして扱う', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ default_branch: 'main' }),
      '/repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({ message: 'Not Found' }, { status: 404 }),
      '/repos/testuser/.novel-ide/contents/files': jsonResponse([]),
    });

    const res = await appFetch('/sync/manifest', {}, cookies);

    expect(await res.json()).toMatchObject({ code: 'sync_manifest_missing' });
  });

  // remote の壊れた JSON は「client が不正なリクエストを送った」400 とは別物。
  it('remote manifest が壊れていたら 400 Invalid JSON にしない', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ default_branch: 'main' }),
      '/repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({
        content: btoa('{ broken'),
        sha: 'x',
      }),
    });

    const res = await appFetch('/sync/manifest', {}, cookies);

    expect(res.status).not.toBe(400);
    expect(await res.json()).toMatchObject({ code: 'sync_remote_corrupt' });
  });

  it('429（rate limit）は server ではなく upstream として返す', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ message: 'rate limited' }, { status: 429 }),
    });

    const res = await appFetch('/sync/manifest', {}, cookies);

    expect(await res.json()).toMatchObject({ code: 'sync_upstream_error' });
  });

  it('manifest 取得の一時的な失敗は 404 にしない', async () => {
    mockGitHubByPath({
      '/repos/testuser/.novel-ide': jsonResponse({ default_branch: 'main' }),
      '/repos/testuser/.novel-ide/contents/manifest.json': jsonResponse({ message: 'down' }, { status: 500 }),
    });

    const res = await appFetch('/sync/manifest', {}, cookies);

    expect(res.status).not.toBe(404);
    expect(await res.json()).toMatchObject({ code: 'sync_upstream_error' });
  });
});
