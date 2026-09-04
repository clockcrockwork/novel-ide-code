import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  upsertIntoList,
  parseRemoteFile,
  resolvePushedFileIdbAction,
  buildRemoteMap,
  countSyncWork,
  syncAll,
  syncFile,
  syncFileSilent,
  resolveConflictKeepLocal,
  applyLocalParentId,
} from './sync';
import { SyncRequestError } from './syncErrors';
import { computeCanonicalHash, deriveSyncAction } from './sync/identity';

vi.mock('./workerClient', () => ({
  workerFetch: vi.fn(),
  workerFetchWithCSRF: vi.fn(),
}));

vi.mock('./db', () => ({
  dbPut: vi.fn().mockResolvedValue(undefined),
  dbGet: vi.fn().mockResolvedValue(undefined),
}));

import { workerFetch, workerFetchWithCSRF } from './workerClient';
import { dbGet, dbPut } from './db';

// ── applyLocalParentId（SP1: resolveConflictRemote/Both が共有する helper）───────────────

describe('applyLocalParentId', () => {
  it('local の parentId（文字列）を引き継ぐ', () => {
    const record = { id: 'a', name: 'a.md' };
    applyLocalParentId(record, { id: 'a', parentId: 'folder-a' });
    expect(record.parentId).toBe('folder-a');
  });

  it('local が root（null）なら root を維持する', () => {
    const record = { id: 'a', name: 'a.md' };
    applyLocalParentId(record, { id: 'a', parentId: null });
    expect(record.parentId).toBeNull();
  });

  it('local が無い（新規 pull）場合は null に倒す', () => {
    const record = { id: 'a', name: 'a.md' };
    applyLocalParentId(record, undefined);
    expect(record.parentId).toBeNull();
  });
});

// ── upsertIntoList ──────────────────────────────────────────────────────────

describe('upsertIntoList', () => {
  it('既存ファイルを上書きする', () => {
    const list = [{ id: 'a', name: '旧タイトル' }];
    const result = upsertIntoList(list, { id: 'a', name: '新タイトル' });
    expect(result).toEqual([{ id: 'a', name: '新タイトル' }]);
  });

  it('新規ファイルを末尾に追加する', () => {
    const list = [{ id: 'a' }];
    const result = upsertIntoList(list, { id: 'b' });
    expect(result).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('id が一致しない他ファイルを変更しない', () => {
    const list = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    const result = upsertIntoList(list, { id: 'a', name: 'A2' });
    expect(result[1]).toEqual({ id: 'b', name: 'B' });
  });

  it('空配列に追加できる', () => {
    const result = upsertIntoList([], { id: 'x' });
    expect(result).toEqual([{ id: 'x' }]);
  });

  it('元の配列を変更しない（純粋関数）', () => {
    const list = [{ id: 'a' }];
    upsertIntoList(list, { id: 'a', extra: true });
    expect(list[0]).not.toHaveProperty('extra');
  });
});

// ── parseRemoteFile ─────────────────────────────────────────────────────────

describe('parseRemoteFile', () => {
  it('_sha と _branch を除去する', () => {
    const json = {
      id: '1',
      name: 'test',
      updatedAt: '2024-01-01T00:00:00Z',
      _sha: 'abc',
      _branch: 'main',
    };
    const result = parseRemoteFile(json);
    expect(result).not.toHaveProperty('_sha');
    expect(result).not.toHaveProperty('_branch');
  });

  // #609 round2 運用性F1+L1: 旧 worker が未知フィールドをそのまま entity JSON に永続化した
  // 場合の汚染を、client 側で `_` 始まりの transport フィールドを一律除去して吸収する。
  it('_manifestSha / _reconcile を含む _ で始まる全フィールドを除去する', () => {
    const json = {
      id: '1',
      name: 'test',
      updatedAt: '2024-01-01T00:00:00Z',
      _sha: 'abc',
      _branch: 'main',
      _manifestSha: 'm-sha',
      _reconcile: true,
      _futureField: 'unknown',
    };
    const result = parseRemoteFile(json);
    expect(result).not.toHaveProperty('_manifestSha');
    expect(result).not.toHaveProperty('_reconcile');
    expect(result).not.toHaveProperty('_futureField');
    expect(result.id).toBe('1');
  });

  it('updatedAt を ISO 文字列からミリ秒に変換する', () => {
    const iso = '2024-06-01T12:00:00.000Z';
    const result = parseRemoteFile({ id: '1', updatedAt: iso, _sha: null, _branch: null });
    expect(result.updatedAt).toBe(new Date(iso).getTime());
  });

  it('isDirty を false にセットする', () => {
    const result = parseRemoteFile({
      id: '1',
      updatedAt: '2024-01-01T00:00:00Z',
      isDirty: true,
      _sha: null,
      _branch: null,
    });
    expect(result.isDirty).toBe(false);
  });

  it('その他のフィールドを保持する', () => {
    const result = parseRemoteFile({
      id: '1',
      name: 'foo',
      content: 'bar',
      updatedAt: '2024-01-01T00:00:00Z',
      _sha: null,
      _branch: null,
    });
    expect(result.id).toBe('1');
    expect(result.name).toBe('foo');
    expect(result.content).toBe('bar');
  });

  it('無効な updatedAt は 0 にフォールバックする', () => {
    const result = parseRemoteFile({
      id: '1',
      updatedAt: 'invalid-date',
      _sha: null,
      _branch: null,
    });
    expect(result.updatedAt).toBe(0);
  });

  it('EXTERNAL な remote ファイル名を sanitize する (#285)', () => {
    const result = parseRemoteFile({
      id: '1',
      name: 'evil‮name.md',
      updatedAt: '2024-01-01T00:00:00Z',
      _sha: null,
      _branch: null,
    });
    expect(result.name).not.toContain('‮');
    expect(result.name).toBe('evilname.md');
  });

  it('非文字列 content を空文字に正規化する (#285)', () => {
    const result = parseRemoteFile({
      id: '1',
      name: 'a.md',
      content: { broken: true },
      updatedAt: '2024-01-01T00:00:00Z',
      _sha: null,
      _branch: null,
    });
    expect(result.content).toBe('');
  });

  it('空になる名前はデフォルトにフォールバックする (#285)', () => {
    const result = parseRemoteFile({
      id: '1',
      name: '..',
      updatedAt: '2024-01-01T00:00:00Z',
      _sha: null,
      _branch: null,
    });
    expect(result.name).toBe('ファイル.md');
  });
});

// ── deriveSyncAction への委譲確認（#610 round2 品質） ─────────────────────────
// sync.js は独自の classifyFile を持たない（production 未参照だったため削除）。
// 内部の resolveClassification が src/lib/sync/identity.js の deriveSyncAction へ直接
// 委譲する（完了条件7。badge の useSyncPending も同じ関数を直接呼ぶ）。分岐の網羅は
// identity.test.js の deriveSyncAction 側が担うため、ここでは委譲先が生きていることだけを
// spot-check する。

describe('sync.js は deriveSyncAction（identity.js）に委譲する', () => {
  it('remoteHash が無ければ push', () => {
    expect(deriveSyncAction({ localHash: 'L', remoteHash: undefined, adoptedHash: undefined }).action).toBe(
      'push',
    );
  });

  it('localHash === remoteHash なら skip', () => {
    expect(deriveSyncAction({ localHash: 'X', remoteHash: 'X', adoptedHash: 'X' }).action).toBe('skip');
  });
});

// ── resolvePushedFileIdbAction ──────────────────────────────────────────────

describe('resolvePushedFileIdbAction', () => {
  it('currentFile が無ければ delete を返す（往復中に削除された）', () => {
    const pushed = { id: 'a', updatedAt: 100 };
    expect(resolvePushedFileIdbAction(pushed, undefined)).toEqual({ action: 'delete' });
  });

  it('updatedAt が異なれば restore を返し currentFile を積む（往復中に編集された）', () => {
    const pushed = { id: 'a', updatedAt: 100 };
    const current = { id: 'a', updatedAt: 200, content: '新しい本文', isDirty: true };
    expect(resolvePushedFileIdbAction(pushed, current)).toEqual({
      action: 'restore',
      file: current,
    });
  });

  it('updatedAt が一致すれば none を返す（変化なし）', () => {
    const pushed = { id: 'a', updatedAt: 100 };
    const current = { id: 'a', updatedAt: 100, content: 'そのまま', isDirty: true };
    expect(resolvePushedFileIdbAction(pushed, current)).toEqual({ action: 'none' });
  });
});

// ── buildRemoteMap ──────────────────────────────────────────────────────────

describe('buildRemoteMap', () => {
  it('_branch を branch として抽出する', () => {
    const { branch } = buildRemoteMap({ _branch: 'main', _sha: 'abc', files: {} });
    expect(branch).toBe('main');
  });

  it('_sha を manifestSha として抽出する', () => {
    const { manifestSha } = buildRemoteMap({ _branch: 'main', _sha: 'sha123', files: {} });
    expect(manifestSha).toBe('sha123');
  });

  it('files マップを remoteFiles として返す', () => {
    const files = { a: { id: 'a', updatedAt: '2024-01-01T00:00:00Z' } };
    const { remoteFiles } = buildRemoteMap({ _branch: 'main', _sha: null, files });
    expect(remoteFiles).toEqual(files);
  });

  // files 欠落を「空」と解釈すると、manifest.json が JSON 配列に置き換わる等で files キーごと
  // 消えた場合に remote が空に見え、全件 push で他端末の entry を一掃したうえで
  // 「同期済み」と表示する。欠落は壊れた manifest として止める。
  it('files が未定義なら空扱いせず corrupt として弾く', () => {
    expect(() => buildRemoteMap({ _branch: 'main', _sha: null })).toThrow();
  });

  it('_branch が未定義の場合は branch が undefined', () => {
    const { branch } = buildRemoteMap({ _sha: null, files: {} });
    expect(branch).toBeUndefined();
  });

  // formatVersion / fileOrder の読み取り経路（#609 A-2）。version は書かれるだけで
  // 読まれていなかった（issue 本文）。
  describe('formatVersion', () => {
    it('version をそのまま formatVersion として読む', () => {
      // v3 は folders も dict 必須（item13）。version 読み取りの検証が主眼のため folders: {} を渡す。
      const { formatVersion } = buildRemoteMap({ version: 3, _sha: null, files: {}, folders: {} });
      expect(formatVersion).toBe(3);
    });

    it.each([
      ['欠落', undefined],
      ['非数値（文字列）', '2'],
      ['非整数（小数）', 2.5],
    ])('version が%sなら LEGACY_DEFAULT_FORMAT_VERSION(2) に倒す', (_label, value) => {
      const { formatVersion } = buildRemoteMap({ version: value, _sha: null, files: {} });
      expect(formatVersion).toBe(2);
    });

    it('負数は整数として妥当なため 2 へは倒さずそのまま読む（下限チェックは呼び出し側の責務）', () => {
      const { formatVersion } = buildRemoteMap({ version: -1, _sha: null, files: {} });
      expect(formatVersion).toBe(-1);
    });

    // formatVersion は v2 固有の形状検証（files 等）より先に判定する（#609・Codex 指摘）。
    // v3 以降で files の形状自体が変わっても、先に corrupt を投げて中止フラグの設定に
    // 到達しない、という事故を防ぐ。
    // #394 C-1: FORMAT_CAPABILITY_VERSION は 3 になったため、これを超える値（4）で検証する
    // （3 は現行 capability 内 = files/folders 検証まで進む）。
    it.each([
      ['配列', [{ id: 'a' }]],
      ['欠落', undefined],
      ['null', null],
    ])('formatVersion が現行 capability を超えていれば、files の形状が%sでも corrupt を投げず formatVersion を返す', (_label, files) => {
      const result = buildRemoteMap({ version: 4, _sha: null, files });
      expect(result.formatVersion).toBe(4);
      expect(result.remoteFiles).toEqual({});
      expect(result.fileOrder).toEqual([]);
    });

    it('formatVersion が現行 capability 内なら、files の形状異常は従来どおり corrupt を投げる（回帰防止）', () => {
      expect(() => buildRemoteMap({ version: 2, _sha: null, files: [{ id: 'a' }] })).toThrow();
      expect(() => buildRemoteMap({ version: 3, _sha: null, files: [{ id: 'a' }] })).toThrow();
    });
  });

  describe('fileOrder', () => {
    it('fileOrder 配列をそのまま返す', () => {
      const { fileOrder } = buildRemoteMap({
        _sha: null,
        files: {},
        fileOrder: ['a', 'b'],
      });
      expect(fileOrder).toEqual(['a', 'b']);
    });

    it('fileOrder が欠落なら空配列にフォールバックする', () => {
      const { fileOrder } = buildRemoteMap({ _sha: null, files: {} });
      expect(fileOrder).toEqual([]);
    });

    it('fileOrder が配列でなければ空配列にフォールバックする', () => {
      const { fileOrder } = buildRemoteMap({ _sha: null, files: {}, fileOrder: { a: 0 } });
      expect(fileOrder).toEqual([]);
    });

    it('fileOrder 内の非文字列要素は除外する', () => {
      const { fileOrder } = buildRemoteMap({
        _sha: null,
        files: {},
        fileOrder: ['a', 1, null, 'b'],
      });
      expect(fileOrder).toEqual(['a', 'b']);
    });

    it('remoteFiles に存在しない stale な id もそのまま返す（呼び出し側が id→index として使うだけで安全）', () => {
      const { fileOrder } = buildRemoteMap({
        _sha: null,
        files: { a: { updatedAt: '2024-01-01T00:00:00Z' } },
        fileOrder: ['a', 'ghost'],
      });
      expect(fileOrder).toEqual(['a', 'ghost']);
    });
  });
});

// ── countSyncWork ───────────────────────────────────────────────────────────
// #610: hash 入力版。進捗表示用の概算件数（updatedAt・isDirty は読まない）。

describe('countSyncWork', () => {
  // entry.hash は isValidCanonicalHash（64 桁小文字 hex）を満たす必要がある
  // （#610 round2 F2）。テスト用の妥当な hash 値をここで用意する。
  const HASH_H = '1'.repeat(64);
  const HASH_OLD = 'a'.repeat(64);
  const HASH_NEW = 'b'.repeat(64);
  const HASH_B = 'c'.repeat(64);
  const HASH_OLD_C = 'd'.repeat(64);
  const HASH_NEW_C = 'e'.repeat(64);
  const HASH_D = 'f'.repeat(64);

  it('空入力は 0 を返す', () => {
    expect(countSyncWork([], {}, new Set())).toBe(0);
  });

  it('remote に entry が無いローカルファイルをカウントする（push 対象）', () => {
    const files = [{ id: 'a' }];
    expect(countSyncWork(files, {}, new Set(['a']), { a: HASH_H })).toBe(1);
  });

  it('localHash と entry.hash が一致すればカウントしない（skip）', () => {
    const files = [{ id: 'a' }];
    const remoteFiles = { a: { hash: HASH_H } };
    expect(countSyncWork(files, remoteFiles, new Set(['a']), { a: HASH_H })).toBe(0);
  });

  it('localHash と entry.hash が不一致ならカウントする', () => {
    const files = [{ id: 'a' }];
    const remoteFiles = { a: { hash: HASH_OLD } };
    expect(countSyncWork(files, remoteFiles, new Set(['a']), { a: HASH_NEW })).toBe(1);
  });

  it('entry が hash を持たない（legacy）場合は保守的にカウントする', () => {
    const files = [{ id: 'a' }];
    const remoteFiles = { a: { updatedAt: '2024-01-01T00:00:00Z' } };
    expect(countSyncWork(files, remoteFiles, new Set(['a']), { a: HASH_H })).toBe(1);
  });

  // entry.hash が形式として妥当でない（"0" 等）場合も legacy と同じく保守的にカウントする
  // （#610 round2 F2。isValidCanonicalHash で「欠落」扱いになる）。
  it('entry.hash の形式が妥当でない（"0"）場合も保守的にカウントする', () => {
    const files = [{ id: 'a' }];
    const remoteFiles = { a: { hash: '0' } };
    expect(countSyncWork(files, remoteFiles, new Set(['a']), { a: HASH_H })).toBe(1);
  });

  it('リモートのみのファイルをカウントする', () => {
    const remoteFiles = { b: { hash: HASH_H } };
    expect(countSyncWork([], remoteFiles, new Set())).toBe(1);
  });

  it('複数ファイルを正確に合計する', () => {
    const files = [
      { id: 'a' }, // push（entry 無し）
      { id: 'b' }, // skip（hash 一致）
      { id: 'c' }, // 変更あり（hash 不一致）
    ];
    const remoteFiles = {
      b: { hash: HASH_B },
      c: { hash: HASH_OLD_C },
      d: { hash: HASH_D }, // remote-only pull
    };
    const localHashes = { a: HASH_OLD, b: HASH_B, c: HASH_NEW_C };
    const localIds = new Set(['a', 'b', 'c']);
    expect(countSyncWork(files, remoteFiles, localIds, localHashes)).toBe(3);
  });
});

// ── syncAll 統合スモークテスト ────────────────────────────────────────────────

function makeOkResponse(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

// worker が返す「repo 不在」応答（#608 A-1）。init 経路はこの code を確認できたときだけ成立する。
function makeRepoMissingResponse() {
  return {
    ok: false,
    status: 404,
    json: () =>
      Promise.resolve({ error: '同期リポジトリがまだありません', code: 'sync_repo_missing' }),
  };
}

function makeManifest(files = {}, branch = 'main', sha = 'sha1') {
  return { version: 2, _branch: branch, _sha: sha, files };
}

describe('syncAll — 通常パス', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ローカルのみファイルを push する', async () => {
    const file = { id: 'a', name: 'test', content: 'hello', updatedAt: Date.now(), isDirty: true };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifest()));
      if (path === '/sync/file/a') return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve(makeOkResponse({}));
    });
    workerFetchWithCSRF.mockImplementation((path) => {
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse({}));
      if (path === '/sync/manifest') return Promise.resolve({ ok: true });
      if (path.startsWith('/sync/devices')) return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const pushCalls = workerFetchWithCSRF.mock.calls.filter(([p]) => p === '/sync/file/a');
    expect(pushCalls.length).toBeGreaterThan(0);
  });

  // capability header（X-Novel-Ide-Format-Version）を消費するのは worker の
  // formatVersion ゲートを通る 2 ルート（PUT /sync/manifest の checkFormatCapability と
  // PUT /sync/file/:id の checkRemoteFormatVersion）だけなので、他ルート（devices 等）に
  // 一律送ると、フロントエンドを Worker より先に配備するクロスオリジン構成で、その旧
  // Worker の CORS 許可一覧に無いヘッダーが preflight を拒否し、entity 同期・端末削除まで
  // 止まる（#619 レビュー round 13 指摘。現在は entity write へ意図的に送る＝下記の
  // 拡張）。entity write（syncFile）への拡張は #394 C-0
  // （remote が v3 化した瞬間に自分の entity write が 426 で恒久停止するのを防ぐため）。
  it('manifest PUT・entity PUT には formatCapability: true を渡すが、device upsert には渡さない', async () => {
    const file = { id: 'a', name: 'test', content: 'hello', updatedAt: Date.now(), isDirty: true };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifest()));
      if (path === '/sync/file/a') return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve(makeOkResponse({}));
    });
    workerFetchWithCSRF.mockImplementation((path) => {
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse({}));
      if (path === '/sync/manifest') return Promise.resolve({ ok: true });
      if (path.startsWith('/sync/devices')) return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const manifestCall = workerFetchWithCSRF.mock.calls.find(
      ([p, o]) => p === '/sync/manifest' && o?.method === 'PUT',
    );
    const fileCall = workerFetchWithCSRF.mock.calls.find(
      ([p, o]) => p === '/sync/file/a' && o?.method === 'PUT',
    );
    const deviceCall = workerFetchWithCSRF.mock.calls.find(([p]) => p.startsWith('/sync/devices'));

    expect(manifestCall).toBeDefined();
    expect(manifestCall[1].formatCapability).toBe(true);

    expect(fileCall).toBeDefined();
    expect(fileCall[1].formatCapability).toBe(true);

    expect(deviceCall).toBeDefined();
    expect(deviceCall[1]?.formatCapability).toBeFalsy();
  });

  it('push 成功時に onPushFile(originalFile) を呼ぶ (#245)', async () => {
    const file = { id: 'a', name: 'test', content: 'hello', updatedAt: Date.now(), isDirty: true };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifest()));
      if (path === '/sync/file/a') return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve(makeOkResponse({}));
    });
    workerFetchWithCSRF.mockImplementation((path) => {
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse({}));
      if (path === '/sync/manifest') return Promise.resolve({ ok: true });
      if (path.startsWith('/sync/devices')) return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true });
    });

    const onPushFile = vi.fn();
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onPushFile, onBranch: vi.fn() });

    expect(onPushFile).toHaveBeenCalledOnce();
    const [originalArg] = onPushFile.mock.calls[0];
    expect(originalArg).toBe(file);
  });

  it('一部ファイルの push が失敗したら status.error に件数を載せる', async () => {
    const fileA = { id: 'a', name: 'a', content: 'ok', updatedAt: Date.now(), isDirty: true };
    const fileB = { id: 'b', name: 'b', content: 'fail', updatedAt: Date.now(), isDirty: true };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifest()));
      if (path === '/sync/file/a' || path === '/sync/file/b')
        return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve(makeOkResponse({}));
    });
    workerFetchWithCSRF.mockImplementation((path) => {
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse({}));
      // b だけ権限不足で push 失敗させる。
      if (path === '/sync/file/b')
        return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
      // manifest push・device upsert は他の分岐にかからない限りここで一括 ok を返す。
      return Promise.resolve({ ok: true });
    });

    const onPushFile = vi.fn();
    await syncAll({
      files: [fileA, fileB],
      deviceId: 'd1',
      branch: 'main',
      onPushFile,
      onBranch: vi.fn(),
    });

    // 成功した a だけ通知される。b は握り潰されず status.error に反映される。
    expect(onPushFile).toHaveBeenCalledTimes(1);
    expect(onPushFile.mock.calls[0][0]).toBe(fileA);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().error).toMatch(/1/);
    expect(getSyncStatus().isSyncing).toBe(false);
  });

  it('リモートが新しい clean ファイルを pull する', async () => {
    const now = Date.now();
    const remoteUpdatedAt = new Date(now + 10000).toISOString();
    const file = {
      id: 'a',
      name: 'test',
      content: 'local',
      updatedAt: now - 10000,
      isDirty: false,
    };
    const remoteFileBody = {
      id: 'a',
      name: 'test',
      content: 'remote',
      updatedAt: remoteUpdatedAt,
      _sha: 's',
      _branch: 'main',
    };

    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse(makeManifest({ a: { updatedAt: remoteUpdatedAt } })));
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse(remoteFileBody));
      return Promise.resolve(makeOkResponse({}));
    });
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));
    // pull（remote だけ変わった）は adoptedHash === localHash（この端末は前回 remote と
    // 一致していた）で初めて成立する（#610）。v4 移行直後の adoptedHash 不在は conflict になる
    // 契約なので、ここでは既に同期済みの状態を明示的に用意する。
    // mockImplementationOnce（1 回限り）を使い、他のテストへ実装を漏らさない
    // （dbGet.mockImplementation は vi.clearAllMocks() 後も残るため）。
    const adoptedHash = await computeCanonicalHash(file);
    dbGet.mockImplementationOnce((store, id) =>
      Promise.resolve(store === 'syncState' && id === 'a' ? { id: 'a', adoptedHash } : undefined),
    );

    const onPullFile = vi.fn();
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onPullFile, onBranch: vi.fn() });

    expect(onPullFile).toHaveBeenCalledOnce();
    expect(onPullFile.mock.calls[0][0].content).toBe('remote');
  });

  it('conflict 時に onConflict を呼ぶ', async () => {
    const now = Date.now();
    const remoteUpdatedAt = new Date(now + 10000).toISOString();
    const file = {
      id: 'a',
      name: 'test',
      content: 'local dirty',
      updatedAt: now - 10000,
      isDirty: true,
    };
    const remoteFileBody = {
      id: 'a',
      content: 'remote',
      updatedAt: remoteUpdatedAt,
      _sha: 's',
      _branch: 'main',
    };

    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse(makeManifest({ a: { updatedAt: remoteUpdatedAt } })));
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse(remoteFileBody));
      return Promise.resolve(makeOkResponse({}));
    });
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));

    const onConflict = vi.fn();
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onConflict, onBranch: vi.fn() });

    expect(onConflict).toHaveBeenCalledOnce();
    expect(onConflict.mock.calls[0][0].local.id).toBe('a');
  });

  it('skip ファイルがあっても進捗カウンターが total を超えない', async () => {
    const now = Date.now();
    const fileA = { id: 'a', name: 'a', content: '', updatedAt: now, isDirty: true };
    const fileB = { id: 'b', name: 'b', content: '', updatedAt: now, isDirty: false };
    const olderAt = new Date(now - 10000).toISOString();

    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(
          makeOkResponse(
            makeManifest({
              a: { updatedAt: olderAt },
              b: { updatedAt: olderAt },
            }),
          ),
        );
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));

    const progressUpdates = [];
    const { onSyncStatusChange } = await import('./sync');
    const unsub = onSyncStatusChange((s) => {
      if (s.progress) progressUpdates.push({ ...s.progress });
    });
    await syncAll({ files: [fileA, fileB], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });
    unsub();

    for (const p of progressUpdates) {
      expect(p.current).toBeLessThanOrEqual(p.total);
    }
  });

  it('conflict 時は manifest を push しない', async () => {
    const now = Date.now();
    const remoteUpdatedAt = new Date(now + 10000).toISOString();
    const file = {
      id: 'a',
      name: 'test',
      content: 'local dirty',
      updatedAt: now - 10000,
      isDirty: true,
    };
    const remoteFileBody = {
      id: 'a',
      content: 'remote',
      updatedAt: remoteUpdatedAt,
      _sha: 's',
      _branch: 'main',
    };

    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse(makeManifest({ a: { updatedAt: remoteUpdatedAt } })));
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse(remoteFileBody));
      return Promise.resolve(makeOkResponse({}));
    });
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));

    await syncAll({
      files: [file],
      deviceId: 'd1',
      branch: 'main',
      onConflict: vi.fn(),
      onBranch: vi.fn(),
    });

    const manifestPush = workerFetchWithCSRF.mock.calls.filter(
      ([p, o]) => p === '/sync/manifest' && o?.method === 'PUT',
    );
    expect(manifestPush.length).toBe(0);
  });
});

