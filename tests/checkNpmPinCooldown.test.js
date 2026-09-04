import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';

import {
  checkNpmPinCooldown,
  parseMinReleaseAge,
  parseEnginesNpmRange,
  parseRegistry,
  resolvePin,
  NPM_PIN_ALLOWED_MAJORS,
  MIN_RELEASE_AGE_FLOOR_DAYS,
} from '../scripts/agent/check-npm-pin-cooldown.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '../scripts/agent/check-npm-pin-cooldown.js');
const REPO_NPMRC = join(HERE, '../.npmrc');
const REPO_PACKAGE_JSON = join(HERE, '../package.json');
const CI_YML_PATH = join(HERE, '../.github/workflows/ci.yml');

function fakeFetchOk(timeMap) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ time: timeMap }),
  });
}

function neverCallFetch() {
  return async () => {
    throw new Error('fetch should not be called');
  };
}

// 一時フィクスチャ（.npmrc / package.json / worker 側ファイル）を作って fn を呼び、必ず後始末する。
// paths は { ファイル名: 実パス } のマップ。dir は生成したフィクスチャディレクトリ自体（存在しない
// ファイルのパスを組み立てたいテスト向け）。
async function withTempFixture(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'npm-pin-fixture-'));
  try {
    const paths = {};
    for (const [name, fileContent] of Object.entries(files)) {
      const filePath = join(dir, name);
      writeFileSync(filePath, fileContent);
      paths[name] = filePath;
    }
    return await fn(paths, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- CLI: exit code 配線の確認は1件のみ（他の入力バリエーションは in-process 呼び出し） ---

test('CLI: 不正な NPM_PIN は exit 1 + エラーメッセージ（exit code 配線の確認）', () => {
  const { status, stderr } = spawnSync('node', [SCRIPT], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, NPM_PIN: '^11.19.0' },
  });
  assert.equal(status, 1);
  assert.match(stderr, /exact semver/);
});

// --- symlink 経路でも main が実行されること（敵対的 round7 F-2 の回帰テスト） ---

test('CLI: symlink 経由で起動しても main が実行される（fail-open にならない）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'npm-pin-symlink-'));
  const linkPath = join(dir, 'check-npm-pin-cooldown-link.js');
  try {
    symlinkSync(SCRIPT, linkPath);
    const { status, stderr } = spawnSync('node', [linkPath], {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH, NPM_PIN: '^11' },
    });
    assert.equal(status, 1);
    assert.match(stderr, /exact semver/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --preserve-symlinks-main + symlink 経由でも main が実行される（round11 NEW-7）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'npm-pin-symlink-preserve-'));
  const linkPath = join(dir, 'check-npm-pin-cooldown-link.js');
  try {
    symlinkSync(SCRIPT, linkPath);
    const { status, stderr } = spawnSync('node', ['--preserve-symlinks-main', linkPath], {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH, NPM_PIN: '^11' },
    });
    assert.equal(status, 1);
    assert.match(stderr, /exact semver/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 形式拒否（in-process） ---

test('format: range 指定は拒否される（^11.19.0）', async () => {
  const result = await checkNpmPinCooldown({ pin: '^11.19.0', fetchImpl: neverCallFetch() });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'value');
});

test('format: prerelease 指定は拒否される（11.19.0-beta.1）', async () => {
  const result = await checkNpmPinCooldown({ pin: '11.19.0-beta.1', fetchImpl: neverCallFetch() });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'value');
});

test('format: 改行を含む値は拒否される（injection 対策）', async () => {
  const result = await checkNpmPinCooldown({ pin: '11.19.0\ninjected', fetchImpl: neverCallFetch() });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'value');
});

test('format: __proto__ は拒否される', async () => {
  const result = await checkNpmPinCooldown({ pin: '__proto__', fetchImpl: neverCallFetch() });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'value');
});

test('format: constructor は拒否される', async () => {
  const result = await checkNpmPinCooldown({ pin: 'constructor', fetchImpl: neverCallFetch() });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'value');
});

// --- 許容メジャー範囲（NPM_PIN_ALLOWED_MAJORS） ---

