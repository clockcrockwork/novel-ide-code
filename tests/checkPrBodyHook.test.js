import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildBody } from './helpers/checkArtifactsBody.js';
import { makeTmpGitRepo, sh, write } from './helpers/tmpGitRepo.js';

// scripts/agent/hooks/check-pr-body.js（PreToolUse hook: create_pull_request /
// update_pull_request の前に PR 本文を検査する）のプロセスレベルの回帰テスト。
// #645: warnings（Authority receipt が fallback/stale 等）を非ブロッキングでエージェントへ
// 気づかせる経路の検証。Claude Code hook 仕様（https://code.claude.com/docs/en/hooks.md）では
// PreToolUse hook の stderr は exit 2 のときのみエージェントへ渡り、exit 0 の stderr は
// デバッグログにのみ残る。ブロックせずにエージェントへ気づかせるには JSON の
// `hookSpecificOutput.additionalContext` フィールドで stdout へ返す必要がある
// （Codex 指摘: #646。前回の stderr 出力は機能していなかった）。`hookSpecificOutput` に
// `permissionDecision` を含めてはならない —「"allow"」は権限確認そのものをバイパスする
// 値であり、.claude/settings.json でこの hook にマッチする create_pull_request/
// update_pull_request の呼び出しを無条件に自動許可してしまう（Codex 続報指摘: #646）。
//
// hook は origin/<base> との diff で分類するため、独立した一時 git リポジトリ（origin 相当の
// ベアではない一時 repo をリモートとして clone）を作り、実 git 経由で検証する
// （tests/checkArtifactsGitChangedFiles.test.js と同じ tmpGitRepo ヘルパーを使う）。

const HOOK = fileURLToPath(new URL('../scripts/agent/hooks/check-pr-body.js', import.meta.url));
const HEAD = 'a'.repeat(40);

// origin 用の一時 repo（main ブランチに1コミット）と、そこから clone した作業用 repo
// （feature ブランチにコード変更1コミットを積む）を作る。
function makeRepoPair() {
  const originDir = makeTmpGitRepo('check-pr-body-origin-');
  write(originDir, 'README.md', 'base\n');
  sh(originDir, ['add', '.']);
  sh(originDir, ['commit', '-qm', 'base']);

  const workDir = makeTmpGitRepo('check-pr-body-work-');
  sh(workDir, ['remote', 'add', 'origin', originDir]);
  sh(workDir, ['fetch', '-q', 'origin', 'main']);
  sh(workDir, ['checkout', '-qb', 'main', 'origin/main']);
  sh(workDir, ['checkout', '-qb', 'feature']);
  write(workDir, 'src/foo.js', 'export const x = 1;\n');
  sh(workDir, ['add', '.']);
  sh(workDir, ['commit', '-qm', 'add src/foo.js']);
  return { originDir, workDir };
}

function runHook(cwd, body) {
  return spawnSync(process.execPath, [HOOK], {
    cwd,
    input: JSON.stringify({
      tool_name: 'create_pull_request',
      tool_input: { body, base: 'main' },
    }),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HEAD_SHA: HEAD,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

test('hook: authority receiptがfallback宣言（warnings発生・errorsなし）→ exit 0 かつ stdout の JSON additionalContext にエージェント向け警告が乗る（permissionDecisionは指定しない）', (t) => {
  const { originDir, workDir } = makeRepoPair();
  t.after(() => {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });
  const loop = `Tier: Light（テスト用コード変更）
Authority receipt: v1 head=${HEAD} authority=fallback selected=- escalated=- conditional=- effective=- sidecars=-

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`;
  const r = runHook(workDir, buildBody({ loop }));
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  // permissionDecision は絶対に含めない — "allow" は権限確認バイパスを意味し、
  // .claude/settings.json でこの hook にマッチする create_pull_request/update_pull_request の
  // 呼び出しを無条件に自動許可してしまう（Codex 指摘: #646）
  assert.equal(parsed.hookSpecificOutput.permissionDecision, undefined);
  assert.ok(
    typeof parsed.hookSpecificOutput.additionalContext === 'string' &&
      parsed.hookSpecificOutput.additionalContext.includes('⚠'),
  );
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('fallback'));
});

test('hook: warningsが無い通常のreceiptなし本文 → exit 0 かつ stdout は空（additionalContextを出さない）', (t) => {
  const { originDir, workDir } = makeRepoPair();
  t.after(() => {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });
  const r = runHook(workDir, buildBody());
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(r.stdout, '');
});

test('hook: errorsが出る本文 → 従来どおり exit 2 + stderr（JSON化しない）', (t) => {
  const { originDir, workDir } = makeRepoPair();
  t.after(() => {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });
  const r = runHook(workDir, buildBody({ loop: 'Tier: Light（テスト用コード変更）' }));
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('artifacts-gate'));
});

// 外部レビュー（Codex）続報: hook が `resolveHeadSha()`（--head-sha引数 → HEAD_SHA env → git の順）
// を呼んでいたため、セッション環境に古い `HEAD_SHA` が残っていた場合（過去の action/CLI 呼び出しの
// export し忘れ等）、実際の git HEAD とは無関係な値が「現在の HEAD」として使われてしまっていた。
// 実際の git HEAD と一致する receipt を書いても、env の HEAD_SHA が別の値であれば stale 判定に
// なり、CI（実際の pull_request.head.sha を使う）と結果が食い違う。hook は override を一切
// 通さない gitHeadSha() を直接使うよう修正した。
test('hook: 環境変数 HEAD_SHA が残っていてもローカルの実際のgit HEADで判定する（Codex続報）', (t) => {
  const { originDir, workDir } = makeRepoPair();
  t.after(() => {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });
  const realHead = sh(workDir, ['rev-parse', 'HEAD']).trim();
  const staleEnvHead = 'b'.repeat(40); // セッション環境に残った、実際の HEAD とは無関係な値を模す
  const loop = `Tier: Light（テスト用コード変更）
Authority receipt: v1 head=${realHead} authority=authority selected=riskmodel escalated=- conditional=- effective=riskmodel sidecars=-

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | risk-model 検証 | 0件 | 収束 |`;
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: workDir,
    input: JSON.stringify({
      tool_name: 'create_pull_request',
      tool_input: { body: buildBody({ loop }), base: 'main' },
    }),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HEAD_SHA: staleEnvHead,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // 修正前は HEAD_SHA（staleEnvHead）が優先され、receipt の head（realHead）と不一致で
  // stale 扱いになり additionalContext に警告が出ていた。修正後は実際の git HEAD（realHead）で
  // 判定するため一致し、receipt が採用されて警告は出ない
  assert.equal(r.stdout, '');
});
