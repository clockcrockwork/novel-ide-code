import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { gitChangedFiles } from '../scripts/agent/check-artifacts.js';
import { makeTmpGitRepo, sh, write } from './helpers/tmpGitRepo.js';

// gitChangedFiles の rename バイパス対策（#446 観点別レビュー 敵対的F1）を実 git リポジトリで検証する。
// gitChangedFiles は cwd オプションを持たない（本番の呼び出し元は常にリポジトリルートで実行する
// ため、テスト専用の API 拡張は避ける。#446 round2 観点別レビュー 品質#5）。process.chdir で
// 一時リポジトリへ切り替え、テスト後に必ず元の cwd へ戻す（#446 round3: chdir は1つのヘルパーに
// 集約する）。

function makeRepo() {
  const dir = makeTmpGitRepo('gitchangedfiles-');
  write(dir, 'README.md', 'base\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'base']);
  return dir;
}

// dir へ chdir した状態で fn を実行し、必ず元の cwd へ戻す。dir の rmSync は呼び出し側の責務
// （t.after 等）— このヘルパーは chdir の対称性だけを保証する。
function withChdir(dir, fn) {
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prevCwd);
  }
}

test('gitChangedFiles: rename しても旧パス（code）が消えない（--no-renames。#446）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // git のデフォルトの rename 検出だと `git mv src/evil.js docs/evil.md` は
  // `git diff --name-only` で新パス docs/evil.md のみを報告し、旧パス src/evil.js
  // （code 判定される拡張子）が消える。中身をほぼ同一に保ち rename 類似度検出を確実に発火させる。
  write(dir, 'src/evil.js', 'export const payload = 1;\nexport const filler = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'add src/evil.js']);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  sh(dir, ['mv', 'src/evil.js', 'docs/evil.md']);
  sh(dir, ['commit', '-qm', 'rename to docs/evil.md']);

  const files = withChdir(dir, () => gitChangedFiles('HEAD~1'));
  assert.ok(files.includes('src/evil.js'), `旧パスが検出されるべき: ${JSON.stringify(files)}`);
  assert.ok(files.includes('docs/evil.md'), `新パスも検出されるべき: ${JSON.stringify(files)}`);
});

test('gitChangedFiles: 非 ASCII パスが C-quote されず素通しで返る（core.quotepath=off。#446）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'docs/設計.md', '設計\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'add 設計.md']);

  const files = withChdir(dir, () => gitChangedFiles('HEAD~1'));
  assert.ok(files.includes('docs/設計.md'), `非 ASCII パスがそのまま返るべき: ${JSON.stringify(files)}`);
});

test('gitChangedFiles: base が "-" で始まる場合は git オプション注入を拒否して null を返す（#446 round2 敵対的）', () => {
  // base.startsWith('-') は git を実行する前に判定するため、リポジトリ・chdir は不要
  // （#446 round3 観点別レビュー 減算#4）。
  assert.equal(gitChangedFiles('--this-looks-like-an-option'), null);
});