describe('syncAll — quarantine 隔離 (#291)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deny remote の競合は onConflict ではなく onQuarantine を呼び、ローカルを push する', async () => {
    const now = Date.now();
    const remoteUpdatedAt = new Date(now + 10000).toISOString();
    const file = {
      id: 'a',
      name: 'test.md',
      content: 'local dirty',
      updatedAt: now - 10000,
      isDirty: true,
    };
    // バイナリ remote → validatePulledContent が deny を返す。
    const remoteFileBody = {
      id: 'a',
      name: 'test.md',
      content: '\x00\x01\x02\x03'.repeat(20),
      updatedAt: remoteUpdatedAt,
      _sha: 's',
      _branch: 'main',
    };

    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse(makeManifest({ a: { updatedAt: remoteUpdatedAt } })));
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse(remoteFileBody));
      return Promise.resolve(makeOkResponse({}));
    });
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve(makeOkResponse({})));

    const onConflict = vi.fn();
    const onQuarantine = vi.fn();
    await syncAll({
      files: [file],
      deviceId: 'd1',
      branch: 'main',
      onConflict,
      onQuarantine,
      onBranch: vi.fn(),
    });

    expect(onConflict).not.toHaveBeenCalled();
    expect(onQuarantine).toHaveBeenCalledOnce();
    expect(onQuarantine.mock.calls[0][0].id).toBe('a');
    // push 成功時は pushed=true で通知する。
    expect(onQuarantine.mock.calls[0][2]).toBe(true);
    // ローカル版を push（上書き）してループを終端する。
    const pushCalls = workerFetchWithCSRF.mock.calls.filter(
      ([p, o]) => p === '/sync/file/a' && o?.method === 'PUT',
    );
    expect(pushCalls.length).toBeGreaterThan(0);
    // blocking conflict にしないため manifest push は走る。
    const manifestPush = workerFetchWithCSRF.mock.calls.filter(
      ([p, o]) => p === '/sync/manifest' && o?.method === 'PUT',
    );
    expect(manifestPush.length).toBeGreaterThan(0);
  });

  it('隔離ファイルは localIds に合流し、remote が新しくなければ re-pull しない', async () => {
    const now = Date.now();
    // remote は古い（local 隔離 record の方が新しい）→ 再取得不要。
    const remoteUpdatedAt = new Date(now - 10000).toISOString();
    dbGet.mockResolvedValue({ id: 'q', name: 'q.md', content: '', updatedAt: now });

    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse(makeManifest({ q: { updatedAt: remoteUpdatedAt } })));
      return Promise.resolve(makeOkResponse({}));
    });
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve(makeOkResponse({})));

    const onPullFile = vi.fn();
    await syncAll({
      files: [],
      deviceId: 'd1',
      branch: 'main',
      quarantinedIds: ['q'],
      onPullFile,
      onBranch: vi.fn(),
    });

    expect(onPullFile).not.toHaveBeenCalled();
    const qFetch = workerFetch.mock.calls.filter(([p]) => p === '/sync/file/q');
    expect(qFetch.length).toBe(0);
  });

  it('隔離ファイルの remote が更新されていれば再取得・再検証する（復帰経路）', async () => {
    const now = Date.now();
    // remote が local 隔離 record より新しい → 再取得して再検証する。
    const remoteUpdatedAt = new Date(now + 10000).toISOString();
    dbGet.mockResolvedValue({ id: 'q', name: 'q.md', content: '', updatedAt: now });

    const recoveredBody = {
      id: 'q',
      name: 'q.md',
      content: '# 安全な内容に修正済み',
      updatedAt: remoteUpdatedAt,
      _sha: 's',
      _branch: 'main',
    };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse(makeManifest({ q: { updatedAt: remoteUpdatedAt } })));
      if (path === '/sync/file/q') return Promise.resolve(makeOkResponse(recoveredBody));
      return Promise.resolve(makeOkResponse({}));
    });
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve(makeOkResponse({})));

    const onPullFile = vi.fn();
    await syncAll({
      files: [],
      deviceId: 'd1',
      branch: 'main',
      quarantinedIds: ['q'],
      onPullFile,
      onBranch: vi.fn(),
    });

    expect(onPullFile).toHaveBeenCalledOnce();
    expect(onPullFile.mock.calls[0][0].id).toBe('q');
    // 再検証結果は allow（安全）。
    expect(onPullFile.mock.calls[0][1].decision).toBe('allow');
  });

  it('deny 競合の push 失敗時は成功扱いにせず manifest push を止める', async () => {
    const now = Date.now();
    const remoteUpdatedAt = new Date(now + 10000).toISOString();
    const file = {
      id: 'a',
      name: 'test.md',
      content: 'local dirty',
      updatedAt: now - 10000,
      isDirty: true,
    };
    const remoteFileBody = {
      id: 'a',
      name: 'test.md',
      content: '\x00\x01\x02\x03'.repeat(20),
      updatedAt: remoteUpdatedAt,
      _sha: 's',
      _branch: 'main',
    };

    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse(makeManifest({ a: { updatedAt: remoteUpdatedAt } })));
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse(remoteFileBody));
      return Promise.resolve(makeOkResponse({}));
    });
    // local push（PUT）を失敗させる。
    workerFetchWithCSRF.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }),
    );

    const onConflict = vi.fn();
    const onQuarantine = vi.fn();
    await syncAll({
      files: [file],
      deviceId: 'd1',
      branch: 'main',
      onConflict,
      onQuarantine,
      onBranch: vi.fn(),
    });

    expect(onConflict).not.toHaveBeenCalled();
    // push 失敗のため pushed=false で通知する。
    expect(onQuarantine).toHaveBeenCalledOnce();
    expect(onQuarantine.mock.calls[0][2]).toBe(false);
    // blocking conflict として残るため manifest push は走らない。
    const manifestPush = workerFetchWithCSRF.mock.calls.filter(
      ([p, o]) => p === '/sync/manifest' && o?.method === 'PUT',
    );
    expect(manifestPush.length).toBe(0);
  });

  // #609 round3 M1: 隔離 push は #291 の意図どおり明示的な上書きなので reconcileSha
  // （_reconcile: true）で書く。entrySha（非 reconcile）のままだと legacy entry（sha 無し）
  // では worker が create-only と判定し、既に実在する entity に対して 409 sync_entity_orphan
  // になり毎回失敗する（回復手段が無い回帰）。
  it('legacy entry（sha 無し）でも隔離 push は _reconcile: true で書き成功する', async () => {
    const now = Date.now();
    const remoteUpdatedAt = new Date(now + 10000).toISOString();
    const file = {
      id: 'a', name: 'test.md', content: 'local dirty', updatedAt: now - 10000, isDirty: true,
    };
    const remoteFileBody = {
      id: 'a', name: 'test.md', content: '\x00\x01\x02\x03'.repeat(20),
      updatedAt: remoteUpdatedAt, _sha: 'live-sha', _branch: 'main',
    };
    const bodies = {};
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        // legacy entry（sha フィールドを持たない）。
        return Promise.resolve(
          makeOkResponse(makeManifest({ a: { updatedAt: remoteUpdatedAt } }, 'main', 'm1-sha')),
        );
      }
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse(remoteFileBody));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/a' && opts?.method === 'PUT') {
        bodies.file = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'quarantine-sha' }));
      }
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        bodies.manifest = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'm2-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    const onQuarantine = vi.fn();
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onQuarantine, onBranch: vi.fn() });

    expect(bodies.file._reconcile).toBe(true);
    expect(bodies.file._sha).toBe('live-sha');
    expect(onQuarantine).toHaveBeenCalledOnce();
    expect(onQuarantine.mock.calls[0][2]).toBe(true);
    // push が成功したので manifest も commit される。
    expect(bodies.manifest).toBeDefined();
  });
});

describe('syncAll — isSyncing ガード', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('isSyncing 中は二重実行しない', async () => {
    // First call hangs on manifest fetch; resolve it with 500 after asserting
    let resolveManifest;
    workerFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveManifest = resolve;
        }),
    );

    const p1 = syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });
    // computeLocalHashes（#610）が manifest fetch の前に await を挟むため、workerFetch が
    // 実際に呼ばれるまで待つ（同一マイクロタスク内で呼ばれる前提は成り立たない）。
    await vi.waitFor(() => expect(workerFetch).toHaveBeenCalled());
    // p1 is now suspended on workerFetch; isSyncing is true

    const fetchCountBefore = workerFetch.mock.calls.length;
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });
    expect(workerFetch.mock.calls.length).toBe(fetchCountBefore); // p2 made no new fetch

    // Clean up: resolve p1 with error so isSyncing is reset to false
    resolveManifest({ ok: false, status: 500, json: () => Promise.resolve({}) });
    await p1;
  });
});