test('major: 許容範囲外のメジャー（12.0.0）は value で拒否される', async () => {
  assert.deepEqual(NPM_PIN_ALLOWED_MAJORS, [11]);
  const result = await checkNpmPinCooldown({
    pin: '12.0.0',
    npmrcPath: REPO_NPMRC,
    packageJsonPath: REPO_PACKAGE_JSON,
    fetchImpl: neverCallFetch(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'value');
  assert.match(result.message, /メジャー版/);
});

// --- .npmrc パーサ（F-1 の各クラス。config エラー） ---

test('.npmrc: min-release-age が0は config エラー', () => {
  const r = parseMinReleaseAge('min-release-age=0\n');
  assert.equal(r.ok, false);
});

test('.npmrc: min-release-age が空値は config エラー', () => {
  const r = parseMinReleaseAge('min-release-age=\n');
  assert.equal(r.ok, false);
});

test('.npmrc: min-release-age が負数は config エラー', () => {
  const r = parseMinReleaseAge('min-release-age=-1\n');
  assert.equal(r.ok, false);
});

test('.npmrc: min-release-age が小数は config エラー', () => {
  const r = parseMinReleaseAge('min-release-age=6.99\n');
  assert.equal(r.ok, false);
});

test('.npmrc: min-release-age の重複キーは config エラー', () => {
  const r = parseMinReleaseAge('min-release-age=7\nmin-release-age=14\n');
  assert.equal(r.ok, false);
  assert.match(r.reason, /重複/);
});

test('.npmrc: [section] 記法があれば config エラー', () => {
  const r = parseMinReleaseAge('[registry]\nmin-release-age=7\n');
  assert.equal(r.ok, false);
  assert.match(r.reason, /section/);
});

test('.npmrc: min-release-age 欠落は config エラー', () => {
  const r = parseMinReleaseAge('registry=https://registry.npmjs.org/\n');
  assert.equal(r.ok, false);
});

test('.npmrc: 正当な min-release-age は pass する', () => {
  const r = parseMinReleaseAge('# comment\nmin-release-age=7\nengine-strict=true\n');
  assert.equal(r.ok, true);
  assert.equal(r.value, 7);
});

// round11 NEW-2: MIN_RELEASE_AGE_FLOOR_DAYS 未満は config（同一 PR で .npmrc の閾値自体を
// 下げて cooldown 検証をバイパスする経路を閉じる）。

test('.npmrc: min-release-age が floor（7）未満なら config エラー', () => {
  assert.equal(MIN_RELEASE_AGE_FLOOR_DAYS, 7);
  const r = parseMinReleaseAge('min-release-age=3\n');
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(String(MIN_RELEASE_AGE_FLOOR_DAYS)));
});

test('.npmrc: min-release-age が floor と同値（7）なら pass する', () => {
  const r = parseMinReleaseAge(`min-release-age=${MIN_RELEASE_AGE_FLOOR_DAYS}\n`);
  assert.equal(r.ok, true);
  assert.equal(r.value, MIN_RELEASE_AGE_FLOOR_DAYS);
});

test('worker/.npmrc: root と min-release-age が不一致なら config エラー', async () => {
  const result = await withTempFixture(
    {
      '.npmrc': 'min-release-age=7\n',
      'package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
      'worker.npmrc': 'min-release-age=14\n',
      'worker-package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
    },
    (paths) =>
      checkNpmPinCooldown({
        pin: '11.19.0',
        npmrcPath: paths['.npmrc'],
        packageJsonPath: paths['package.json'],
        workerNpmrcPath: paths['worker.npmrc'],
        workerPackageJsonPath: paths['worker-package.json'],
        fetchImpl: neverCallFetch(),
      }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'config');
  assert.match(result.message, /一致しません/);
});

test('worker/.npmrc: ファイル自体が無ければ config エラー（round13 NF-3。root と対称の防御が必須）', async () => {
  const result = await withTempFixture(
    {
      '.npmrc': 'min-release-age=7\n',
      'package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
      'worker-package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
    },
    (paths, dir) =>
      checkNpmPinCooldown({
        pin: '11.19.0',
        npmrcPath: paths['.npmrc'],
        packageJsonPath: paths['package.json'],
        workerNpmrcPath: join(dir, 'does-not-exist.npmrc'),
        workerPackageJsonPath: paths['worker-package.json'],
        fetchImpl: neverCallFetch(),
      }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'config');
  assert.match(result.message, /worker\/\.npmrc がありません/);
});

// round11 NEW-1: worker/.npmrc がファイルとして存在する場合は min-release-age キー必須（欠落・
// コメントアウト・キー名違いで一致検査をバイパスできてはならない）。

test('worker/.npmrc: ファイルが存在してもキーが無ければ config エラー（キー削除）', async () => {
  const result = await withTempFixture(
    {
      '.npmrc': 'min-release-age=7\n',
      'package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
      'worker.npmrc': 'engine-strict=true\n',
      'worker-package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
    },
    (paths) =>
      checkNpmPinCooldown({
        pin: '11.19.0',
        npmrcPath: paths['.npmrc'],
        packageJsonPath: paths['package.json'],
        workerNpmrcPath: paths['worker.npmrc'],
        workerPackageJsonPath: paths['worker-package.json'],
        fetchImpl: neverCallFetch(),
      }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'config');
});

test('worker/.npmrc: キーがコメントアウトされていれば config エラー', async () => {
  const result = await withTempFixture(
    {
      '.npmrc': 'min-release-age=7\n',
      'package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
      'worker.npmrc': '# min-release-age=7\n',
      'worker-package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
    },
    (paths) =>
      checkNpmPinCooldown({
        pin: '11.19.0',
        npmrcPath: paths['.npmrc'],
        packageJsonPath: paths['package.json'],
        workerNpmrcPath: paths['worker.npmrc'],
        workerPackageJsonPath: paths['worker-package.json'],
        fetchImpl: neverCallFetch(),
      }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'config');
});

test('worker/.npmrc: キー名が違えば（min_release_age 等）config エラー', async () => {
  const result = await withTempFixture(
    {
      '.npmrc': 'min-release-age=7\n',
      'package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
      'worker.npmrc': 'min_release_age=7\n',
      'worker-package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
    },
    (paths) =>
      checkNpmPinCooldown({
        pin: '11.19.0',
        npmrcPath: paths['.npmrc'],
        packageJsonPath: paths['package.json'],
        workerNpmrcPath: paths['worker.npmrc'],
        workerPackageJsonPath: paths['worker-package.json'],
        fetchImpl: neverCallFetch(),
      }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'config');
});

// --- registry= の反映（round11 NEW-3: 検証は常に公式 registry。.npmrc の registry= は突合のみ） ---

test('registry: .npmrc に無ければ既定の registry.npmjs.org', () => {
  assert.equal(parseRegistry('package-lock=true\n'), 'https://registry.npmjs.org');
});

test('registry: .npmrc の registry= の値自体は取得できる（スコープ registry は対象外）', () => {
  const content = '@tiptap:registry=https://registry.npmjs.org/\nregistry=https://custom.example.com/\n';
  assert.equal(parseRegistry(content), 'https://custom.example.com/');
});

test('registry: 非公式 registry を指す .npmrc は config エラー（証拠源の差し替えを拒否）', async () => {
  const result = await withTempFixture(
    {
      '.npmrc': 'min-release-age=7\nregistry=https://evil.example.test/\n',
      'package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
      'worker.npmrc': 'min-release-age=7\n',
      'worker-package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
    },
    (paths) =>
      checkNpmPinCooldown({
        pin: '11.19.0',
        npmrcPath: paths['.npmrc'],
        packageJsonPath: paths['package.json'],
        workerNpmrcPath: paths['worker.npmrc'],
        workerPackageJsonPath: paths['worker-package.json'],
        fetchImpl: neverCallFetch(),
      }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'config');
  assert.match(result.message, /公式/);
});

test('registry: registry= 未設定なら常に公式 registry へ fetch する', async () => {
  const publishedAt = new Date('2026-01-01T00:00:00Z');
  const now = () => publishedAt.getTime() + 30 * 86_400_000;
  const calledUrls = [];
  const result = await withTempFixture(
    {
      '.npmrc': 'min-release-age=7\n',
      'package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
      'worker.npmrc': 'min-release-age=7\n',
      'worker-package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
    },
    (paths) =>
      checkNpmPinCooldown({
        pin: '11.19.0',
        npmrcPath: paths['.npmrc'],
        packageJsonPath: paths['package.json'],
        workerNpmrcPath: paths['worker.npmrc'],
        workerPackageJsonPath: paths['worker-package.json'],
        now,
        fetchImpl: async (url) => {
          calledUrls.push(url);
          return { ok: true, status: 200, json: async () => ({ time: { '11.19.0': publishedAt.toISOString() } }) };
        },
      }),
  );
  assert.equal(result.ok, true);
  assert.equal(calledUrls.length, 1);
  assert.equal(calledUrls[0], 'https://registry.npmjs.org/npm');
});

test('registry: 公式 registry を明示（末尾スラッシュ付き）していても OK', async () => {
  const publishedAt = new Date('2026-01-01T00:00:00Z');
  const now = () => publishedAt.getTime() + 30 * 86_400_000;
  const calledUrls = [];
  const result = await withTempFixture(
    {
      '.npmrc': 'min-release-age=7\nregistry=https://registry.npmjs.org/\n',
      'package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
      'worker.npmrc': 'min-release-age=7\n',
      'worker-package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
    },
    (paths) =>
      checkNpmPinCooldown({
        pin: '11.19.0',
        npmrcPath: paths['.npmrc'],
        packageJsonPath: paths['package.json'],
        workerNpmrcPath: paths['worker.npmrc'],
        workerPackageJsonPath: paths['worker-package.json'],
        now,
        fetchImpl: async (url) => {
          calledUrls.push(url);
          return { ok: true, status: 200, json: async () => ({ time: { '11.19.0': publishedAt.toISOString() } }) };
        },
      }),
  );
  assert.equal(result.ok, true);
  assert.equal(calledUrls[0], 'https://registry.npmjs.org/npm');
});

// --- engines.npm の range 拡張（>=x.y.z / 上限 <N・<N.M.P / ^x.y.z / 空白） ---

test('engines range: ">=x.y.z" 単独', () => {
  const r = parseEnginesNpmRange('>=11.10.0');
  assert.equal(r.ok, true);
  assert.deepEqual(r.min, [11, 10, 0]);
  assert.equal(r.max, null);
});

test('engines range: 前後空白を許容する', () => {
  const r = parseEnginesNpmRange('  >=11.10.0  ');
  assert.equal(r.ok, true);
  assert.deepEqual(r.min, [11, 10, 0]);
});

test('engines range: 上限 "<N"（メジャーのみ）', () => {
  const r = parseEnginesNpmRange('>=11.10.0 <12');
  assert.equal(r.ok, true);
  assert.deepEqual(r.max, [12, 0, 0]);
});

test('engines range: 上限 "<N.M.P"（フル）', () => {
  const r = parseEnginesNpmRange('>=11.10.0 <11.19.0');
  assert.equal(r.ok, true);
  assert.deepEqual(r.max, [11, 19, 0]);
});

test('engines range: caret "^x.y.z" は暗黙の上限を持つ', () => {
  const r = parseEnginesNpmRange('^11.10.0');
  assert.equal(r.ok, true);
  assert.deepEqual(r.min, [11, 10, 0]);
  assert.deepEqual(r.max, [12, 0, 0]);
});

test('engines range: 未対応形式（~x.y.z）は config エラー', () => {
  const r = parseEnginesNpmRange('~11.10.0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /未対応/);
});

test('engines: pin が上限に達していれば value で拒否される', async () => {
  const result = await withTempFixture(
    {
      '.npmrc': 'min-release-age=7\n',
      'package.json': JSON.stringify({ engines: { npm: '>=11.10.0 <11.19.0' } }),
      'worker.npmrc': 'min-release-age=7\n',
      'worker-package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
    },
    (paths) =>
      checkNpmPinCooldown({
        pin: '11.19.0',
        npmrcPath: paths['.npmrc'],
        packageJsonPath: paths['package.json'],
        workerNpmrcPath: paths['worker.npmrc'],
        workerPackageJsonPath: paths['worker-package.json'],
        fetchImpl: neverCallFetch(),
      }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'value');
});

test('engines: root と worker の両方が検査される（worker 不整合は value）', async () => {
  const result = await withTempFixture(
    {
      '.npmrc': 'min-release-age=7\n',
      'package.json': JSON.stringify({ engines: { npm: '>=11.10.0' } }),
      'worker.npmrc': 'min-release-age=7\n',
      'worker-package.json': JSON.stringify({ engines: { npm: '>=12.0.0' } }),
    },
    (paths) =>
      checkNpmPinCooldown({
        pin: '11.19.0',
        npmrcPath: paths['.npmrc'],
        packageJsonPath: paths['package.json'],
        workerNpmrcPath: paths['worker.npmrc'],
        workerPackageJsonPath: paths['worker-package.json'],
        fetchImpl: neverCallFetch(),
      }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'value');
  assert.match(result.message, /worker/);
});

test('engines: 既存 repo の engines.npm 不整合（11.5.0 は >=11.10.0 に落ちる）', async () => {
  const result = await checkNpmPinCooldown({
    pin: '11.5.0',
    npmrcPath: REPO_NPMRC,
    packageJsonPath: REPO_PACKAGE_JSON,
    fetchImpl: neverCallFetch(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'value');
});

// --- registry 応答の分類（transient / value / config） ---

test('registry: 不正な公開日時は拒否される', async () => {
  const result = await checkNpmPinCooldown({
    pin: '11.19.0',
    npmrcPath: REPO_NPMRC,
    packageJsonPath: REPO_PACKAGE_JSON,
    fetchImpl: fakeFetchOk({ '11.19.0': 'not-a-date' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'value');
});

test('boundary: ちょうど7日は pass する', async () => {
  const publishedAt = new Date('2026-01-01T00:00:00Z');
  const now = () => publishedAt.getTime() + 7 * 86_400_000;
  const result = await checkNpmPinCooldown({
    pin: '11.19.0',
    npmrcPath: REPO_NPMRC,
    packageJsonPath: REPO_PACKAGE_JSON,
    fetchImpl: fakeFetchOk({ '11.19.0': publishedAt.toISOString() }),
    now,
  });
  assert.equal(result.ok, true);
});

test('boundary: 6.99日は fail する', async () => {
  const publishedAt = new Date('2026-01-01T00:00:00Z');
  const now = () => publishedAt.getTime() + 6.99 * 86_400_000;
  const result = await checkNpmPinCooldown({
    pin: '11.19.0',
    npmrcPath: REPO_NPMRC,
    packageJsonPath: REPO_PACKAGE_JSON,
    fetchImpl: fakeFetchOk({ '11.19.0': publishedAt.toISOString() }),
    now,
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'value');
});

test('registry: fetch throw は transient', async () => {
  const result = await checkNpmPinCooldown({
    pin: '11.19.0',
    npmrcPath: REPO_NPMRC,
    packageJsonPath: REPO_PACKAGE_JSON,
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'transient');
});

test('registry: 503 は transient', async () => {
  const result = await checkNpmPinCooldown({
    pin: '11.19.0',
    npmrcPath: REPO_NPMRC,
    packageJsonPath: REPO_PACKAGE_JSON,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'transient');
});

test('registry: 429 は transient', async () => {
  const result = await checkNpmPinCooldown({
    pin: '11.19.0',
    npmrcPath: REPO_NPMRC,
    packageJsonPath: REPO_PACKAGE_JSON,
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'transient');
});

test('registry: 404 は value（版が存在しない）', async () => {
  const result = await checkNpmPinCooldown({
    pin: '11.19.0',
    npmrcPath: REPO_NPMRC,
    packageJsonPath: REPO_PACKAGE_JSON,
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'value');
});

test('registry: 403 は config（それ以外の 4xx）', async () => {
  const result = await checkNpmPinCooldown({
    pin: '11.19.0',
    npmrcPath: REPO_NPMRC,
    packageJsonPath: REPO_PACKAGE_JSON,
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'config');
});

test('registry: HTML 応答（JSON パース失敗）は transient', async () => {
  const result = await checkNpmPinCooldown({
    pin: '11.19.0',
    npmrcPath: REPO_NPMRC,
    packageJsonPath: REPO_PACKAGE_JSON,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'transient');
});

test('.npmrc: 欠落は config エラー', async () => {
  const result = await checkNpmPinCooldown({
    pin: '11.19.0',
    npmrcPath: join(HERE, 'does-not-exist.npmrc'),
    packageJsonPath: REPO_PACKAGE_JSON,
    fetchImpl: neverCallFetch(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'config');
});

test('正当な pin は pass する', async () => {
  const publishedAt = new Date('2026-07-29T00:00:00Z');
  const now = () => publishedAt.getTime() + 30 * 86_400_000;
  const result = await checkNpmPinCooldown({
    pin: '11.19.0',
    npmrcPath: REPO_NPMRC,
    packageJsonPath: REPO_PACKAGE_JSON,
    fetchImpl: fakeFetchOk({ '11.19.0': publishedAt.toISOString() }),
    now,
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /OK/);
});

// --- resolvePin（ci.yml からの読み取り。#F10-5） ---

test('resolvePin: env が未設定なら ci.yml の committed NPM_PIN を読む', () => {
  const result = resolvePin({ envPin: undefined, ciYmlPath: CI_YML_PATH });
  assert.equal(result.source, 'ci.yml');
  assert.equal(result.pin, '11.19.0');
});

test('resolvePin: env が設定されていれば env を優先する', () => {
  const result = resolvePin({ envPin: '9.9.9', ciYmlPath: CI_YML_PATH });
  assert.equal(result.source, 'env');
  assert.equal(result.pin, '9.9.9');
});

test('resolvePin: ci.yml が読めない場合は error を返す', () => {
  const result = resolvePin({ envPin: undefined, ciYmlPath: join(HERE, 'does-not-exist.yml') });
  assert.equal(result.pin, undefined);
  assert.ok(result.error);
});

// round11 NEW-4: job/step env での NPM_PIN shadow を resolvePin が検出する（ci.yml 内の
// `NPM_PIN:` キー出現を数え、2箇所以上なら config）。

test('resolvePin: job レベル env に NPM_PIN を足した ci.yml フィクスチャは shadow で config', async () => {
  const fixtureCiYml = [
    'env:',
    '  NPM_PIN: "11.19.0"',
    'jobs:',
    '  lint-test:',
    '    env:',
    '      NPM_PIN: "9.9.9"',
    '',
  ].join('\n');
  const result = await withTempFixture(
    { 'ci.yml': fixtureCiYml },
    (paths) => resolvePin({ envPin: undefined, ciYmlPath: paths['ci.yml'] }),
  );
  assert.equal(result.pin, undefined);
  assert.ok(result.error);
  assert.match(result.error, /shadow/);
});

test('resolvePin: shadow がある場合は env が設定されていても config で止める', async () => {
  const fixtureCiYml = [
    'env:',
    '  NPM_PIN: "11.19.0"',
    'jobs:',
    '  lint-test:',
    '    env:',
    '      NPM_PIN: "9.9.9"',
    '',
  ].join('\n');
  const result = await withTempFixture(
    { 'ci.yml': fixtureCiYml },
    (paths) => resolvePin({ envPin: '11.19.0', ciYmlPath: paths['ci.yml'] }),
  );
  assert.equal(result.pin, undefined);
  assert.ok(result.error);
});

test('resolvePin: NPM_PIN: キーが1箇所だけの ci.yml は shadow ではない', async () => {
  const fixtureCiYml = ['env:', '  NPM_PIN: "11.19.0"', ''].join('\n');
  const result = await withTempFixture(
    { 'ci.yml': fixtureCiYml },
    (paths) => resolvePin({ envPin: undefined, ciYmlPath: paths['ci.yml'] }),
  );
  assert.equal(result.pin, '11.19.0');
  assert.equal(result.source, 'ci.yml');
});

// round11 NEW-5: NPM_PIN 行の行末コメントを許容する。

test('resolvePin: 行末コメント付きの NPM_PIN 行も読み取れる', async () => {
  const fixtureCiYml = ['env:', '  NPM_PIN: "11.19.0" # 更新は docs/SUPPLY_CHAIN.md を参照', ''].join('\n');
  const result = await withTempFixture(
    { 'ci.yml': fixtureCiYml },
    (paths) => resolvePin({ envPin: undefined, ciYmlPath: paths['ci.yml'] }),
  );
  assert.equal(result.pin, '11.19.0');
  assert.equal(result.source, 'ci.yml');
});

test('resolvePin: ci.yml が読めず env pin を使う経路では notice を返す（round13 NF-2）', () => {
  const result = resolvePin({ envPin: '11.19.0', ciYmlPath: join(HERE, 'does-not-exist.yml') });
  assert.equal(result.pin, '11.19.0');
  assert.equal(result.source, 'env');
  assert.ok(result.notice);
  assert.match(result.notice, /shadow 検査は行いません/);
});

test('resolvePin: ci.yml が読める場合は env pin 経路でも notice を出さない', () => {
  const result = resolvePin({ envPin: '9.9.9', ciYmlPath: CI_YML_PATH });
  assert.equal(result.pin, '9.9.9');
  assert.equal(result.notice, undefined);
});
