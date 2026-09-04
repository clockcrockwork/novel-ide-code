import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// 一時 git リポジトリを使う結合テストの共通ヘルパー（#446 round2 観点別レビュー 品質・
// テスト共通化 E12）。tests/checkArtifactsGitChangedFiles.test.js / tests/reviewSnapshot.test.js /
// tests/reviewMetrics.test.js で重複していた sh/write/makeRepo の低レベル部分を集約する。
//
// 契約:
// - `makeTmpGitRepo(prefix)` は一時ディレクトリの作成・`git init -b main`・
//   user.email / user.name / commit.gpgsign の最低限 config までを済ませて返す。
// - 初回コミットの内容・追加のブランチ操作はテストごとに異なるため、ここでは持たない
//   （呼び出し側が `write` / `sh` で行う）。
// - 一時ディレクトリの cleanup（`rmSync`）も呼び出し側の責務（`t.after` 等で行う）。

export function sh(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // ホストの ~/.gitconfig（global）・/etc/gitconfig（system）を隔離する。利用者の環境に
    // core.quotepath / diff.renames / alias 等が設定されていると、rename・quotepath 系の
    // テスト（#446）がホストの設定に依存して結果が変わりうる（#446 round3 観点別レビュー
    // 運用性#8）。GIT_CONFIG_NOSYSTEM は GIT_CONFIG_SYSTEM=/dev/null と目的が重なるが、
    // git バージョン差への保険として両方設定する。
    // 実効範囲の限定（#446 round4 観点別レビュー 敵対的F-r4-4）: この隔離はこの `sh()` 経由の
    // git 呼び出しにのみ効く。テスト対象コード（gitChangedFiles() の execFileSync、
    // review-snapshot.js の git() 等）は `sh()` を経由せず自身の env（process.env を継承）で
    // git を実行するため、この隔離の対象外 — 被検査コード側は自身の明示 `-c` / フラグで
    // 決定性を担保する前提。ただし両者は同じフラグではない（#446 round6 観点別レビュー
    // 品質/運用性）: check-artifacts.js の `gitChangedFiles()` は `-c core.quotepath=off`
    // ＋ `--no-renames`（rename 検出そのものを無効化）。review-snapshot.js の `git()`
    // （`GIT_PATH_OUTPUT`）は `core.quotepath=off` のみで、rename 検出は `--find-renames`
    // を意図的に維持し、rename 元パスは oldPath 補完（expandRenames）で密輸を防ぐ設計。
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

export function write(cwd, rel, content) {
  const p = join(cwd, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

// prefix（例: 'review-snapshot-'）で一時ディレクトリを作り、`git init -b main` と
// user.email / user.name / commit.gpgsign の最低限設定までを済ませて返す。
export function makeTmpGitRepo(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 'test@example.com']);
  sh(dir, ['config', 'user.name', 'test']);
  sh(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