describe('syncAll — 初期化パス（404）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 3 テスト共通の /sync/init 応答（branch: 'main' の json 付き成功）。個別に literal を
  // 書くと sonarjs/no-duplicate-string が発火するため 1 箇所にまとめる。
  function mockSyncInitSuccess(path) {
    return path === '/sync/init' ? Promise.resolve(makeOkResponse({ branch: 'main' })) : null;
  }

  // manifest は 2 回書く。1 回目は entity より前の空 manifest（これが無いと、entity push 後の
  // manifest PUT が失敗したときに「entity はあるが manifest が無い」状態が残り恒久停止する）。
  it('リポジトリ未存在時に init → 空 manifest → 全ファイル push → manifest の順で呼ぶ', async () => {
    const file = { id: 'a', name: 'test', content: 'hello', updatedAt: Date.now(), isDirty: false };
    const callOrder = [];

    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeRepoMissingResponse());
      if (path === '/sync/file/a') return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve(makeOkResponse({}));
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      callOrder.push(path + (opts?.method || 'PUT'));
      const initRes = mockSyncInitSuccess(path);
      if (initRes) return initRes;
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse({}));
      // manifest PUT の応答は sha を返す（#609 A-2: 空 manifest 確定後の sha を entity push の
      // _manifestSha として使うため、GET が readable になるまで待たず PUT 応答自体から得る）。
      return Promise.resolve(makeOkResponse({ sha: 'empty-manifest-sha' }));
    });

    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const initIdx = callOrder.findIndex((c) => c.includes('/sync/init'));
    const emptyManifestIdx = callOrder.findIndex((c) => c.includes('/sync/manifest'));
    const fileIdx = callOrder.findIndex((c) => c.includes('/sync/file/a'));
    const finalManifestIdx = callOrder.findLastIndex((c) => c.includes('/sync/manifest'));
    expect(initIdx).toBeLessThan(emptyManifestIdx);
    expect(emptyManifestIdx).toBeLessThan(fileIdx);
    expect(fileIdx).toBeLessThan(finalManifestIdx);
  });

  it('初回同期（manifest 404）でも push 成功時に onPushFile を呼ぶ', async () => {
    // isDirty:false のファイルでも manifest 404（remote 未所持）なら push 対象になる。
    // 既存の init パステストは isDirty:false のファイルで検証しており、onPushFile の
    // 呼び忘れ（バッジが「同期待ち」に固着する回帰）を検出できていなかった。
    const file = { id: 'a', name: 'test', content: 'hello', updatedAt: Date.now(), isDirty: false };

    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeRepoMissingResponse());
      if (path === '/sync/file/a') return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve(makeOkResponse({}));
    });
    workerFetchWithCSRF.mockImplementation((path) => {
      const initRes = mockSyncInitSuccess(path);
      if (initRes) return initRes;
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse({}));
      // manifest PUT の応答は sha を返す（#609 A-2。空 manifest 確定後の sha を entity push の
      // _manifestSha として使う）。
      return Promise.resolve(makeOkResponse({ sha: 'empty-manifest-sha' }));
    });

    const onPushFile = vi.fn();
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onPushFile, onBranch: vi.fn() });

    expect(onPushFile).toHaveBeenCalledOnce();
    expect(onPushFile.mock.calls[0][0]).toBe(file);
  });

  it('初回同期で push が失敗したファイルがあれば status.error に件数を載せる', async () => {
    const file = { id: 'a', name: 'test', content: 'hello', updatedAt: Date.now(), isDirty: false };

    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeRepoMissingResponse());
      if (path === '/sync/file/a') return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve(makeOkResponse({}));
    });
    workerFetchWithCSRF.mockImplementation((path) => {
      const initRes = mockSyncInitSuccess(path);
      if (initRes) return initRes;
      // ファイル push（PUT）だけ失敗させる。
      if (path === '/sync/file/a')
        return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true });
    });

    const { onSyncStatusChange } = await import('./sync');
    let finalStatus = null;
    const unsub = onSyncStatusChange((s) => {
      finalStatus = s;
    });
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });
    unsub();

    expect(finalStatus.error).toMatch(/1/);
    expect(finalStatus.isSyncing).toBe(false);
  });
});

// ── init 経路の安全化 / エラー意味論（#608 A-1） ─────────────────────────────
// init は local 全ファイルを分類なしで push する破壊的経路。「manifest が無い」と確定した
// ときだけ入ることを固定する。区別できないと一時障害で remote を上書きしうる。
describe('syncAll — init 突入判定（#608）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockManifest(response) {
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(response);
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path) => {
      if (path === '/sync/init') return Promise.resolve(makeOkResponse({ branch: 'main' }));
      return Promise.resolve({ ok: true });
    });
  }

  function initCalls() {
    return workerFetchWithCSRF.mock.calls.filter(([p]) => p === '/sync/init');
  }

  it.each([['sync_repo_missing'], ['sync_manifest_missing']])(
    'remote 不在が確定した 404（%s）では init に入る',
    async (code) => {
      mockManifest({ ok: false, status: 404, json: () => Promise.resolve({ code }) });

      await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

      expect(initCalls()).toHaveLength(1);
    },
  );

  it.each([
    ['code なしの 404', { ok: false, status: 404, json: () => Promise.resolve({}) }],
    [
      '未知 code の 404',
      { ok: false, status: 404, json: () => Promise.resolve({ code: 'sync_repo_missing_x' }) },
    ],
    [
      '本文が JSON でない 404',
      { ok: false, status: 404, json: () => Promise.reject(new Error('not json')) },
    ],
    [
      '権限不足（403）',
      { ok: false, status: 403, json: () => Promise.resolve({ code: 'sync_forbidden' }) },
    ],
    [
      '上流障害（502）',
      { ok: false, status: 502, json: () => Promise.resolve({ code: 'sync_upstream_error' }) },
    ],
    [
      'サーバー障害（500）',
      { ok: false, status: 500, json: () => Promise.resolve({ code: 'sync_server_error' }) },
    ],
  ])('%s では init に入らない', async (_label, response) => {
    mockManifest(response);

    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(initCalls()).toHaveLength(0);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().error).toBeTruthy();
    expect(getSyncStatus().isSyncing).toBe(false);
  });

  it('manifest 取得の競合・障害は category 別のメッセージになる', async () => {
    const { getSyncStatus } = await import('./sync');

    mockManifest({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ code: 'sync_conflict' }),
    });
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });
    const conflict = getSyncStatus();

    mockManifest({
      ok: false,
      status: 502,
      json: () => Promise.resolve({ code: 'sync_upstream_error' }),
    });
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });
    const upstream = getSyncStatus();

    expect(conflict.errorCategory).toBe('conflict');
    expect(upstream.errorCategory).toBe('upstream');
    expect(conflict.error).not.toBe(upstream.error);
  });

  it('422 は conflict ではなく validation として扱う', async () => {
    mockManifest({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ code: 'sync_unprocessable' }),
    });

    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('unprocessable');
  });

  it('manifest が存在する通常経路では init に入らない', async () => {
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifest()));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));

    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(initCalls()).toHaveLength(0);
  });

  it('manifest の _sha が無い通常経路は無条件 create せず失敗させる', async () => {
    // remote manifest は存在するのに expected SHA が取れていない状態。ここで sha なし
    // write に倒れると、他端末の snapshot を上書きする経路が復活する。
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse({ version: 2, _branch: 'main', files: {} }));
      return Promise.resolve({ ok: false, status: 404 });
    });
    const seen = [];
    workerFetchWithCSRF.mockImplementation((path) => {
      seen.push(path);
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(seen).not.toContain('/sync/manifest');
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().error).toBeTruthy();
  });

  it('push 失敗の代表 category を status に載せる', async () => {
    const file = { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifest()));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path) => {
      if (path === '/sync/file/a')
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ code: 'sync_conflict' }),
        });
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('conflict');
    expect(getSyncStatus().error).toMatch(/1/);
    // 理由は errorCategory 側が持つ。文言へ二重に埋め込まない（表示は SyncBadge が決める）。
    expect(getSyncStatus().error).not.toContain('競合');
  });
});

// ── formatVersion による読み取り専用の早期中止（#609 A-2） ──────────────────
// remote が this client の capability を超える formatVersion を宣言していたら、
// push/pull/manifest write のいずれも行わず中止する（内容を理解できないまま書き戻さない）。
describe('syncAll — formatVersion 超過は読み取り専用の中止にする（#609）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockManifestVersion(version) {
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse({ version, _branch: 'main', _sha: 'sha1', files: {} }));
      return Promise.resolve({ ok: false, status: 404 });
    });
  }

  it('remote の formatVersion が既知安全域を超えていれば push/pull/manifest write を一切行わない', async () => {
    mockManifestVersion(4);
    const localFile = { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true };
    const csrfCalls = [];
    workerFetchWithCSRF.mockImplementation((path) => {
      csrfCalls.push(path);
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [localFile], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    // push・manifest write・device upsert のいずれも呼ばれていないこと。
    expect(csrfCalls).toHaveLength(0);
  });

  // v3 で files の形状自体が変わっていても（配列化・削除等）、formatVersion 中止は発火する
  // 必要がある（#609・Codex 指摘）。files 検証が先に corrupt を投げると中止フラグに
  // 到達しないため、この統合テストで実際の中止経路を確認する。
  it('remote の files 形状が v2 と異なっていても、formatVersion 超過なら push/pull/manifest write を一切行わない', async () => {
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        // #394 C-1: FORMAT_CAPABILITY_VERSION は 3 になったため、これを超える値（4）を使う。
        return Promise.resolve(
          makeOkResponse({ version: 4, _branch: 'main', _sha: 'sha1', files: [{ id: 'x' }] }),
        );
      return Promise.resolve({ ok: false, status: 404 });
    });
    const localFile = { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true };
    const csrfCalls = [];
    workerFetchWithCSRF.mockImplementation((path) => {
      csrfCalls.push(path);
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [localFile], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(csrfCalls).toHaveLength(0);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('protocol_upgrade_required');

    // syncFile 経由の entity write も同様にブロックされること（gate 素通り再発防止）。
    vi.clearAllMocks();
    const result = await syncFileSilent(localFile, 'main');
    expect(result).toBeNull();
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('remote の formatVersion が既知安全域を超えていれば errorCategory が protocol_upgrade_required になる', async () => {
    mockManifestVersion(4);
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));

    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('protocol_upgrade_required');
    expect(getSyncStatus().isSyncing).toBe(false);
  });

  it('remote の formatVersion が既知安全域を超えていれば lastSyncedAt を進めない', async () => {
    mockManifestVersion(4);
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));

    const { getSyncStatus } = await import('./sync');
    const before = getSyncStatus().lastSyncedAt;

    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(getSyncStatus().lastSyncedAt).toBe(before);
  });

  // 回帰防止：remote が version 2（既存の唯一の実装済み version）なら中止しない。
  it('remote の formatVersion が 2 なら通常どおり同期する（回帰防止）', async () => {
    mockManifestVersion(2);
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));

    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).not.toBe('protocol_upgrade_required');
  });

  // version 欠落・非整数は LEGACY_DEFAULT_FORMAT_VERSION(2) に倒すため中止しない（buildRemoteMap の既定値と一致）。
  it.each([[undefined], ['3'], [2.5]])(
    'version が%sなら安全側の既定値(2)として扱い中止しない',
    async (version) => {
      workerFetch.mockImplementation((path) => {
        if (path === '/sync/manifest')
          return Promise.resolve(makeOkResponse({ version, _branch: 'main', _sha: 'sha1', files: {} }));
        return Promise.resolve({ ok: false, status: 404 });
      });
      workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));

      await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

      const { getSyncStatus } = await import('./sync');
      expect(getSyncStatus().errorCategory).not.toBe('protocol_upgrade_required');
    },
  );
});

// ── syncFile 単独呼び出し経路も formatVersion gate で止まること（#609・敵対的レビュー由来） ──
// syncAll の中止は syncAll という 1 経路だけを止める一方、AppContext.jsx の debounce autosave
// （syncFileSilent）・conflict 採用時の push は syncAll を経由せず syncFile を直接呼ぶ。
// これらが manifest を読まないまま entity write を続けると、gate の「read-only に倒す」
// 意図が entity 経路では素通りになる（v2 形状の上書きが v3 entity を破壊しうる）。
describe('syncFile / syncFileSilent — syncAll の formatVersion 中止後は単独呼び出しも止まる（#609）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockManifestVersion(version) {
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse({ version, _branch: 'main', _sha: 'sha1', files: {} }));
      return Promise.resolve({ ok: false, status: 404 });
    });
  }

  it('syncAll が formatVersion 超過で中止した後、syncFile を直接呼んでも通信せず拒否する', async () => {
    mockManifestVersion(4);
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    vi.clearAllMocks();
    const file = { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true };
    await expect(syncFile(file, 'main')).rejects.toThrow();

    // GET/PUT のいずれも発生しない（remote の状態を理解できないため読み取りすら行わない）。
    expect(workerFetch).not.toHaveBeenCalled();
    expect(workerFetchWithCSRF).not.toHaveBeenCalled();
  });

  it('syncAll が formatVersion 超過で中止した後、syncFileSilent は null を返し通信しない', async () => {
    mockManifestVersion(4);
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    vi.clearAllMocks();
    const file = { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true };
    const result = await syncFileSilent(file, 'main');

    expect(result).toBeNull();
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('remote が既知安全域に戻れば syncFile のブロックも解除される', async () => {
    mockManifestVersion(4);
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    // remote が version 2 へ戻った（手編集の巻き戻し等）状態で syncAll を再実行する。
    mockManifestVersion(2);
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    vi.clearAllMocks();
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/file/a') return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve(makeOkResponse({})));

    const file = { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true };
    const result = await syncFileSilent(file, 'main');

    // ブロック解除後は通常どおり push でき、失敗しない。
    expect(result).not.toBeNull();
  });

  // manifest/repo が削除され再作成された場合、次の syncAll は 200 の通常経路ではなく
  // 404→init 経路を通る。init 経路も解除しないと、ブロックが次の通常同期まで
  // 無関係に残り続ける（Codex レビュー指摘・P2）。
  it('remote の manifest/repo が削除され init 経路に入った場合もブロックが解除される', async () => {
    mockManifestVersion(4);
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    // repo/manifest が削除・再作成され、次回は「manifest 不在」の 404 になった。
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ code: 'sync_manifest_missing' }),
        });
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path) => {
      if (path === '/sync/init') return Promise.resolve(makeOkResponse({ branch: 'main' }));
      return Promise.resolve({ ok: true });
    });
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    vi.clearAllMocks();
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/file/a') return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve(makeOkResponse({})));

    const file = { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true };
    const result = await syncFileSilent(file, 'main');

    expect(result).not.toBeNull();
  });

  // init が失敗した場合、一時的に解除したブロックを元に戻す（Codex レビュー指摘）。
  // 「manifest 不在」を確認した時点と実際に init が完了する時点の間に別端末が
  // 未知 formatVersion を書く窓が残るため、init が完走しなかった以上は
  // 「remote は安全」と確定できない。
  it('init 経路に入った後 init 自体が失敗すれば、ブロックは元に戻る', async () => {
    mockManifestVersion(4);
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    // manifest は不在（init 経路）だが、POST /sync/init 自体が失敗する。
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ code: 'sync_manifest_missing' }),
        });
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path) => {
      if (path === '/sync/init')
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true });
    });
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    vi.clearAllMocks();
    const file = { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true };
    const result = await syncFileSilent(file, 'main');

    // init が完走しなかった以上、entity write は引き続きブロックされる。
    expect(result).toBeNull();
    expect(workerFetch).not.toHaveBeenCalled();
  });

  // manifest read 時点では既知安全域内でも、同期の途中（他端末が並行して formatVersion を
  // 引き上げた等）で最終 manifest PUT が worker の 426 に弾かれることがある（Codex レビュー
  // 指摘）。その場合も以後の entity write をブロックする。
  it('manifest read は v2 でも、最終 manifest PUT が 426 で拒否されればブロックをラッチする', async () => {
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse({ version: 2, _branch: 'main', _sha: 'sha1', files: {} }));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve({
          ok: false,
          status: 426,
          json: () => Promise.resolve({ code: 'sync_protocol_upgrade_required' }),
        });
      }
      return Promise.resolve({ ok: true });
    });
    const localFile = { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true };
    await syncAll({ files: [localFile], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('protocol_upgrade_required');

    vi.clearAllMocks();
    const result = await syncFileSilent(localFile, 'main');
    expect(result).toBeNull();
    expect(workerFetch).not.toHaveBeenCalled();
  });

  // 以前に v3 を検出した状態（ブロック中）で manifest 404 → init 経路に入った場合、
  // runInitSync 自身の entity push は internal オプションで通す必要があるが、その await 中に
  // debounce autosave 等の外部呼び出し（syncFileSilent）が並行して来ても、init 専用の
  // internal フラグを持たない以上、常にブロックされ続けなければならない
  // （src/lib/sync.js の #609 レビュースレッド）。
  it('init 中に外部から syncFileSilent を並行呼び出しすると block されるが、init 自身の push は通る（#609）', async () => {
    mockManifestVersion(4);
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    vi.clearAllMocks();

    // repo/manifest が削除・再作成され、次回は「manifest 不在」の 404 になった（init 経路）。
    let concurrentResultPromise = null;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeRepoMissingResponse());
      if (path === '/sync/file/a') {
        // runInitSync 自身が「a」の不在確認をしている、まさにその await 中に、外部から
        // 無関係な別ファイル「other」への debounce autosave が並行して来た状況を模す。
        const otherFile = { id: 'other', name: 'o', content: 'x', updatedAt: Date.now(), isDirty: true };
        concurrentResultPromise = syncFileSilent(otherFile, 'main');
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path) => {
      if (path === '/sync/init') return Promise.resolve(makeOkResponse({ branch: 'main' }));
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse({}));
      // manifest PUT の応答は sha を返す（#609 A-2。空 manifest 確定後の sha を entity push の
      // _manifestSha として使うため、GET が readable になるまで待たない）。
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse({ sha: 'empty-manifest-sha' }));
      return Promise.resolve(makeOkResponse({}));
    });

    const file = { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true };
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    // init 自身の push（内部呼び出し）は internal フラグでガードを迂回でき、完走している
    // （workerFetchWithCSRF で /sync/file/a への PUT が呼ばれている = 例外を投げていない）。
    expect(workerFetchWithCSRF).toHaveBeenCalledWith('/sync/file/a', expect.anything());

    // 一方、init と並行して来た外部呼び出しは internal を持たないため、グローバルフラグが
    // まだ true の間は通信すら発生させずに拒否される（null を返す）。
    expect(concurrentResultPromise).not.toBeNull();
    const concurrentResult = await concurrentResultPromise;
    expect(concurrentResult).toBeNull();
  });
});

