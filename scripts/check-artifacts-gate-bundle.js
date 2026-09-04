import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Artifacts Gate の bundled local action（#428）の drift check。
// npm scripts は shell 依存（sh/bash 前提の `test -z "$(...)"` は Windows の既定シェルで
// 動作しない）を避けるため、cross-platform に動く Node スクリプトとして実装する。
//
// git status --porcelain --untracked-files=all は追跡済み変更・未追跡ファイルの両方を検出する
// （git diff --exit-code は未追跡ファイルを検出しないため不十分。.github/workflows/
// artifacts-gate-bundle.yml と同じロジックをこのスクリプトへ共通化した）。

// ROOT からの絶対パスで対象を指定する（scripts/check-thresholds.js と同じ慣習。
// process.cwd() 依存にすると npm run 以外の呼び出し元で壊れる）
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_PATH = '.github/actions/artifacts-gate/dist';

const drift = execFileSync(
  'git',
  ['status', '--porcelain', '--untracked-files=all', '--', DIST_PATH],
  { cwd: ROOT, encoding: 'utf-8' },
).trim();

if (drift) {
  console.error(
    `check-artifacts-gate-bundle: ${DIST_PATH} が source と一致していません（追跡済み差分または未追跡の新規ファイル）:\n`,
  );
  console.error(drift);
  console.error(
    "\n'npm run build:artifacts-gate' を実行し、生成された dist をコミットしてください。",
  );
  process.exit(1);
}

process.stdout.write('check-artifacts-gate-bundle: OK（bundle は source と一致しています）\n');
