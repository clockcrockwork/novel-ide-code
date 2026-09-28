import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { KNOWN_DEP_MANIFEST_DIRS } from '../scripts/agent/classify-changes.js';
import { CONTROL_ONLY_DIRS } from '../scripts/policy/public-tree-policy.js';

// KNOWN_DEP_MANIFEST_DIRS（既知の npm プロジェクト直下）の集合が .github/dependabot.yml の
// npm ecosystem の directory 群と drift していないことを検査する（#446 round9）。
// yaml パーサは使わず、`package-ecosystem: npm`（クオート有無を問わない）ブロックの
// `directory:` 行を正規表現で拾う簡潔な実装にする。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEPENDABOT_PATH = join(ROOT, '.github/dependabot.yml');

// .github/dependabot.yml は control-only（CONTROL_ONLY_FILES）で sanitized public tree には含まれない。
// ただし「ファイルが無いから skip」だと control repo で誤削除されても green になるため、skip は
// CONTROL_ONLY_DIRS も全て不在＝public tree 相当のときに限る（tests/agentMemory.test.js と同じ判定）。
// control-only ディレクトリが1つでも存在する（＝control repo）なら skip せず、下の検査で fail させる。
const PUBLIC_TREE_SKIP =
  !existsSync(DEPENDABOT_PATH) && CONTROL_ONLY_DIRS.every((d) => !existsSync(join(ROOT, d)))
    ? '.github/dependabot.yml は control-only（public tree では除外される。#347 / #345）'
    : false;

// directory の表記（`/` / `/worker`）を KNOWN_DEP_MANIFEST_DIRS の表記（`''` / `'worker/'`）へ
// 正規化する。
function normalizeDirectory(dir) {
  const stripped = dir.trim().replace(/^\//, '');
  if (stripped === '') return '';
  return stripped.endsWith('/') ? stripped : `${stripped}/`;
}

// dependabot.yml のテキストから npm ecosystem ブロックの directory 値を抽出する。
function extractNpmDirectories(yamlText) {
  const blocks = yamlText.split(/\n(?=\s*-\s*package-ecosystem:)/);
  const dirs = [];
  for (const block of blocks) {
    const ecoMatch = block.match(/package-ecosystem:\s*["']?([\w-]+)["']?/);
    if (!ecoMatch || ecoMatch[1] !== 'npm') continue;
    const dirMatch = block.match(/^\s*directory:\s*["']?([^"'\n]+?)["']?\s*$/m);
    assert.ok(
      dirMatch,
      'dependabot.yml の npm ecosystem ブロックに directory: 行が見つからない',
    );
    dirs.push(normalizeDirectory(dirMatch[1]));
  }
  return dirs;
}

test('KNOWN_DEP_MANIFEST_DIRS が .github/dependabot.yml の npm ecosystem directory 群と一致する（drift 検査。#446 round9）', { skip: PUBLIC_TREE_SKIP }, () => {
  assert.ok(
    existsSync(DEPENDABOT_PATH),
    'control-only ディレクトリが存在する（control repo）のに .github/dependabot.yml が存在しない（誤削除の疑い）',
  );
  const yamlText = readFileSync(DEPENDABOT_PATH, 'utf-8');
  const npmDirs = extractNpmDirectories(yamlText);
  assert.ok(npmDirs.length > 0, 'dependabot.yml から npm ecosystem の directory を抽出できなかった');

  assert.deepEqual(
    new Set(npmDirs),
    new Set(KNOWN_DEP_MANIFEST_DIRS),
    `KNOWN_DEP_MANIFEST_DIRS（${JSON.stringify(KNOWN_DEP_MANIFEST_DIRS)}）が ` +
      `.github/dependabot.yml の npm ecosystem directory（${JSON.stringify(npmDirs)}）と一致しない。` +
      '新しい npm プロジェクトを追加/削除したら両方を同時に更新すること',
  );
});