// ── init / snapshot 成立の安全性（#608・敵対的レビュー由来） ──────────────────
// いずれも「実行して初めて見えた」経路。修正前は data loss か false「同期済み」になる。
describe('syncAll — snapshot 成立の安全性', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // _status はモジュールレベルで前テストの lastSyncedAt を持ち越すため、絶対値ではなく
  // 「この同期で進まなかったこと」を見る。
  async function lastSyncedAt() {
    const { getSyncStatus } = await import('./sync');
    return getSyncStatus().lastSyncedAt ?? null;
  }

  function manifestMissing() {
    return {
      ok: false,
      status: 404,
      json: () => Promise.resolve({ code: 'sync_manifest_missing' }),
    };
  }

  // init は「remote に manifest が無い」を前提に全件 push する。前提が崩れた（他端末の
  // manifest が現れた）ときに local のみの一覧で上書きすると、他端末の entry が消える。
  it('repo が既存で init 中に manifest が現れたら上書きせず中止する', async () => {
    let manifestReads = 0;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        manifestReads += 1;
        // 1 回目: 不在 → init へ。2 回目（push 後）: 他端末の manifest が存在。
        if (manifestReads === 1) return Promise.resolve(manifestMissing());
        return Promise.resolve(
          makeOkResponse({ version: 2, _branch: 'main', _sha: 'otherSha', files: { other: {} } }),
        );
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path) => {
      puts.push(path);
      // created:false = repo は既に存在していた（他端末が作った）
      if (path === '/sync/init')
        return Promise.resolve(makeOkResponse({ branch: 'main', created: false }));
      return Promise.resolve({ ok: true });
    });

    const file = { id: 'mine', name: 'mine', content: 'x', updatedAt: Date.now(), isDirty: true };
    const before = await lastSyncedAt();
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(puts).not.toContain('/sync/manifest');
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('workspace_inconsistent');
    expect(await lastSyncedAt()).toBe(before);
  });

  // entity を push した後に manifest PUT が失敗すると、「entity はあるが manifest が無い」
  // 状態が残り、次回以降は workspace_inconsistent で init に再突入できず恒久停止する。
  // 空 manifest を entity より先に確定させておけば、次回は通常同期の経路で回復できる。
  it('本体の manifest PUT が失敗しても空 manifest は remote に残る', async () => {
    workerFetch.mockImplementation((path) =>
      Promise.resolve(path === '/sync/manifest' ? manifestMissing() : { ok: false, status: 404 }),
    );
    const manifestWrites = [];
    let manifestPutCount = 0;
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/init')
        return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
      if (path === '/sync/manifest') {
        manifestPutCount += 1;
        manifestWrites.push(JSON.parse(opts.body));
        // 1 回目（空 manifest）は成功、2 回目（本体）は 429 で失敗させる
        if (manifestPutCount === 1)
          return Promise.resolve(makeOkResponse({ ok: true, sha: 'empty-sha' }));
        return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: true });
    });

    const file = { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true };
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    // 空 manifest は entity より先に書かれている（= 恒久停止しない）
    expect(manifestWrites[0].files).toEqual({});
    expect(manifestWrites[0].fileOrder).toEqual([]);
    expect(manifestPutCount).toBe(2);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('upstream');
  });

  // manifest の事前確認から個々の entity push までの間に、別端末が同じ id の entity を
  // 作る窓が残る。manifest の CAS は index しか守らないため、そこを上書きすると別端末の
  // 本文が失われ、最後の manifest PUT だけが 409 になる。init は create-only で push する。
  it('init 中に同じ id の entity が現れたら上書きせず中止する', async () => {
    let manifestReads = 0;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        manifestReads += 1;
        if (manifestReads === 1) return Promise.resolve(manifestMissing());
        return Promise.resolve(
          makeOkResponse({ version: 2, _branch: 'main', _sha: 'empty-sha', files: {} }),
        );
      }
      // 別端末が先に同じ id の entity を作った状態
      if (path === '/sync/file/a')
        return Promise.resolve(
          makeOkResponse({ id: 'a', name: 'a', content: 'theirs', _sha: 'their-sha' }),
        );
      return Promise.resolve({ ok: false, status: 404 });
    });
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path) => {
      puts.push(path);
      if (path === '/sync/init')
        return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse({ ok: true, sha: 'empty-sha' }));
      return Promise.resolve({ ok: true });
    });

    const file = { id: 'a', name: 'a', content: 'mine', updatedAt: Date.now(), isDirty: true };
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    // 別端末の本文を上書きしない
    expect(puts.filter((p) => p === '/sync/file/a')).toHaveLength(0);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('workspace_inconsistent');
  });

  // remote 由来の辞書を生の JSON.parse オブジェクトのまま引くと、`__proto__` のような id で
  // 継承値（Object.prototype）が返り、実在しない entity の manifest entry を合成できる。
  it('__proto__ の隔離 id で存在しない entry を合成しない', async () => {
    workerFetch.mockImplementation((path) =>
      Promise.resolve(
        path === '/sync/manifest'
          ? makeOkResponse({ version: 2, _branch: 'main', _sha: 'sha1', files: {} })
          : { ok: false, status: 404 },
      ),
    );
    const bodies = {};
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      bodies[path] = opts?.body ? JSON.parse(opts.body) : null;
      return Promise.resolve({ ok: true });
    });

    await syncAll({
      files: [],
      deviceId: 'd1',
      branch: 'main',
      onBranch: vi.fn(),
      quarantinedIds: ['__proto__'],
    });

    const written = bodies['/sync/manifest'];
    expect(Object.keys(written.files)).not.toContain('__proto__');
    expect(written.fileOrder).not.toContain('__proto__');
  });

  // repoCreated だけを根拠にすると、init 直後・再取得までの間に別端末がその空 manifest を
  // 基に通常同期を完了した場合、その manifest を「自分が作った空 manifest」とみなして
  // local のみの一覧で上書きし、別端末の entry が消える（CAS は成功してしまう）。
  it('init 中に別端末が manifest を進めていたら上書きせず中止する', async () => {
    let manifestReads = 0;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        manifestReads += 1;
        if (manifestReads === 1) return Promise.resolve(manifestMissing());
        // 別端末が空 manifest を基に同期を完了した状態
        return Promise.resolve(
          makeOkResponse({
            version: 2,
            _branch: 'main',
            _sha: 'otherSha',
            files: { other: { id: 'other' } },
          }),
        );
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path) => {
      puts.push(path);
      if (path === '/sync/init')
        return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
      return Promise.resolve({ ok: true });
    });

    const file = { id: 'mine', name: 'mine', content: 'x', updatedAt: Date.now(), isDirty: true };
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(puts).not.toContain('/sync/manifest');
    // entity も push しない（write 先の解決は push より前）
    expect(puts.filter((p) => p.startsWith('/sync/file/'))).toHaveLength(0);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('workspace_inconsistent');
  });

  it('init が repo を作成した場合は自分が作った manifest を更新する', async () => {
    let manifestReads = 0;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        manifestReads += 1;
        if (manifestReads === 1) return Promise.resolve(manifestMissing());
        return Promise.resolve(
          makeOkResponse({ version: 2, _branch: 'main', _sha: 'ownSha', files: {} }),
        );
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const bodies = {};
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      bodies[path] = opts?.body ? JSON.parse(opts.body) : null;
      if (path === '/sync/init')
        return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
      return Promise.resolve({ ok: true });
    });

    const file = { id: 'mine', name: 'mine', content: 'x', updatedAt: Date.now(), isDirty: true };
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(bodies['/sync/manifest']._sha).toBe('ownSha');
  });

  // manifest が指すのに remote に存在しない entry を作らない（他端末が毎回 pull に失敗する）。
  // かといって manifest を書かずに終えると、次回は entity だけが存在する状態になって
  // worker が workspace_inconsistent を返し、init に再突入できず恒久停止する。
  // 成功分だけを載せた manifest なら remote の実体と一致し、残りは次回の通常同期が push する。
  it('init 中に push が一部失敗したら成功分だけの manifest を書く', async () => {
    workerFetch.mockImplementation((path) =>
      Promise.resolve(path === '/sync/manifest' ? manifestMissing() : { ok: false, status: 404 }),
    );
    const bodies = {};
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/init')
        return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
      if (path === '/sync/file/b')
        return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
      bodies[path] = opts?.body ? JSON.parse(opts.body) : null;
      // manifest PUT の応答は sha を返す（#609 A-2。空 manifest 確定後の sha を entity push の
      // _manifestSha として使うため、GET が readable になるまで待たない）。
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse({ sha: 'empty-manifest-sha' }));
      return Promise.resolve({ ok: true });
    });

    const files = [
      { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true },
      { id: 'b', name: 'b', content: 'y', updatedAt: Date.now(), isDirty: true },
    ];
    const before = await lastSyncedAt();
    await syncAll({ files, deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const written = bodies['/sync/manifest'];
    expect(Object.keys(written.files)).toEqual(['a']);
    expect(written.fileOrder).toEqual(['a']);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().error).toBeTruthy();
    // 未 push が残る回なので「同期済み」にはしない。
    expect(await lastSyncedAt()).toBe(before);
  });

  // pull だけが失敗した回は push 失敗が 0 件。件数を push 失敗だけで数えると error=null に
  // なり、前回の lastSyncedAt が緑のまま残って「成功」に見える（snapshot は未成立）。
  it('pull だけが失敗した回も失敗として表示する', async () => {
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(
          makeOkResponse({
            version: 2,
            _branch: 'main',
            _sha: 'sha1',
            files: { remoteOnly: { id: 'remoteOnly', updatedAt: new Date().toISOString() } },
          }),
        );
      if (path === '/sync/file/remoteOnly')
        return Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.resolve({ code: 'sync_upstream_error' }),
        });
      return Promise.resolve({ ok: false, status: 404 });
    });
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path) => {
      puts.push(path);
      return Promise.resolve({ ok: true });
    });

    const before = await lastSyncedAt();
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().error).toBeTruthy();
    expect(getSyncStatus().errorCategory).toBe('upstream');
    expect(puts).not.toContain('/sync/manifest');
    expect(await lastSyncedAt()).toBe(before);
  });

  // 隔離ファイル（#291）は files / nextFiles に入らないため、素朴に manifest を作ると
  // 「完全成功」の snapshot から entry が消え、全端末のファイル一覧から見えなくなる。
  it('隔離ファイルの manifest entry を落とさない', async () => {
    const remoteEntry = {
      id: 'q1',
      name: 'q1',
      updatedAt: new Date(0).toISOString(),
      github: null,
    };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(
          makeOkResponse({ version: 2, _branch: 'main', _sha: 'sha1', files: { q1: remoteEntry } }),
        );
      return Promise.resolve({ ok: false, status: 404 });
    });
    const bodies = {};
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      bodies[path] = opts?.body ? JSON.parse(opts.body) : null;
      return Promise.resolve({ ok: true });
    });

    await syncAll({
      files: [],
      deviceId: 'd1',
      branch: 'main',
      onBranch: vi.fn(),
      quarantinedIds: ['q1'],
    });

    expect(Object.keys(bodies['/sync/manifest'].files)).toContain('q1');
    expect(bodies['/sync/manifest'].fileOrder).toContain('q1');
  });

  // 隔離 push（deny remote をローカル版で上書きする経路）の失敗理由を捨てると、
  // SyncBadge は権限・サイズ超過・一時制限を表示できず、汎用の「次回の同期で再試行」が
  // 再試行不能な 413 にも出てしまう。
  it('隔離 push の失敗 category を status に載せる', async () => {
    const now = Date.now();
    const remoteMeta = { id: 'a', updatedAt: new Date(now + 10000).toISOString() };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(
          makeOkResponse({ version: 2, _branch: 'main', _sha: 'sha1', files: { a: remoteMeta } }),
        );
      if (path === '/sync/file/a')
        return Promise.resolve(
          makeOkResponse({
            id: 'a',
            name: 'a',
            // 非文字列 content は deny 確定（validatePulledContent）。
            content: { evil: true },
            updatedAt: remoteMeta.updatedAt,
          }),
        );
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path) => {
      if (path === '/sync/file/a')
        return Promise.resolve({ ok: false, status: 413, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true });
    });

    const local = { id: 'a', name: 'a', content: 'mine', updatedAt: now, isDirty: true };
    await syncAll({
      files: [local],
      deviceId: 'd1',
      branch: 'main',
      onBranch: vi.fn(),
      onQuarantine: vi.fn(),
    });

    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('too_large');
  });

  // 手編集された manifest（Git 管理の可読ファイル）で files が dict でない場合、
  // Object.keys が '0','1',… を id として返し全件 pull 404 になる。
  it.each([
    ['配列', []],
    ['文字列', 'abc'],
    ['数値', 3],
  ])('remote manifest の files が %s なら corrupt として止める', async (_label, files) => {
    workerFetch.mockImplementation((path) =>
      Promise.resolve(
        path === '/sync/manifest'
          ? makeOkResponse({ version: 2, _branch: 'main', _sha: 'sha1', files })
          : { ok: false, status: 404 },
      ),
    );
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));

    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('corrupt');
  });
});

// ── init の到達可能性と carryOver の健全性（#608・敵対的3周目由来） ────────────
describe('syncAll — init が manifest を書けること / carryOver の検証', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // manifest の write 先を entity push の「後」に決めると、自分が作った entity のせいで
  // worker の entity 実在確認が必ず true になり workspace_inconsistent が返る。
  // その結果 manifest を永久に書けず、以後すべての端末のすべての同期が停止する。
  it('repo 既存・manifest 不在・entity なしから init が manifest を書き切る', async () => {
    let pushedEntities = 0;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        // worker の意味論を写す: entity が 1 件でもあれば workspace_inconsistent。
        const code = pushedEntities > 0 ? 'sync_workspace_inconsistent' : 'sync_manifest_missing';
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ code }) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path) => {
      puts.push(path);
      if (path === '/sync/init')
        return Promise.resolve(makeOkResponse({ branch: 'main', created: false }));
      if (path.startsWith('/sync/file/')) pushedEntities += 1;
      // manifest PUT の応答は sha を返す（#609 A-2。GET が readable になるまで manifest GET が
      // 常に 404 のこのテストでも、PUT 応答自体から空 manifest の sha を得て entity push の
      // _manifestSha に使う）。
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse({ sha: 'empty-manifest-sha' }));
      return Promise.resolve({ ok: true });
    });

    const file = { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true };
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(puts).toContain('/sync/manifest');
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().error).toBeNull();
  });

  it('init 前から他端末の entity があれば push せず中止する', async () => {
    workerFetch.mockImplementation((path) =>
      Promise.resolve(
        path === '/sync/manifest'
          ? {
              ok: false,
              status: 404,
              json: () => Promise.resolve({ code: 'sync_workspace_inconsistent' }),
            }
          : { ok: false, status: 404 },
      ),
    );
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path) => {
      puts.push(path);
      return Promise.resolve({ ok: true });
    });

    const file = { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true };
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    // init 経路にも通常経路にも入らず、entity を 1 件も push しない。
    expect(puts.filter((p) => p.startsWith('/sync/file/'))).toHaveLength(0);
    expect(puts).not.toContain('/sync/manifest');
  });

  // remote の entry は key と独立に id を名乗れる。無検証で書き戻すと、隔離とは無関係の
  // ファイルの entry を上書きでき、しかも自分で書き戻すので汚染が永続化する。
  it('carryOver は隔離 id をキーにし、entry の自称 id を使わない', async () => {
    const remoteFiles = {
      // updatedAt は epoch 0（隔離ファイルの復帰 re-pull を誘発させない）。
      q1: { id: 'victim', name: '乗っ取り', updatedAt: new Date(0).toISOString() },
      victim: { id: 'victim', name: '正規', updatedAt: new Date(0).toISOString() },
    };
    workerFetch.mockImplementation((path) =>
      Promise.resolve(
        path === '/sync/manifest'
          ? makeOkResponse({ version: 2, _branch: 'main', _sha: 'sha1', files: remoteFiles })
          : { ok: false, status: 404 },
      ),
    );
    const bodies = {};
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      bodies[path] = opts?.body ? JSON.parse(opts.body) : null;
      return Promise.resolve({ ok: true });
    });

    const victim = {
      id: 'victim',
      name: '正規',
      content: 'x',
      updatedAt: Date.now(),
      isDirty: true,
    };
    await syncAll({
      files: [victim],
      deviceId: 'd1',
      branch: 'main',
      onBranch: vi.fn(),
      quarantinedIds: ['q1'],
    });

    const written = bodies['/sync/manifest'];
    expect(written.files.victim.name).toBe('正規');
    expect(written.files.q1).toBeDefined();
    expect(written.fileOrder.filter((id) => id === 'victim')).toHaveLength(1);
  });

  it.each([
    ['id なし', { name: 'x', updatedAt: new Date(0).toISOString() }],
    ['配列', []],
    ['null', null],
  ])('壊れた隔離 entry（%s）で files["undefined"] を書かない', async (_label, entry) => {
    workerFetch.mockImplementation((path) =>
      Promise.resolve(
        path === '/sync/manifest'
          ? makeOkResponse({ version: 2, _branch: 'main', _sha: 'sha1', files: { q1: entry } })
          : { ok: false, status: 404 },
      ),
    );
    const bodies = {};
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      bodies[path] = opts?.body ? JSON.parse(opts.body) : null;
      return Promise.resolve({ ok: true });
    });

    await syncAll({
      files: [],
      deviceId: 'd1',
      branch: 'main',
      onBranch: vi.fn(),
      quarantinedIds: ['q1'],
    });

    const written = bodies['/sync/manifest'];
    expect(Object.keys(written.files)).not.toContain('undefined');
    expect(written.fileOrder).not.toContain(null);
  });
});

// init は「remote に自分以外の snapshot が無い」ことを前提に全件を分類なしで push する。
// その前提が個々の entity で崩れた（既に存在する / 存在を確認できない）とき、それを
// 部分失敗として飲み込んで manifest を確定させると、その id を **含まない** snapshot が
// 成立する。次回同期では manifest に無い = push と判定され、今度は expectAbsent の無い
// 通常経路が別端末の entity の SHA を取得して本文を上書きする（データ喪失）。
// 応答形状の不正を「通信エラー」として案内すると、remote / client の破損が障害に紛れて
// 誰にも気づかれない（#608）。fetch は成功しているので network ではない。
describe('syncAll — 応答形状の不正を通信エラーにしない（#608）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['HTTP 200 で null', null],
    ['files が配列', { files: [] }],
    ['files が欠落', { _branch: 'main' }],
  ])('manifest が %s なら corrupt として止める', async (_label, body) => {
    workerFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) }),
    );
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));

    await syncAll({ files: [], deviceId: 'd1', branch: 'main' });

    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('corrupt');
  });

});

describe('syncAll — init の create-only 違反は中止する（#608）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockInit(fileGet) {
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ code: 'sync_manifest_missing' }),
        });
      if (path.startsWith('/sync/file/')) return Promise.resolve(fileGet(path.slice(11)));
      return Promise.resolve({ ok: false, status: 404 });
    });
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/init')
        return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
      puts.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
      return Promise.resolve(makeOkResponse({ sha: 'sha-empty' }));
    });
    return puts;
  }

  const local = (id) => ({ id, name: id, content: 'local', updatedAt: Date.now(), isDirty: true });

  it('別端末が同じ id の entity を作っていたら entity も manifest も書かない', async () => {
    const puts = mockInit((id) =>
      id === 'a'
        ? makeOkResponse({ id: 'a', name: 'a', content: '他端末の本文', _sha: 'sha-a' })
        : { ok: false, status: 404 },
    );

    const { getSyncStatus: before } = await import('./sync');
    const lastSyncedAtBefore = before().lastSyncedAt;
    await syncAll({ files: [local('a'), local('b')], deviceId: 'd1', branch: 'main' });

    expect(puts.filter((p) => p.path === '/sync/file/a')).toHaveLength(0);
    // 空 manifest の確定（create）だけは許される。衝突後の本体 manifest は書かない。
    const manifestWrites = puts.filter((p) => p.path === '/sync/manifest');
    expect(manifestWrites).toHaveLength(1);
    expect(Object.keys(manifestWrites[0].body.files)).toEqual([]);

    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('workspace_inconsistent');
    // 中止した回は「同期済み」にしない（false 同期済みの防止）。
    expect(getSyncStatus().lastSyncedAt).toBe(lastSyncedAtBefore);
  });

  // 不在を確認できなかった場合も同じ。「無かった」と決めつけて manifest を確定させると
  // 次回同期が同じ上書き経路へ入る。
  it.each([
    [500, 'server'],
    [502, 'upstream'],
    [403, 'forbidden'],
  ])('不在確認が status %d で失敗したら manifest を書かない', async (status, expected) => {
    const puts = mockInit((id) =>
      id === 'a' ? { ok: false, status, json: () => Promise.resolve({}) } : { ok: false, status: 404 },
    );

    await syncAll({ files: [local('a'), local('b')], deviceId: 'd1', branch: 'main' });

    expect(puts.filter((p) => p.path === '/sync/manifest')).toHaveLength(1);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe(expected);
  });

  // 不在確認（GET）と create（PUT）の間にも窓が残る。その間に別端末が同じ id を作ると
  // SHA なしの PUT が create-only 違反で拒否される（GitHub は 422、経路により 409）。
  // これを部分失敗として飲み込むと、GET 側と同じく id を欠いた manifest が確定する。
  it.each([
    [409, 'sync_conflict', 'conflict'],
    [422, 'sync_unprocessable', 'unprocessable'],
  ])('create PUT が %d で拒否され entity の実在を確認できたら manifest を書かない', async (
    status,
    code,
    expected,
  ) => {
    // 不在確認の GET は 404（この時点では未作成）、拒否後の再確認では実在する。
    let seen = 0;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ code: 'sync_manifest_missing' }),
        });
      if (path === '/sync/file/a') {
        seen += 1;
        return Promise.resolve(seen === 1 ? { ok: false, status: 404 } : { ok: true, status: 200 });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/init')
        return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
      puts.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
      if (path === '/sync/file/a')
        return Promise.resolve({ ok: false, status, json: () => Promise.resolve({ code }) });
      return Promise.resolve(makeOkResponse({ sha: 'sha-empty' }));
    });

    await syncAll({ files: [local('a'), local('b')], deviceId: 'd1', branch: 'main' });

    // 空 manifest の確定だけ。衝突後の本体 manifest は書かない。
    expect(puts.filter((p) => p.path === '/sync/manifest')).toHaveLength(1);
    // 中止なので後続ファイルの push も行わない。
    expect(puts.filter((p) => p.path === '/sync/file/b')).toHaveLength(0);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe(expected);
  });

  // 422 は create-only 違反だけでなく一般の validation failure でも返る。status だけを
  // 実在の確証にすると、1 ファイルの検証エラーで init 全体が毎回中止し、正常な他ファイルが
  // 一度も snapshot に載らなくなる。実在を確認できない 422 は部分失敗として続行する。
  it('create PUT が 422 でも entity が実在しなければ部分失敗として続行する', async () => {
    workerFetch.mockImplementation((path) =>
      Promise.resolve(
        path === '/sync/manifest'
          ? {
              ok: false,
              status: 404,
              json: () => Promise.resolve({ code: 'sync_manifest_missing' }),
            }
          : { ok: false, status: 404 },
      ),
    );
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/init')
        return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
      puts.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
      if (path === '/sync/file/a')
        return Promise.resolve({
          ok: false,
          status: 422,
          json: () => Promise.resolve({ code: 'sync_unprocessable' }),
        });
      return Promise.resolve(makeOkResponse({ sha: 'sha-empty' }));
    });

    await syncAll({ files: [local('a'), local('b')], deviceId: 'd1', branch: 'main' });

    // b は push され、成功分だけの manifest が確定する。
    expect(puts.filter((p) => p.path === '/sync/file/b')).toHaveLength(1);
    const manifestWrites = puts.filter((p) => p.path === '/sync/manifest');
    expect(manifestWrites).toHaveLength(2);
    expect(Object.keys(manifestWrites[1].body.files)).toEqual(['b']);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('unprocessable');
  });

  // 再確認が失敗した場合を「不在」と同じに潰すと、実際には別端末の entity が存在していても
  // entry を欠いた manifest が確定し、次回の通常同期がその entity を上書きする（6・7 周目と
  // 同じ経路）。**不在は明示的な 404 でだけ確定する。**
  it.each([
    [403, 'forbidden'],
    [500, 'server'],
    [502, 'upstream'],
  ])('拒否後の再確認が status %d で不確定なら manifest を書かない', async (recheckStatus) => {
    let seen = 0;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ code: 'sync_manifest_missing' }),
        });
      if (path === '/sync/file/a') {
        seen += 1;
        // 1 回目（不在確認）は 404、2 回目（拒否後の再確認）は不確定。
        if (seen === 1) return Promise.resolve({ ok: false, status: 404 });
        return Promise.resolve({
          ok: false,
          status: recheckStatus,
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/init')
        return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
      puts.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
      if (path === '/sync/file/a')
        return Promise.resolve({
          ok: false,
          status: 422,
          json: () => Promise.resolve({ code: 'sync_unprocessable' }),
        });
      return Promise.resolve(makeOkResponse({ sha: 'sha-empty' }));
    });

    await syncAll({ files: [local('a'), local('b')], deviceId: 'd1', branch: 'main' });

    // 空 manifest の確定だけ。成功分だけの manifest は書かない。
    expect(puts.filter((p) => p.path === '/sync/manifest')).toHaveLength(1);
  });

  // 通常の書き込み失敗（不在は確認済みで、拒否理由が create 競合ではない）まで中止に
  // 倒すと、一時的な 429 で init が毎回やり直しになり、部分 manifest による回復ができない。
  it('PUT 側の失敗は従来どおり部分失敗として続行する', async () => {
    workerFetch.mockImplementation((path) =>
      Promise.resolve(
        path === '/sync/manifest'
          ? {
              ok: false,
              status: 404,
              json: () => Promise.resolve({ code: 'sync_manifest_missing' }),
            }
          : { ok: false, status: 404 },
      ),
    );
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/init')
        return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
      puts.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
      if (path === '/sync/file/a')
        return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
      return Promise.resolve(makeOkResponse({ sha: 'sha-empty' }));
    });

    await syncAll({ files: [local('a'), local('b')], deviceId: 'd1', branch: 'main' });

    const manifestWrites = puts.filter((p) => p.path === '/sync/manifest');
    expect(manifestWrites).toHaveLength(2);
    expect(Object.keys(manifestWrites[1].body.files)).toEqual(['b']);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('upstream');
  });

  // Codex 10周目 P1-1: push 前の不在確認 GET が reject すると、既存の
  // `if (fr.ok) / else if (fr.status !== 404)` のどちらにも到達せず、expectAbsent 用の
  // SyncAbortError 変換を経由しないまま通常の partial failure として握られていた。
  // workerFetch は実装契約上 fetch の拒否を SyncRequestError('network') として throw する
  // （workerClient.js の fetchOrNetworkError）。
  it('push 前の不在確認 GET が reject（network）なら中止する', async () => {
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ code: 'sync_manifest_missing' }),
        });
      if (path === '/sync/file/a')
        return Promise.reject(new SyncRequestError('network', { operation: 'fetch /sync/file/a' }));
      return Promise.resolve({ ok: false, status: 404 });
    });
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/init')
        return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
      puts.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
      return Promise.resolve(makeOkResponse({ sha: 'sha-empty' }));
    });

    await syncAll({ files: [local('a'), local('b')], deviceId: 'd1', branch: 'main' });

    // entity は 1 件も push しない。空 manifest の確定だけ。
    expect(puts.filter((p) => p.path === '/sync/file/a')).toHaveLength(0);
    expect(puts.filter((p) => p.path === '/sync/file/b')).toHaveLength(0);
    expect(puts.filter((p) => p.path === '/sync/manifest')).toHaveLength(1);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('network');
  });

  // Codex 10周目 P1-2: create PUT failure 後の実在再確認は、以前は conflict / unprocessable
  // （＝ create-only 違反として拒否された場合）に限って行われていた。429 / 5xx / PUT 自体の
  // reject など、それ以外の理由で PUT が失敗した場合は再確認そのものが行われず、実際には
  // 別端末が entity を作っていても部分失敗として握られていた。判断基準を
  // 「absence を明示的な 404 で証明できたか」だけに統一し、PUT の失敗理由を問わず
  // 再確認するよう直した。
  describe('create PUT の不確定な失敗後は entity presence を再確認する（Codex 10周目 P1-2）', () => {
    it('PUT が 429 で失敗し、再確認が 200（present）なら中止する', async () => {
      let fileGetCount = 0;
      workerFetch.mockImplementation((path) => {
        if (path === '/sync/manifest')
          return Promise.resolve({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ code: 'sync_manifest_missing' }),
          });
        if (path === '/sync/file/a') {
          fileGetCount += 1;
          // 1 回目（不在確認）は 404、2 回目（拒否後の再確認）では実在する。
          return Promise.resolve(
            fileGetCount === 1 ? { ok: false, status: 404 } : { ok: true, status: 200 },
          );
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      const puts = [];
      workerFetchWithCSRF.mockImplementation((path, opts) => {
        if (path === '/sync/init')
          return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
        puts.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
        if (path === '/sync/file/a')
          return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
        return Promise.resolve(makeOkResponse({ sha: 'sha-empty' }));
      });

      await syncAll({ files: [local('a'), local('b')], deviceId: 'd1', branch: 'main' });

      expect(puts.filter((p) => p.path === '/sync/file/b')).toHaveLength(0);
      expect(puts.filter((p) => p.path === '/sync/manifest')).toHaveLength(1);
      const { getSyncStatus } = await import('./sync');
      // abort の category は再確認自身の結果ではなく元の PUT 失敗（429）の category を使う。
      expect(getSyncStatus().errorCategory).toBe('upstream');
    });

    it('PUT が 429 で失敗し、再確認も 403（unknown）なら中止する', async () => {
      let fileGetCount = 0;
      workerFetch.mockImplementation((path) => {
        if (path === '/sync/manifest')
          return Promise.resolve({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ code: 'sync_manifest_missing' }),
          });
        if (path === '/sync/file/a') {
          fileGetCount += 1;
          return Promise.resolve(
            fileGetCount === 1
              ? { ok: false, status: 404 }
              : { ok: false, status: 403, json: () => Promise.resolve({}) },
          );
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      const puts = [];
      workerFetchWithCSRF.mockImplementation((path, opts) => {
        if (path === '/sync/init')
          return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
        puts.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
        if (path === '/sync/file/a')
          return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
        return Promise.resolve(makeOkResponse({ sha: 'sha-empty' }));
      });

      await syncAll({ files: [local('a'), local('b')], deviceId: 'd1', branch: 'main' });

      expect(puts.filter((p) => p.path === '/sync/file/b')).toHaveLength(0);
      expect(puts.filter((p) => p.path === '/sync/manifest')).toHaveLength(1);
      const { getSyncStatus } = await import('./sync');
      // 再確認自身の category（forbidden）ではなく、元の PUT 失敗（429 → upstream）を使う。
      expect(getSyncStatus().errorCategory).toBe('upstream');
    });

    it('PUT が reject（network）し、再確認が 200（present）なら中止する', async () => {
      let fileGetCount = 0;
      workerFetch.mockImplementation((path) => {
        if (path === '/sync/manifest')
          return Promise.resolve({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ code: 'sync_manifest_missing' }),
          });
        if (path === '/sync/file/a') {
          fileGetCount += 1;
          return Promise.resolve(
            fileGetCount === 1 ? { ok: false, status: 404 } : { ok: true, status: 200 },
          );
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      const puts = [];
      workerFetchWithCSRF.mockImplementation((path, opts) => {
        if (path === '/sync/init')
          return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
        if (path === '/sync/file/a') {
          puts.push({ path });
          return Promise.reject(new SyncRequestError('network', { operation: 'write file a' }));
        }
        puts.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
        return Promise.resolve(makeOkResponse({ sha: 'sha-empty' }));
      });

      await syncAll({ files: [local('a'), local('b')], deviceId: 'd1', branch: 'main' });

      expect(puts.filter((p) => p.path === '/sync/file/b')).toHaveLength(0);
      expect(puts.filter((p) => p.path === '/sync/manifest')).toHaveLength(1);
      const { getSyncStatus } = await import('./sync');
      expect(getSyncStatus().errorCategory).toBe('network');
    });

    // liveness を守る負例。create PUT が失敗しても、再確認が明示的な 404 なら別端末の
    // entity は存在しないと確認できている。この場合まで init 全体を中止すると、429 / 5xx /
    // 通信断のたびに init が毎回やり直しになり、部分 manifest による回復ができなくなる。
    it('PUT が reject（network）し、再確認が 404（absent）なら部分失敗として続行する', async () => {
      workerFetch.mockImplementation((path) => {
        if (path === '/sync/manifest')
          return Promise.resolve({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ code: 'sync_manifest_missing' }),
          });
        // 不在確認・拒否後の再確認とも 404（未作成のまま）。
        return Promise.resolve({ ok: false, status: 404 });
      });
      const puts = [];
      workerFetchWithCSRF.mockImplementation((path, opts) => {
        if (path === '/sync/init')
          return Promise.resolve(makeOkResponse({ branch: 'main', created: true }));
        if (path === '/sync/file/a') {
          puts.push({ path });
          return Promise.reject(new SyncRequestError('network', { operation: 'write file a' }));
        }
        puts.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
        return Promise.resolve(makeOkResponse({ sha: 'sha-empty' }));
      });

      await syncAll({ files: [local('a'), local('b')], deviceId: 'd1', branch: 'main' });

      // b は push され、成功分だけの manifest が確定する。
      expect(puts.filter((p) => p.path === '/sync/file/b')).toHaveLength(1);
      const manifestWrites = puts.filter((p) => p.path === '/sync/manifest');
      expect(manifestWrites).toHaveLength(2);
      expect(Object.keys(manifestWrites[1].body.files)).toEqual(['b']);
      const { getSyncStatus } = await import('./sync');
      expect(getSyncStatus().errorCategory).toBe('network');
    });
  });
});

// ── entity write の世代拘束と reconcile（#609 A-2） ──────────────────────────
// docs/data-model/sync-contract.md「entity write の世代拘束と reconcile」を正本とする。
// issue #609 コメント1 のデータ喪失シナリオ（端末 A が create-only で書いた entity を
// 端末 B が manifest に entry の無い状態のまま live SHA を取得して上書きする）を閉じる。
describe('syncAll — entity write の世代拘束と reconcile（#609 A-2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('B が M0 を読み A の orphan X を push → orphan → 内容差 → conflict（上書き PUT は発生しない）', async () => {
    const now = Date.now();
    const localX = { id: 'x', name: 'b.md', content: 'B の本文', updatedAt: now, isDirty: true };
    const remoteXBody = {
      id: 'x', name: 'a.md', content: 'A の本文',
      updatedAt: new Date(now).toISOString(), _sha: 'a-sha', _branch: 'main',
    };
    let putCount = 0;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifest({}, 'main', 'm0-sha')));
      if (path === '/sync/file/x') return Promise.resolve(makeOkResponse(remoteXBody));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/x' && opts?.method === 'PUT') {
        putCount += 1;
        return Promise.resolve({
          ok: false, status: 409, json: () => Promise.resolve({ code: 'sync_entity_orphan' }),
        });
      }
      return Promise.resolve({ ok: true });
    });

    const onConflict = vi.fn();
    await syncAll({ files: [localX], deviceId: 'd1', branch: 'main', onConflict, onBranch: vi.fn() });

    // orphan 検出後の reconcile は「内容が違う」ので conflict へ回るだけで、上書き PUT は
    // 1 回しか発生しない（reconcile 自体は書かず live GET のみ）。
    expect(putCount).toBe(1);
    expect(onConflict).toHaveBeenCalledOnce();
    expect(onConflict.mock.calls[0][0].local.id).toBe('x');
    expect(onConflict.mock.calls[0][0].remote.content).toBe('A の本文');
    const manifestPuts = workerFetchWithCSRF.mock.calls.filter(
      ([p, o]) => p === '/sync/manifest' && o?.method === 'PUT',
    );
    expect(manifestPuts).toHaveLength(0);
  });

  it('failed manifest PUT 後の再同期で同一 orphan（自分自身の直前の push）が採用され manifest に載る', async () => {
    const now = Date.now();
    const localX = { id: 'x', name: 'a.md', content: '同じ内容', updatedAt: now, isDirty: true };
    const remoteXBody = {
      id: 'x', name: 'a.md', content: '同じ内容',
      updatedAt: new Date(now).toISOString(), _sha: 'a-sha', _branch: 'main',
    };
    const bodies = {};
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifest({}, 'main', 'm0-sha')));
      if (path === '/sync/file/x') return Promise.resolve(makeOkResponse(remoteXBody));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/x' && opts?.method === 'PUT') {
        return Promise.resolve({
          ok: false, status: 409, json: () => Promise.resolve({ code: 'sync_entity_orphan' }),
        });
      }
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        bodies.manifest = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'm1-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [localX], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(bodies.manifest?.files?.x).toBeDefined();
    expect(bodies.manifest.files.x.sha).toBe('a-sha');
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().error).toBeNull();
  });

  it('autosave 後の syncAll が entity_stale を受けても内容が同一なら採用する（上書きしない）', async () => {
    const now = Date.now();
    const localA = { id: 'a', name: 'a.md', content: '内容', updatedAt: now, isDirty: true };
    const remoteABody = {
      id: 'a', name: 'a.md', content: '内容',
      updatedAt: new Date(now).toISOString(), _sha: 'live-sha', _branch: 'main',
    };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(
          makeOkResponse(makeManifest({ a: { id: 'a', sha: 'old-sha' } }, 'main', 'm0-sha')),
        );
      }
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse(remoteABody));
      return Promise.resolve({ ok: false, status: 404 });
    });
    const bodies = {};
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/a' && opts?.method === 'PUT') {
        return Promise.resolve({
          ok: false, status: 409, json: () => Promise.resolve({ code: 'sync_entity_stale' }),
        });
      }
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        bodies.manifest = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'm1-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [localA], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(bodies.manifest.files.a.sha).toBe('live-sha');
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().error).toBeNull();
  });

  it('manifest 409 stale → manifest を読み直して 1 回だけ再試行し成立する', async () => {
    let manifestReads = 0;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        manifestReads += 1;
        const sha = manifestReads === 1 ? 'm1-sha' : 'm2-sha';
        return Promise.resolve(makeOkResponse(makeManifest({}, 'main', sha)));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    let manifestPuts = 0;
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        manifestPuts += 1;
        if (manifestPuts === 1) {
          return Promise.resolve({
            ok: false, status: 409, json: () => Promise.resolve({ code: 'sync_manifest_stale' }),
          });
        }
        return Promise.resolve(makeOkResponse({ sha: 'm3-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(manifestReads).toBe(2);
    expect(manifestPuts).toBe(2);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().error).toBeNull();
  });

  it('manifest 409 stale が再試行後も続けば conflict category で不成立とする（lastSyncedAt は進めない）', async () => {
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifest({}, 'main', 'm1-sha')));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        return Promise.resolve({
          ok: false, status: 409, json: () => Promise.resolve({ code: 'sync_manifest_stale' }),
        });
      }
      return Promise.resolve({ ok: true });
    });

    const { getSyncStatus } = await import('./sync');
    const before = getSyncStatus().lastSyncedAt;
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(getSyncStatus().errorCategory).toBe('conflict');
    expect(getSyncStatus().lastSyncedAt).toBe(before);
  });

  it('pull が live sha を manifest entry に記録する（entry.sha と不一致でも停止しない）', async () => {
    const now = Date.now();
    const remoteUpdatedAt = new Date(now + 10000).toISOString();
    const remoteFileBody = {
      id: 'a', name: 'a.md', content: 'remote', updatedAt: remoteUpdatedAt,
      _sha: 'live-sha', _branch: 'main',
    };
    const bodies = {};
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(makeOkResponse(
          makeManifest({ a: { id: 'a', updatedAt: remoteUpdatedAt, sha: 'old-sha' } }, 'main', 'm1-sha'),
        ));
      }
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse(remoteFileBody));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        bodies.manifest = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'm2-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    const file = { id: 'a', name: 'a', content: '古い local', updatedAt: now - 10000, isDirty: false };
    // pull は adoptedHash === localHash（remote だけ変わった）で成立する契約（#610）。
    const adoptedHash = await computeCanonicalHash(file);
    dbGet.mockImplementationOnce((store, id) =>
      Promise.resolve(store === 'syncState' && id === 'a' ? { id: 'a', adoptedHash } : undefined),
    );
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(bodies.manifest.files.a.sha).toBe('live-sha');
    // pull で解決した canonical hash も manifest entry に載る（#610）。
    expect(bodies.manifest.files.a.hash).toBeDefined();
  });

  it('legacy entry（sha 無し）を live GET で 1 回補完し、次の manifest に sha を載せる', async () => {
    const now = Date.now();
    const olderAt = new Date(now - 10000).toISOString();
    const bodies = {};
    let fileGetCount = 0;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(makeOkResponse(makeManifest({ a: { id: 'a', updatedAt: olderAt } }, 'main', 'm1-sha')));
      }
      if (path === '/sync/file/a') {
        fileGetCount += 1;
        return Promise.resolve(makeOkResponse({
          id: 'a', name: 'a', content: 'x', updatedAt: olderAt, _sha: 'legacy-live-sha', _branch: 'main',
        }));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        bodies.manifest = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'm2-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    // isDirty:false・remote 更新なし → skip 対象（legacy entry の補完だけが走る）。
    const file = { id: 'a', name: 'a', content: 'x', updatedAt: now, isDirty: false };
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(fileGetCount).toBe(1);
    expect(bodies.manifest.files.a.sha).toBe('legacy-live-sha');
  });

  // #609 round2 F1/F4 + #610: legacy entry（hash 無し）は分類のため live GET が 1 回走るが
  // （drift 検出。entity が無い＝404）、push 自体の CAS token（_sha）は entry.sha をそのまま
  // 使うため null になる。worker が create-only 判定（実在確認）を行うため、client 側で
  // 正確な sha を当てる必要が無い。
  it('legacy entry（hash 無し・entity drift）の push は _sha: null を送る', async () => {
    const now = Date.now();
    const olderAt = new Date(now - 20000).toISOString();
    const bodies = {};
    let fileGetCalls = 0;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(makeOkResponse(makeManifest({ a: { id: 'a', updatedAt: olderAt } }, 'main', 'm1-sha')));
      }
      if (path === '/sync/file/a') fileGetCalls += 1;
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/a' && opts?.method === 'PUT') {
        bodies.file = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'new-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    const file = { id: 'a', name: 'a', content: 'x', updatedAt: now, isDirty: true };
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    // 分類のための legacy hash 解決で 1 回 GET する（drift 検出。#610）。
    expect(fileGetCalls).toBe(1);
    expect(bodies.file._sha).toBeNull();
  });

  // #609 round2 F1: skip 対象の legacy entry で live GET が 404（entry はあるが entity が
  // 無い drift）なら push（create-only）へ回し、sha 無し entry を manifest に書き戻さない。
  it('skip 対象の legacy entry で live GET が 404 なら push（create-only）に回り manifest に新しい sha が載る', async () => {
    const now = Date.now();
    const olderAt = new Date(now - 10000).toISOString();
    const bodies = {};
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(makeOkResponse(makeManifest({ a: { id: 'a', updatedAt: olderAt } }, 'main', 'm1-sha')));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/a' && opts?.method === 'PUT') {
        bodies.file = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'created-sha' }));
      }
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        bodies.manifest = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'm2-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    // isDirty:false・remote 更新なし → 分類は skip。live GET 404（drift）→ push へ回る。
    const file = { id: 'a', name: 'a', content: 'x', updatedAt: now, isDirty: false };
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(bodies.file).toBeDefined();
    expect(bodies.file._sha).toBeNull();
    expect(bodies.manifest.files.a.sha).toBe('created-sha');
  });

  // #609 round2 F3: entry.sha ありの CAS write が blob 消失等で 422→entity_stale になり、
  // reconcile の live GET も 404（本当に消えていた）なら create-only で再 write して採用する。
  it('entry.sha あり・blob 消失（stale）で reconcile が live 404 なら create-only で再 write し manifest が成立する', async () => {
    const now = Date.now();
    const localA = { id: 'a', name: 'a.md', content: '内容', updatedAt: now, isDirty: true };
    const bodies = {};
    let putCount = 0;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(makeOkResponse(makeManifest({ a: { id: 'a', sha: 'old-sha' } }, 'main', 'm0-sha')));
      }
      if (path === '/sync/file/a') return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/a' && opts?.method === 'PUT') {
        putCount += 1;
        if (putCount === 1) {
          return Promise.resolve({
            ok: false, status: 409, json: () => Promise.resolve({ code: 'sync_entity_stale' }),
          });
        }
        bodies.file = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'recreated-sha' }));
      }
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        bodies.manifest = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'm1-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [localA], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(putCount).toBe(2);
    expect(bodies.file._reconcile).toBe(true);
    expect(bodies.file._sha).toBeNull();
    expect(bodies.manifest.files.a.sha).toBe('recreated-sha');
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().error).toBeNull();
  });

  // #609 round2 risk-model: quarantine push（deny remote → local を push）が
  // sync_manifest_stale を受けたら握り潰さず再送出し、他の call site と同じく
  // pass 中止→1 回再試行に乗せる。
  it('quarantine push が sync_manifest_stale を受けたら pass を中止し 1 回再試行して成立する', async () => {
    const now = Date.now();
    const remoteUpdatedAt = new Date(now + 10000).toISOString();
    const file = {
      id: 'a', name: 'test.md', content: 'local dirty', updatedAt: now - 10000, isDirty: true,
    };
    const remoteFileBody = {
      id: 'a', name: 'test.md', content: '\x00\x01\x02\x03'.repeat(20),
      updatedAt: remoteUpdatedAt, _sha: 's', _branch: 'main',
    };
    let manifestReads = 0;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        manifestReads += 1;
        const sha = manifestReads === 1 ? 'm1-sha' : 'm2-sha';
        return Promise.resolve(
          makeOkResponse(makeManifest({ a: { updatedAt: remoteUpdatedAt } }, 'main', sha)),
        );
      }
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse(remoteFileBody));
      return Promise.resolve({ ok: false, status: 404 });
    });
    let quarantinePutCount = 0;
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/a' && opts?.method === 'PUT') {
        quarantinePutCount += 1;
        if (quarantinePutCount === 1) {
          return Promise.resolve({
            ok: false, status: 409, json: () => Promise.resolve({ code: 'sync_manifest_stale' }),
          });
        }
        return Promise.resolve(makeOkResponse({ sha: 'quarantine-sha' }));
      }
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        return Promise.resolve(makeOkResponse({ sha: 'm3-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    const onQuarantine = vi.fn();
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onQuarantine, onBranch: vi.fn() });

    expect(manifestReads).toBe(2);
    expect(quarantinePutCount).toBe(2);
    expect(onQuarantine).toHaveBeenCalledOnce();
    expect(onQuarantine.mock.calls[0][2]).toBe(true);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().error).toBeNull();
  });

  // #609 round3 L2: pass commit 後の _snapshotRef.entries 再構築が spread（plain object に
  // 戻る）だと、'constructor' 等のキーが Object.prototype から継承した Function を読んでしまう
  // （own property が無い限り）。null-prototype を維持していれば、未同期の id への
  // entrySha 読み取りは常に null になる。
  it('_snapshotRef.entries は pass commit 後も null-prototype を維持する（constructor id で確認）', async () => {
    const now = Date.now();
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifest({}, 'main', 'm1-sha')));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/a' && opts?.method === 'PUT') {
        return Promise.resolve(makeOkResponse({ sha: 'a-sha' }));
      }
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        return Promise.resolve(makeOkResponse({ sha: 'm2-sha' }));
      }
      return Promise.resolve({ ok: true });
    });
    const fileA = { id: 'a', name: 'a', content: 'x', updatedAt: now, isDirty: true };
    // commit を経由させ、_snapshotRef.entries を「pass commit 後の再構築」経路に通す。
    await syncAll({ files: [fileA], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    // 'constructor' は一度も同期していない id。entries が plain object に戻っていると
    // Object.prototype.constructor（Function）を継承して読めてしまい、entrySha が誤った
    // truthy 値になる（JSON.stringify は function 値の key を落とすため _sha が undefined
    // になる。null-prototype なら own property が無く null になる）。
    let putBody = null;
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/constructor' && opts?.method === 'PUT') {
        putBody = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'ctor-sha' }));
      }
      return Promise.resolve({ ok: true });
    });
    const ctorFile = { id: 'constructor', name: 'c', content: 'y', updatedAt: now, isDirty: true };
    await syncFileSilent(ctorFile, 'main');

    expect(putBody).not.toBeNull();
    expect(putBody._sha).toBeNull();
  });
});

describe('resolveConflictKeepLocal（#609 A-2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('manifest と live entity を読み、_reconcile で CAS write する', async () => {
    const file = { id: 'a', name: 'a', content: 'local', updatedAt: Date.now(), isDirty: true };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifest({}, 'main', 'm1-sha')));
      if (path === '/sync/file/a') {
        return Promise.resolve(makeOkResponse({
          id: 'a', name: 'remote', content: 'remote',
          updatedAt: new Date().toISOString(), _sha: 'live-sha', _branch: 'main',
        }));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    let putBody = null;
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/a' && opts?.method === 'PUT') {
        putBody = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'new-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    const result = await resolveConflictKeepLocal(file, 'main');

    expect(result.isDirty).toBe(false);
    expect(putBody._manifestSha).toBe('m1-sha');
    expect(putBody._sha).toBe('live-sha');
    expect(putBody._reconcile).toBe(true);
  });

  // #609 round2 F4: live の有無に関わらず常に _reconcile: true を送る。live 404 のときは
  // _sha: null（worker の規則3: _reconcile:true は _sha:null も受理し create-only で書く）。
  it('live entity が 404 でも _reconcile: true, _sha: null で create-only 書き込みが成立する', async () => {
    const file = { id: 'a', name: 'a', content: 'local', updatedAt: Date.now(), isDirty: true };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(
          makeOkResponse(makeManifest({ a: { id: 'a', sha: 'entry-sha' } }, 'main', 'm1-sha')),
        );
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    let putBody = null;
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/a' && opts?.method === 'PUT') {
        putBody = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'new-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    const result = await resolveConflictKeepLocal(file, 'main');

    expect(result.isDirty).toBe(false);
    expect(putBody._sha).toBeNull();
    expect(putBody._reconcile).toBe(true);
  });
});

// ── #610 完了条件の固定（hash 入力・updatedAt/isDirty 非依存） ─────────────────
describe('syncAll — 同期状態の同一性（#610）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 完了条件5: timestamp だけが変化しても sync work が発生しない。
  it('timestamp だけが変化していれば push/pull/conflict のいずれも発生しない', async () => {
    const file = { id: 'a', name: 'a.md', content: '本文', github: null, updatedAt: Date.now() };
    const hash = await computeCanonicalHash(file);
    const puts = [];
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse(makeManifest({ a: { id: 'a', hash } }, 'main', 'm1-sha')));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      puts.push(path);
      if (path === '/sync/manifest' && opts?.method === 'PUT') return Promise.resolve(makeOkResponse({ sha: 'm2-sha' }));
      return Promise.resolve({ ok: true });
    });

    const onPullFile = vi.fn();
    const onConflict = vi.fn();
    await syncAll({
      // remote 側は clock skew で updatedAt が全く異なる（判定には使われない）。
      files: [{ ...file, updatedAt: file.updatedAt - 999999 }],
      deviceId: 'd1',
      branch: 'main',
      onPullFile,
      onConflict,
      onBranch: vi.fn(),
    });

    expect(puts.filter((p) => p === '/sync/file/a')).toHaveLength(0);
    expect(onPullFile).not.toHaveBeenCalled();
    expect(onConflict).not.toHaveBeenCalled();
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().error).toBeNull();
  });

  // 完了条件6: 編集 → 完全復元（remote・adoptedHash と同一内容に戻す）で skip になる。
  it('編集後に元の内容へ完全復元すれば skip になる（同期作業が発生しない）', async () => {
    const file = { id: 'a', name: 'a.md', content: '元の内容', github: null, updatedAt: Date.now() };
    const hash = await computeCanonicalHash(file);
    dbGet.mockImplementationOnce((store, id) =>
      Promise.resolve(store === 'syncState' && id === 'a' ? { id: 'a', adoptedHash: hash } : undefined),
    );
    const puts = [];
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse(makeManifest({ a: { id: 'a', hash } }, 'main', 'm1-sha')));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      puts.push(path);
      if (path === '/sync/manifest' && opts?.method === 'PUT') return Promise.resolve(makeOkResponse({ sha: 'm2-sha' }));
      return Promise.resolve({ ok: true });
    });

    const onConflict = vi.fn();
    // いったん編集してから元の内容に戻した状態（content は同一。canonical hash も同一）。
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onConflict, onBranch: vi.fn() });

    expect(puts.filter((p) => p === '/sync/file/a')).toHaveLength(0);
    expect(onConflict).not.toHaveBeenCalled();
  });

  // 完了条件10: commitCurrentFile 相当（isDirty が false のまま github.sha だけ更新された
  // ファイル）でも、本文が実際に変わっていれば sync repo へ push される回帰テスト。
  // 旧実装（isDirty ベース）はここで push を落としていた（issue #610 本文）。
  it('commitCurrentFile 相当（isDirty:false・内容変更済み）でも push される', async () => {
    const oldFile = { id: 'a', name: 'a.md', content: '旧本文', github: null };
    const oldHash = await computeCanonicalHash(oldFile);
    // commitCurrentFile 後: 本文は新しくなったが isDirty は false のまま。
    const file = { id: 'a', name: 'a.md', content: '新本文（GitHub へ commit 済み）', github: null, isDirty: false };
    // この端末は前回 remote と oldHash で一致していた（adoptedHash = oldHash）。
    dbGet.mockImplementationOnce((store, id) =>
      Promise.resolve(store === 'syncState' && id === 'a' ? { id: 'a', adoptedHash: oldHash } : undefined),
    );
    const bodies = {};
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse(makeManifest({ a: { id: 'a', hash: oldHash } }, 'main', 'm1-sha')));
      if (path === '/sync/file/a') return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/a' && opts?.method === 'PUT') {
        bodies.file = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'new-sha' }));
      }
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        bodies.manifest = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'm2-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(bodies.file).toBeDefined();
    expect(bodies.file.content).toBe('新本文（GitHub へ commit 済み）');
    expect(bodies.manifest.files.a.hash).toBeDefined();
  });

  // 完了条件12（DB v4 移行直後・adoptedHash 不在）: local/remote の hash が一致していれば
  // 転送なしで採用する（A := R）。
  it('v4 移行直後（adoptedHash 不在）・local と remote の hash が一致すれば転送なしで採用する', async () => {
    const file = { id: 'a', name: 'a.md', content: '内容', github: null };
    const hash = await computeCanonicalHash(file);
    const puts = [];
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse(makeManifest({ a: { id: 'a', hash } }, 'main', 'm1-sha')));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      puts.push(path);
      if (path === '/sync/manifest' && opts?.method === 'PUT') return Promise.resolve(makeOkResponse({ sha: 'm2-sha' }));
      return Promise.resolve({ ok: true });
    });

    const onConflict = vi.fn();
    // dbGet は既定（undefined）のまま = syncState が空（DB v4 移行直後）。
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onConflict, onBranch: vi.fn() });

    expect(puts.filter((p) => p === '/sync/file/a')).toHaveLength(0);
    expect(onConflict).not.toHaveBeenCalled();
    // syncState への採用書き込み（A := R）が行われる。
    const syncStateWrites = dbPut.mock.calls.filter(([store]) => store === 'syncState');
    expect(syncStateWrites.some(([, rec]) => rec.id === 'a' && rec.adoptedHash === hash)).toBe(true);
  });

  // 完了条件12（DB v4 移行直後・adoptedHash 不在）: local/remote の hash が不一致なら方向を
  // 推測せず conflict にする（isDirty を信じない）。
  it('v4 移行直後（adoptedHash 不在）・local と remote の hash が不一致なら conflict にする', async () => {
    const file = { id: 'a', name: 'a.md', content: 'local 内容', github: null };
    const remoteFileBody = {
      id: 'a', name: 'a.md', content: 'remote 内容', updatedAt: new Date().toISOString(),
      _sha: 'live-sha', _branch: 'main',
    };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(
          makeOkResponse(makeManifest({ a: { id: 'a', updatedAt: new Date(0).toISOString() } }, 'main', 'm1-sha')),
        );
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse(remoteFileBody));
      return Promise.resolve({ ok: false, status: 404 });
    });
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      puts.push(path);
      if (path === '/sync/manifest' && opts?.method === 'PUT') return Promise.resolve(makeOkResponse({ sha: 'm2-sha' }));
      return Promise.resolve({ ok: true });
    });

    const onConflict = vi.fn();
    // dbGet は既定（undefined）のまま = adoptedHash 不在。
    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onConflict, onBranch: vi.fn() });

    expect(onConflict).toHaveBeenCalledOnce();
    expect(puts.filter((p) => p === '/sync/manifest' && p.includes('PUT'))).toHaveLength(0);
  });
});

// ── #610 round2 の修正（F1・F2・risk-model 補足） ─────────────────────────────
describe('syncAll — 同期状態の同一性 round2（#610 round2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // このブロックの一部テストは dbGet.mockImplementation（blanket）を使うため、
    // 各テスト開始時に安全なデフォルト（syncState 無し）へ明示的に戻す
    // （vi.clearAllMocks() は実装を消さないため、前テストの override が残りうる）。
    dbGet.mockImplementation(() => Promise.resolve(undefined));
  });

  // F1（High・データ喪失）: pull が失敗（GET !ok）したら syncState/manifest hash を書かず、
  // 次回同期でも push ではなく再 pull を試みる（採用済みと誤認しない）。
  it('pull が GET 500 で失敗すれば syncState を書かず、次回同期でも push ではなく再 pull を試みる（F1）', async () => {
    const localOld = { id: 'a', name: 'a.md', content: '古い内容', github: null };
    const localHash = await computeCanonicalHash(localOld);
    // adoptedHash === localHash（remote だけ変わった＝pull 対象）。
    dbGet.mockImplementation((store, id) =>
      Promise.resolve(store === 'syncState' && id === 'a' ? { id: 'a', adoptedHash: localHash } : undefined),
    );
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(
          makeOkResponse(makeManifest({ a: { id: 'a', hash: 'f'.repeat(64) } }, 'main', 'm1-sha')),
        );
      }
      if (path === '/sync/file/a')
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: false, status: 404 });
    });
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      puts.push({ path, method: opts?.method });
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [localOld], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(dbPut.mock.calls.filter(([store]) => store === 'syncState')).toHaveLength(0);
    expect(puts.filter((p) => p.path === '/sync/file/a' && p.method === 'PUT')).toHaveLength(0);

    // 次回同期（remote は変わらず GET が今回も失敗）でも push は発生しない（再 pull のまま）。
    dbPut.mockClear();
    await syncAll({ files: [localOld], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });
    expect(puts.filter((p) => p.path === '/sync/file/a' && p.method === 'PUT')).toHaveLength(0);
    expect(dbPut.mock.calls.filter(([store]) => store === 'syncState')).toHaveLength(0);
  });

  // F2（Med）: pull 採用値は manifest entry の主張値（declared hash）ではなく、pull した
  // 実体から検算した値にする。宣言値が実体と食い違っていても、採用値・manifest 双方に
  // 実体の hash が書かれる。
  it('entry.hash が実体と食い違っていても、採用値と manifest には実体を検算した hash が書かれる（F2）', async () => {
    const localOld = { id: 'a', name: 'a.md', content: 'local 内容', github: null };
    const localHash = await computeCanonicalHash(localOld);
    const remoteFileBody = {
      id: 'a', name: 'a.md', content: 'remote 実体の内容',
      updatedAt: new Date().toISOString(), _sha: 'live-sha', _branch: 'main',
    };
    const verifiedHash = await computeCanonicalHash(parseRemoteFile(remoteFileBody));
    // manifest の宣言値はでたらめ（実体とは食い違う、だが形式は妥当な 64 桁 hex）。
    const declaredWrongHash = '9'.repeat(64);
    dbGet.mockImplementation((store, id) =>
      Promise.resolve(store === 'syncState' && id === 'a' ? { id: 'a', adoptedHash: localHash } : undefined),
    );
    const bodies = {};
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(
          makeOkResponse(makeManifest({ a: { id: 'a', hash: declaredWrongHash } }, 'main', 'm1-sha')),
        );
      }
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse(remoteFileBody));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        bodies.manifest = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'm2-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [localOld], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(bodies.manifest.files.a.hash).toBe(verifiedHash);
    expect(bodies.manifest.files.a.hash).not.toBe(declaredWrongHash);
    const syncStateWrite = dbPut.mock.calls.find(([store, rec]) => store === 'syncState' && rec.id === 'a');
    expect(syncStateWrite[1].adoptedHash).toBe(verifiedHash);
  });

  // F2: "0" 等の壊れた（形式が妥当でない）hash は「欠落」扱いになり、legacy 補完（live GET）
  // 経路へ回る。
  it('entry.hash が壊れた値（"0"）なら legacy 補完（live GET）で計算し直す（F2）', async () => {
    const localOld = { id: 'a', name: 'a.md', content: '同じ内容', github: null };
    const localHash = await computeCanonicalHash(localOld);
    const remoteFileBody = {
      id: 'a', name: 'a.md', content: '同じ内容',
      updatedAt: new Date().toISOString(), _sha: 'live-sha', _branch: 'main',
    };
    let fileGetCount = 0;
    dbGet.mockImplementation((store, id) =>
      Promise.resolve(store === 'syncState' && id === 'a' ? { id: 'a', adoptedHash: localHash } : undefined),
    );
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse(makeManifest({ a: { id: 'a', hash: '0' } }, 'main', 'm1-sha')));
      if (path === '/sync/file/a') {
        fileGetCount += 1;
        return Promise.resolve(makeOkResponse(remoteFileBody));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const bodies = {};
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        bodies.manifest = JSON.parse(opts.body);
        return Promise.resolve(makeOkResponse({ sha: 'm2-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [localOld], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    expect(fileGetCount).toBeGreaterThan(0);
    expect(bodies.manifest.files.a.hash).toBe(localHash);
  });

  // F4: keep-local（local 採用）直後は _snapshotRef.hashes（remote 写し）を変更しない。
  it('resolveConflictKeepLocal は _snapshotRef.hashes（remote 写し）を変更しない（F4）', async () => {
    const remoteOldHash = 'a'.repeat(64);
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest')
        return Promise.resolve(makeOkResponse(makeManifest({ a: { id: 'a', hash: remoteOldHash } }, 'main', 'm0-sha')));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));
    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const { getSnapshotRemoteHashes } = await import('./sync');
    expect(getSnapshotRemoteHashes().a).toBe(remoteOldHash);

    const file = { id: 'a', name: 'a', content: 'local', updatedAt: Date.now(), isDirty: true };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifest({}, 'main', 'm1-sha')));
      if (path === '/sync/file/a') return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/a' && opts?.method === 'PUT') return Promise.resolve(makeOkResponse({ sha: 'new-sha' }));
      return Promise.resolve({ ok: true });
    });

    await resolveConflictKeepLocal(file, 'main');

    // _snapshotRef.hashes（remote 写し）は変わらない。manifest 由来のみが更新できる。
    expect(getSnapshotRemoteHashes().a).toBe(remoteOldHash);
  });

  // risk-model 補足: hash 計算失敗（crypto.subtle 不在）で syncAll がその file を失敗に数え
  // manifest を書かない。
  it('crypto.subtle が使えない環境では file を失敗として数え manifest を書かない', async () => {
    const file = { id: 'a', name: 'a.md', content: '内容', github: null };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifest({}, 'main', 'm1-sha')));
      return Promise.resolve({ ok: false, status: 404 });
    });
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      puts.push({ path, method: opts?.method });
      return Promise.resolve({ ok: true });
    });

    const originalCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
      await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
    }

    expect(puts.filter((p) => p.path === '/sync/manifest' && p.method === 'PUT')).toHaveLength(0);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().error).toBeTruthy();
  });

  // N1（Med・fail-open）: pull した実体の hash 検算（computeVerifiedHash）が失敗すると、
  // 以前は pull を成功扱いのまま fileHashes/syncState 書き込みだけをスキップし、snapshot が
  // 成立してしまっていた。検算失敗は pull 失敗として扱い、manifest を書かない（#610 round4）。
  it('pull した実体の hash 検算が digest reject で失敗すると manifest を書かず syncState も書かない（N1）', async () => {
    const localOld = { id: 'a', name: 'a.md', content: 'local 内容', github: null };
    const localHash = await computeCanonicalHash(localOld);
    // entry.hash は妥当な形式だが localHash とは異なる値（legacy 補完を経由させず、
    // 直接 pull 分岐に入らせる）。adoptedHash === localHash（remote だけ変わった＝pull 対象）。
    const declaredHash = 'a'.repeat(64);
    dbGet.mockImplementationOnce((store, id) =>
      Promise.resolve(store === 'syncState' && id === 'a' ? { id: 'a', adoptedHash: localHash } : undefined),
    );
    const remoteFileBody = {
      id: 'a', name: 'a.md', content: 'remote 内容',
      updatedAt: new Date().toISOString(), _sha: 'live-sha', _branch: 'main',
    };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(
          makeOkResponse(makeManifest({ a: { id: 'a', hash: declaredHash } }, 'main', 'm1-sha')),
        );
      }
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse(remoteFileBody));
      return Promise.resolve({ ok: false, status: 404 });
    });
    const puts = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      puts.push({ path, method: opts?.method });
      return Promise.resolve({ ok: true });
    });

    const originalCrypto = globalThis.crypto;
    const originalSubtle = originalCrypto.subtle;
    let digestCalls = 0;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: {
          subtle: {
            digest: (...args) => {
              digestCalls += 1;
              // 1 回目（ローカル hash の事前計算）は成功させ、2 回目（pull した実体の検算）
              // だけ reject する。
              if (digestCalls === 2) return Promise.reject(new Error('digest failed'));
              return originalSubtle.digest(...args);
            },
          },
        },
        configurable: true,
      });
      await syncAll({ files: [localOld], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
    }

    expect(puts.filter((p) => p.path === '/sync/manifest' && p.method === 'PUT')).toHaveLength(0);
    expect(dbPut.mock.calls.filter(([store]) => store === 'syncState')).toHaveLength(0);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().error).toBeTruthy();
  });
});

// ── structure（folders/files[id].parentId）の同期統合（#394 C-1） ──────────────
// D4/D5/E4/E8/F7/F9/G1/G2/H2/I2（pr394-c1-risk.md「テスト計画」参照）。
describe('structure（folders/files[id].parentId）の同期統合（#394 C-1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbGet.mockImplementation(() => Promise.resolve(undefined));
  });

  function makeManifestV3(folders = {}, files = {}, branch = 'main', sha = 'sha1') {
    return { version: 3, _branch: branch, _sha: sha, folders, files };
  }

  it('D4: manifest PUT が失敗した回は structure base（syncState）を書かない', async () => {
    const folderA = { id: 'fa', name: 'A', parentId: null, sortOrder: 0, createdAt: 1000 };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifestV3({ fa: folderA }, {})));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: true });
    });
    const onApplyStructure = vi.fn().mockResolvedValue({ ok: true, folders: [folderA], fileParentIds: {} });

    await syncAll({
      files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn(),
      folders: [folderA], filesLoaded: true, foldersLoaded: true, onApplyStructure,
    });

    expect(onApplyStructure).toHaveBeenCalledTimes(1);
    expect(
      dbPut.mock.calls.filter(([store, rec]) => store === 'syncState' && rec.id === '#structure'),
    ).toHaveLength(0);
  });

  it('D5: structure の local 適用（IDB）失敗は manifest PUT を呼ばず snapshot を不成立にする', async () => {
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifestV3({}, {})));
      return Promise.resolve({ ok: false, status: 404 });
    });
    const manifestPutCalls = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') manifestPutCalls.push(1);
      return Promise.resolve({ ok: true });
    });
    const onApplyStructure = vi.fn().mockResolvedValue({ ok: false });

    await syncAll({
      files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn(),
      folders: [], filesLoaded: true, foldersLoaded: true, onApplyStructure,
    });

    expect(manifestPutCalls).toHaveLength(0);
    expect(
      dbPut.mock.calls.filter(([store, rec]) => store === 'syncState' && rec.id === '#structure'),
    ).toHaveLength(0);
    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('internal');
  });

  it('E4: v3 manifest 下でも entity の orphan reconcile は従来どおり動く（回帰確認）', async () => {
    const file = { id: 'a', name: 'a.md', content: 'hello', github: null, updatedAt: Date.now() };
    const localHash = await computeCanonicalHash(file);
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifestV3({}, {})));
      if (path === '/sync/file/a') {
        return Promise.resolve(makeOkResponse({
          id: 'a', name: 'a.md', content: 'hello', github: null,
          updatedAt: new Date(file.updatedAt).toISOString(), _sha: 'live-sha',
        }));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/file/a' && opts?.method === 'PUT') {
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ code: 'sync_entity_orphan' }) });
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    // 1 回失敗（orphan）→ reconcile が live を採用。同じ内容の再送は発生しない。
    const putCalls = workerFetchWithCSRF.mock.calls.filter(([p]) => p === '/sync/file/a');
    expect(putCalls).toHaveLength(1);
    const syncStateWrite = dbPut.mock.calls.find(([store, rec]) => store === 'syncState' && rec.id === 'a');
    expect(syncStateWrite[1].adoptedHash).toBe(localHash);
  });

  it('E8: init の create 空 manifest も folders:{} を書く（isEmptyManifest は files のみで判定）', async () => {
    const folderA = { id: 'fa', name: 'A', parentId: null, sortOrder: 0, createdAt: 1000 };
    const file = { id: 'a', name: 'a.md', content: 'x', github: null, updatedAt: Date.now(), parentId: 'fa' };

    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ code: 'sync_manifest_missing' }) });
      }
      if (path === '/sync/file/a') return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: false, status: 404 });
    });
    const manifestPutBodies = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/init' && opts?.method === 'POST') {
        return Promise.resolve(makeOkResponse({ created: true, branch: 'main' }));
      }
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        manifestPutBodies.push(JSON.parse(opts.body));
        return Promise.resolve(makeOkResponse({ sha: `m-sha-${manifestPutBodies.length}` }));
      }
      if (path === '/sync/file/a' && opts?.method === 'PUT') {
        return Promise.resolve(makeOkResponse({ sha: 'file-a-sha' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({
      files: [file], deviceId: 'd1', branch: 'main', onBranch: vi.fn(),
      folders: [folderA], filesLoaded: true, foldersLoaded: true,
    });

    expect(manifestPutBodies).toHaveLength(2);
    // 1 回目: entity push 前の create 空 manifest（files:{} folders:{}）。
    expect(manifestPutBodies[0].files).toEqual({});
    expect(manifestPutBodies[0].folders).toEqual({});
    // 2 回目: push に成功した entity と local folders を載せた本体。
    expect(manifestPutBodies[1].folders).toHaveProperty('fa');
    expect(manifestPutBodies[1].files.a.parentId).toBe('fa');
    const syncStateBase = dbPut.mock.calls.find(([store, rec]) => store === 'syncState' && rec.id === '#structure');
    expect(syncStateBase[1].folders).toHaveProperty('fa');
  });

  it('F7: remote の createdAt が無効（0以下）なら local を保持する（Date.now() に落とさない）', async () => {
    const localFile = { id: 'a', name: 'a.md', content: '古い内容', updatedAt: 1000, createdAt: 555, github: null };
    const localHash = await computeCanonicalHash(localFile);
    const remoteBody = {
      id: 'a', name: 'a.md', content: '新しい内容', updatedAt: new Date().toISOString(), createdAt: -1, github: null,
    };
    const remoteHash = await computeCanonicalHash(parseRemoteFile(remoteBody));
    dbGet.mockImplementation((store, id) =>
      Promise.resolve(store === 'syncState' && id === 'a' ? { id: 'a', adoptedHash: localHash } : undefined),
    );
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(makeOkResponse(makeManifestV3({}, { a: { id: 'a', hash: remoteHash } })));
      }
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse({ ...remoteBody, _sha: 'live-sha', _branch: 'main' }));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));

    await syncAll({ files: [localFile], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const filesPut = dbPut.mock.calls.find(([store, rec]) => store === 'files' && rec.id === 'a');
    expect(filesPut[1].createdAt).toBe(555);
  });

  it('F9/G1: pull は local の github.sha を保持し、有効な remote createdAt を採用する', async () => {
    const localFile = {
      id: 'a', name: 'a.md', content: '古い内容', updatedAt: 1000, createdAt: 500,
      github: { owner: 'o', repo: 'r', branch: 'main', path: 'a.md', sha: 'local-blob-sha' },
    };
    const localHash = await computeCanonicalHash(localFile);
    const remoteBody = {
      id: 'a', name: 'a.md', content: '新しい内容', updatedAt: new Date().toISOString(), createdAt: 777,
      github: { owner: 'o', repo: 'r', branch: 'main', path: 'a.md' }, // sha を持たない（契約9）
    };
    const remoteHash = await computeCanonicalHash(parseRemoteFile(remoteBody));
    dbGet.mockImplementation((store, id) =>
      Promise.resolve(store === 'syncState' && id === 'a' ? { id: 'a', adoptedHash: localHash } : undefined),
    );
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(makeOkResponse(makeManifestV3({}, { a: { id: 'a', hash: remoteHash } })));
      }
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse({ ...remoteBody, _sha: 'live-sha', _branch: 'main' }));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));

    await syncAll({ files: [localFile], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const filesPut = dbPut.mock.calls.find(([store, rec]) => store === 'files' && rec.id === 'a');
    expect(filesPut[1].github.sha).toBe('local-blob-sha'); // G1: local の sha を保持
    expect(filesPut[1].github.owner).toBe('o');
    expect(filesPut[1].createdAt).toBe(777); // F9: 有効な remote 値を採用
  });

  it('SP1: pull は IDB へ書く前に local の parentId を引き継ぐ（全置換で失わない）', async () => {
    const localFile = {
      id: 'a', name: 'a.md', content: '古い内容', updatedAt: 1000, createdAt: 500,
      parentId: 'folder-a', github: null,
    };
    const localHash = await computeCanonicalHash(localFile);
    const remoteBody = {
      // entity payload は parentId を持たない（契約1: manifest 側が管轄）。
      id: 'a', name: 'a.md', content: '新しい内容', updatedAt: new Date().toISOString(), github: null,
    };
    const remoteHash = await computeCanonicalHash(parseRemoteFile(remoteBody));
    dbGet.mockImplementation((store, id) =>
      Promise.resolve(store === 'syncState' && id === 'a' ? { id: 'a', adoptedHash: localHash } : undefined),
    );
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(makeOkResponse(makeManifestV3({}, { a: { id: 'a', hash: remoteHash } })));
      }
      if (path === '/sync/file/a') return Promise.resolve(makeOkResponse({ ...remoteBody, _sha: 'live-sha', _branch: 'main' }));
      return Promise.resolve({ ok: false, status: 404 });
    });
    workerFetchWithCSRF.mockImplementation(() => Promise.resolve({ ok: true }));

    await syncAll({ files: [localFile], deviceId: 'd1', branch: 'main', onBranch: vi.fn() });

    const filesPut = dbPut.mock.calls.find(([store, rec]) => store === 'files' && rec.id === 'a');
    expect(filesPut[1].parentId).toBe('folder-a');
  });

  it('G2: carryOver（隔離ファイル）の manifest entry からも github.sha を除外する', async () => {
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        // updatedAt は epoch 0（#291 の隔離復帰チェックが再取得を試みないようにする。
        // dbGet('files', id) が undefined を返す既定モックだと localAt=0 になるため、
        // remoteAt もそれ以下にして recovery pull を起動させない — この test の対象は
        // carryOver の github.sha 除外だけなので、無関係な経路を踏まない）。
        return Promise.resolve(makeOkResponse(makeManifestV3({}, {
          quarantined: {
            id: 'quarantined', name: 'q.md', updatedAt: new Date(0).toISOString(),
            github: { owner: 'o', repo: 'r', branch: 'main', path: 'q.md', sha: 'stale-sha' },
          },
        })));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const manifestPutBodies = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        manifestPutBodies.push(JSON.parse(opts.body));
        return Promise.resolve(makeOkResponse({ sha: 'm-sha-2' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({ files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn(), quarantinedIds: ['quarantined'] });

    expect(manifestPutBodies).toHaveLength(1);
    expect(manifestPutBodies[0].files.quarantined.github).not.toHaveProperty('sha');
    expect(manifestPutBodies[0].files.quarantined.github).toMatchObject({
      owner: 'o', repo: 'r', branch: 'main', path: 'q.md',
    });
  });

  it('H2: manifest 409 再試行時は読み直した remote で structure を再 merge する', async () => {
    const folderX = { id: 'fx', name: 'X', parentId: null, sortOrder: 0, createdAt: 1000 };
    const folderY = { id: 'fy', name: 'Y', parentId: null, sortOrder: 0, createdAt: 2000 };
    let manifestGetCount = 0;
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        manifestGetCount += 1;
        const folders = manifestGetCount === 1 ? { fx: folderX } : { fx: folderX, fy: folderY };
        return Promise.resolve(makeOkResponse(makeManifestV3(folders, {}, 'main', `sha${manifestGetCount}`)));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    let manifestPutCount = 0;
    const manifestPutBodies = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        manifestPutCount += 1;
        manifestPutBodies.push(JSON.parse(opts.body));
        if (manifestPutCount === 1) {
          return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ code: 'sync_manifest_stale' }) });
        }
        return Promise.resolve(makeOkResponse({ sha: 'm-sha-2' }));
      }
      return Promise.resolve({ ok: true });
    });
    const onApplyStructure = vi.fn().mockImplementation(async ({ folders }) => ({ ok: true, folders, fileParentIds: {} }));

    await syncAll({
      files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn(),
      folders: [folderX], filesLoaded: true, foldersLoaded: true, onApplyStructure,
    });

    expect(manifestPutCount).toBe(2);
    // 1 回目は最初の manifest 読み取り（fy を知らない）を基に merge した結果。
    expect(manifestPutBodies[0].folders).not.toHaveProperty('fy');
    // 2 回目は読み直した remote（fy を含む）を再 merge した結果。
    expect(manifestPutBodies[1].folders).toHaveProperty('fy');
    expect(manifestPutBodies[1].folders).toHaveProperty('fx');
  });

  it('I2: countSyncWork は folders/structure を数えない（file 側の差分のみで total が決まる）', () => {
    const files = [{ id: 'a' }];
    const remoteFiles = { a: { id: 'a', hash: 'a'.repeat(64) } };
    const localHashes = { a: 'a'.repeat(64) };
    expect(countSyncWork(files, remoteFiles, new Set(['a']), localHashes)).toBe(0);
  });

  it('item6a/item9: remote の不正 folder entry（malformed）は解釈できなくても書き戻し時に生のまま残す', async () => {
    const folderA = { id: 'fa', name: 'A', parentId: null, sortOrder: 0, createdAt: 1000 };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(makeOkResponse({
          version: 3, _branch: 'main', _sha: 'sha1',
          // fa は正常な entry、bad は不正な value（非オブジェクト）。
          folders: { fa: folderA, bad: 'not-an-object' },
          files: {},
        }));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const manifestPutBodies = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        manifestPutBodies.push(JSON.parse(opts.body));
        return Promise.resolve(makeOkResponse({ sha: 'm-sha-2' }));
      }
      return Promise.resolve({ ok: true });
    });
    const onApplyStructure = vi.fn().mockImplementation(async ({ folders }) => ({ ok: true, folders, fileParentIds: {} }));

    await syncAll({
      files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn(),
      folders: [folderA], filesLoaded: true, foldersLoaded: true, onApplyStructure,
    });

    expect(manifestPutBodies).toHaveLength(1);
    expect(manifestPutBodies[0].folders.fa).toBeDefined();
    // 不正な entry を削除として伝搬させず、生のまま carryOver する。
    expect(manifestPutBodies[0].folders.bad).toBe('not-an-object');
  });

  it('item6: hydrate 未完了 かつ remote v2（folders 無し）なら folders キーを書かず version も remote のまま維持する', async () => {
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(makeOkResponse({ version: 2, _branch: 'main', _sha: 'sha1', files: {} }));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const manifestPutBodies = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        manifestPutBodies.push(JSON.parse(opts.body));
        return Promise.resolve(makeOkResponse({ sha: 'm-sha-2' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({
      files: [{ id: 'a', name: 'a.md', content: 'x', github: null, updatedAt: Date.now() }],
      deviceId: 'd1', branch: 'main', onBranch: vi.fn(),
      // filesLoaded/foldersLoaded を渡さない → structureReady=false。
    });

    expect(manifestPutBodies).toHaveLength(1);
    expect(manifestPutBodies[0]).not.toHaveProperty('folders');
    expect(manifestPutBodies[0].version).toBe(2);
  });

  it('item13: remote v3 で folders が非 dict（配列）なら corrupt として fail-closed にし manifest を書かない', async () => {
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        // worker は v3 write で folders を dict 必須にするため、この形状は手編集等の破損
        // でしか生じない。structure unknown で継続すると、次に書き戻す際 folders:{} を
        // 書いて「全 folder 削除」として増幅しうる（敵対的 N-A3 クラス）。
        return Promise.resolve(makeOkResponse({ version: 3, _branch: 'main', _sha: 'sha1', files: {}, folders: [] }));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const manifestPutBodies = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        manifestPutBodies.push(JSON.parse(opts.body));
        return Promise.resolve(makeOkResponse({ sha: 'm-sha-2' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({
      files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn(),
      folders: [], filesLoaded: true, foldersLoaded: true,
    });

    const { getSyncStatus } = await import('./sync');
    expect(getSyncStatus().errorCategory).toBe('corrupt');
    expect(manifestPutBodies).toHaveLength(0);
    expect(
      dbPut.mock.calls.filter(([store, rec]) => store === 'syncState' && rec.id === '#structure'),
    ).toHaveLength(0);
  });

  it('item19/F2: remote version が非整数（文字列 "3"）× local folders 空 → folders は生 carryOver・version 据え置き・parentId 無し', async () => {
    const remoteFolders = { fa: { id: 'fa', name: 'A', parentId: null, sortOrder: 0, createdAt: 1000 } };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        // version が文字列 "3" → parseFormatVersion が LEGACY_DEFAULT(2) へ倒す
        // （非整数）。folders は実在の dict だが known 判定は formatVersion 側で false になる。
        return Promise.resolve(makeOkResponse({
          version: '3', _branch: 'main', _sha: 'sha1', files: {}, folders: remoteFolders,
        }));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const manifestPutBodies = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        manifestPutBodies.push(JSON.parse(opts.body));
        return Promise.resolve(makeOkResponse({ sha: 'm-sha-2' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({
      files: [{ id: 'a', name: 'a.md', content: 'x', github: null, updatedAt: Date.now() }],
      deviceId: 'd1', branch: 'main', onBranch: vi.fn(),
      folders: [], filesLoaded: true, foldersLoaded: true,
    });

    expect(manifestPutBodies).toHaveLength(1);
    expect(manifestPutBodies[0].version).toBe(2);
    expect(manifestPutBodies[0].folders).toEqual(remoteFolders);
    expect(manifestPutBodies[0].files.a).not.toHaveProperty('parentId');
    expect(
      dbPut.mock.calls.filter(([store, rec]) => store === 'syncState' && rec.id === '#structure'),
    ).toHaveLength(0);
  });

  it('item19/F2: remote v2 × folders dict 実在（rollback 残存）× local folders 空 → 同様に生 carryOver・version 据え置き', async () => {
    const remoteFolders = { fa: { id: 'fa', name: 'A', parentId: null, sortOrder: 0, createdAt: 1000 } };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(makeOkResponse({
          version: 2, _branch: 'main', _sha: 'sha1', files: {}, folders: remoteFolders,
        }));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const manifestPutBodies = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        manifestPutBodies.push(JSON.parse(opts.body));
        return Promise.resolve(makeOkResponse({ sha: 'm-sha-2' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({
      files: [{ id: 'a', name: 'a.md', content: 'x', github: null, updatedAt: Date.now() }],
      deviceId: 'd1', branch: 'main', onBranch: vi.fn(),
      folders: [], filesLoaded: true, foldersLoaded: true,
    });

    expect(manifestPutBodies).toHaveLength(1);
    expect(manifestPutBodies[0].version).toBe(2);
    expect(manifestPutBodies[0].folders).toEqual(remoteFolders);
    expect(manifestPutBodies[0].files.a).not.toHaveProperty('parentId');
  });

  it('item19/F2 回帰（E1）: remote v2 × local に folders あり → v3 で local を書く（初回移行）', async () => {
    const folderA = { id: 'fa', name: 'A', parentId: null, sortOrder: 0, createdAt: 1000 };
    const onApplyStructure = vi.fn().mockImplementation(async ({ folders }) => ({ ok: true, folders, fileParentIds: {} }));
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') {
        return Promise.resolve(makeOkResponse({ version: 2, _branch: 'main', _sha: 'sha1', files: {} }));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const manifestPutBodies = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        manifestPutBodies.push(JSON.parse(opts.body));
        return Promise.resolve(makeOkResponse({ sha: 'm-sha-2' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({
      files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn(),
      folders: [folderA], filesLoaded: true, foldersLoaded: true, onApplyStructure,
    });

    expect(manifestPutBodies).toHaveLength(1);
    expect(manifestPutBodies[0].version).toBe(3);
    expect(manifestPutBodies[0].folders).toHaveProperty('fa');
  });

  it('R-1: onApplyStructure 未指定でも manifest は merge 結果を書くが structure base は進めない（契約4(a)）', async () => {
    const folderA = { id: 'fa', name: 'A', parentId: null, sortOrder: 0, createdAt: 1000 };
    workerFetch.mockImplementation((path) => {
      if (path === '/sync/manifest') return Promise.resolve(makeOkResponse(makeManifestV3({}, {})));
      return Promise.resolve({ ok: false, status: 404 });
    });
    const manifestPutBodies = [];
    workerFetchWithCSRF.mockImplementation((path, opts) => {
      if (path === '/sync/manifest' && opts?.method === 'PUT') {
        manifestPutBodies.push(JSON.parse(opts.body));
        return Promise.resolve(makeOkResponse({ sha: 'm-sha-2' }));
      }
      return Promise.resolve({ ok: true });
    });

    await syncAll({
      files: [], deviceId: 'd1', branch: 'main', onBranch: vi.fn(),
      folders: [folderA], filesLoaded: true, foldersLoaded: true,
      // onApplyStructure 未指定。
    });

    expect(manifestPutBodies[0].folders).toHaveProperty('fa');
    expect(
      dbPut.mock.calls.filter(([store, rec]) => store === 'syncState' && rec.id === '#structure'),
    ).toHaveLength(0);
  });
});

// このファイルの最後に置く: vi.resetModules() でモジュールキャッシュを破棄するため、
// 以降に他のテストが続くと共有の `_status`（getSyncStatus 経由で参照される多数のテスト）が
// 意図せず新しいモジュール実体に切り替わってしまう。
describe('syncFileSilent — _snapshotRef 未取得なら送らない（#609 A-2）', () => {
  it('syncAll が一度も成功していないモジュールでは通信せず null を返す', async () => {
    vi.resetModules();
    const freshSync = await import('./sync');
    const freshWorkerClient = await import('./workerClient');
    // vi.mock のモック実体は resetModules 後も同一のためコール履歴が残る（`./sync` 自身の
    // モジュール state ―_snapshotRef― だけが新しくなる）。このテストで見るのは
    // 「これから呼ぶ syncFileSilent が通信するか」なので、直前までの履歴を消してから呼ぶ。
    vi.clearAllMocks();

    const file = { id: 'a', name: 'a', content: 'x', updatedAt: Date.now(), isDirty: true };
    const result = await freshSync.syncFileSilent(file, 'main');

    expect(result).toBeNull();
    expect(freshWorkerClient.workerFetch).not.toHaveBeenCalled();
    expect(freshWorkerClient.workerFetchWithCSRF).not.toHaveBeenCalled();
  });

  // 完了条件11: リロード後も最終同期時刻が表示される（meta.lastSyncedAt からの起動時 1 回読み）。
  it('起動時に meta.lastSyncedAt を読んで _status の初期値にする', async () => {
    vi.resetModules();
    const { dbGet: freshDbGet } = await import('./db');
    freshDbGet.mockResolvedValueOnce({ key: 'lastSyncedAt', value: 1700000000000 });
    const freshSync = await import('./sync');

    await vi.waitFor(() => expect(freshSync.getSyncStatus().lastSyncedAt).toBe(1700000000000));
  });
});
