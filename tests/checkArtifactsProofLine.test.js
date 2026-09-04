import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  checkArtifacts,
  computeBodyHash,
  formatProofLine,
  parseProofLine,
  proofLineMatches,
} from '../scripts/agent/check-artifacts.js';
import { FULL_ARTIFACTS } from './helpers/checkArtifactsBody.js';

const CHECK_ARTIFACTS_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../scripts/agent/check-artifacts.js',
);
const ARTIFACTS_GATE_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  '../.github/actions/artifacts-gate/src/index.js',
);

// artifacts-gate の証明行（proof line）: PR 番号・head SHA・本文ハッシュ・判定結果（result:
// ok/failed）の4値で「この run が現在の PR 状態を検証し、かつ検査に通ったか」を判定する
// （docs/ai/rules/ci-run.md §3b、設計根拠は docs/planning/ci-split-design.md §11）。

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
// GITHUB_RUN_ID-GITHUB_RUN_ATTEMPT 形式のダミー値（実際は GitHub が run 作成時に採番する）。
const RUN_ID = '1234567890-1';
const OTHER_RUN_ID = '1234567890-2';

test('formatProofLine / parseProofLine: 往復で同じ値が復元される', () => {
  const line = formatProofLine({
    prNumber: 553,
    headSha: SHA_A,
    bodyHash: 'deadbeef',
    result: 'ok',
    runId: RUN_ID,
  });
  assert.equal(
    line,
    `check-artifacts: proof pr=#553 head=${SHA_A} body-sha256=deadbeef result=ok run=${RUN_ID}`,
  );
  assert.deepEqual(parseProofLine(line), {
    prNumber: '553',
    headSha: SHA_A,
    bodyHash: 'deadbeef',
    result: 'ok',
    runId: RUN_ID,
  });
});

test('parseProofLine: 複数行に混在していても証明行だけを拾う', () => {
  const text = [
    'check-artifacts: OK（必須 artifact を確認）',
    formatProofLine({
      prNumber: 1,
      headSha: SHA_A,
      bodyHash: 'hash1',
      result: 'ok',
      runId: RUN_ID,
    }),
    '::warning::何か別の annotation',
  ].join('\n');
  assert.deepEqual(parseProofLine(text), {
    prNumber: '1',
    headSha: SHA_A,
    bodyHash: 'hash1',
    result: 'ok',
    runId: RUN_ID,
  });
});

test('parseProofLine: 証明行が複数ある場合は最後の1件を正とする', () => {
  const text = [
    formatProofLine({
      prNumber: 1,
      headSha: SHA_A,
      bodyHash: 'old-hash',
      result: 'failed',
      runId: RUN_ID,
    }),
    formatProofLine({
      prNumber: 1,
      headSha: SHA_B,
      bodyHash: 'new-hash',
      result: 'ok',
      runId: OTHER_RUN_ID,
    }),
  ].join('\n');
  assert.deepEqual(parseProofLine(text), {
    prNumber: '1',
    headSha: SHA_B,
    bodyHash: 'new-hash',
    result: 'ok',
    runId: OTHER_RUN_ID,
  });
});

test('parseProofLine: 証明行が無ければ null', () => {
  assert.equal(parseProofLine('check-artifacts: OK（artifact 必須対象外）\n'), null);
});

// 敵対的レビュー A-1/A-2: 証明行と同じ書式の文字列が、警告メッセージ・skip 理由等の中に
// 「文の一部」として埋め込まれても、行全体としては一致しないため受理してはならない。
// GitHub Actions の warning annotation は必ず `::warning::check-artifacts: ` で始まる固定
// プレフィックスの後ろに任意テキストを続ける実装のため、この形を模して検証する。
test('parseProofLine: 証明行が文中に埋め込まれている（前後に別テキストがある）場合は拾わない', () => {
  const forged = formatProofLine({
    prNumber: 1,
    headSha: SHA_B,
    bodyHash: 'forged-hash',
    result: 'ok',
    runId: OTHER_RUN_ID,
  });
  const text = [
    formatProofLine({
      prNumber: 1,
      headSha: SHA_A,
      bodyHash: 'real-hash',
      result: 'ok',
      runId: RUN_ID,
    }),
    `::warning::check-artifacts: 系統セルに受理トークン外の値があります: ${forged}（正本: …）`,
    `::warning::check-artifacts: artifacts-check をスキップしました（理由: メモ ${forged}）`,
  ].join('\n');
  // 埋め込まれた偽の証明行（SHA_B・forged-hash）ではなく、行全体が一致する本物（SHA_A・real-hash）
  // だけが採用される。
  assert.deepEqual(parseProofLine(text), {
    prNumber: '1',
    headSha: SHA_A,
    bodyHash: 'real-hash',
    result: 'ok',
    runId: RUN_ID,
  });
});

test('parseProofLine: 行内に複数の証明行らしき文字列があっても行全体一致でなければ拾わない', () => {
  const forged = formatProofLine({
    prNumber: 1,
    headSha: SHA_B,
    bodyHash: 'forged',
    result: 'ok',
    runId: OTHER_RUN_ID,
  });
  const real = formatProofLine({
    prNumber: 1,
    headSha: SHA_A,
    bodyHash: 'real',
    result: 'ok',
    runId: RUN_ID,
  });
  // 1行に2つ並べても、行全体としてはどちらの書式とも一致しないため受理しない
  // （敵対的レビュー A-7: 「行内は先勝ち」という非対称性を、行全体一致の要求で解消する）。
  assert.equal(parseProofLine(`${forged} ${real}`), null);
});

// 敵対的レビュー2周目 ADV-1: skip 理由に改行を混入させ、GitHub Actions の annotation が
// `%0A` を表示時に改行として復元する（＝タイムスタンプの付かない単独行が生成される）ことを
// 悪用すると、行全体一致（A-1/A-2 対策）を回避して偽の証明行を単独行化できる。
// checkArtifacts() が警告文を組み立てる時点で埋め込み改行を除去し、escapeWorkflowData が
// `%0A` を生成する余地自体を無くすことで、GitHub 側の復元挙動に関わらず閉じる。
test('checkArtifacts: skip 理由に埋め込まれた改行・偽の証明行は警告文から除去される', () => {
  const forgedProofLine = formatProofLine({
    prNumber: '553',
    headSha: SHA_B,
    bodyHash: 'attacker-chosen-hash',
    result: 'ok',
    runId: OTHER_RUN_ID,
  });
  const body = `## 変更の概要\n<!-- artifacts-check: skip (メモ\n${forgedProofLine}\n以上) -->`;
  const { warnings } = checkArtifacts({ changedFiles: ['src/lib/foo.js'], body });
  const skipWarning = warnings.find((w) => w.includes('スキップしました'));
  assert.ok(skipWarning, `skip 警告が見つからない: ${JSON.stringify(warnings)}`);
  // 警告文に生の改行が残っていない（= escapeWorkflowData の %0A エスケープが発生する余地が
  // 無く、GitHub 側の annotation 復元によって単独行化されない）
  assert.equal(skipWarning.includes('\n'), false, skipWarning);
  // 偽の証明行の書式そのものが（改行区切りの単独行としてではなく）警告文中に残っていても、
  // parseProofLine は行全体一致のみ受理するため単体では拾われない
  assert.equal(parseProofLine(skipWarning), null);
});

// 運用性・仕様レビュー2周目（O-13/S-1）: 実際の GitHub Actions ジョブログは全行が
// ISO8601 タイムスタンプで前置される（`get_job_logs` の生テキストそのまま）。行全体一致
// （A-1/A-2 対策）が実運用のログでは一度も成立しない、という致命的な回帰を検出したため、
// 既知の書式のタイムスタンプだけを剥がしてから照合する。
test('parseProofLine: GitHub Actions のタイムスタンプ前置ログでも証明行を拾う', () => {
  const line = formatProofLine({
    prNumber: 553,
    headSha: SHA_A,
    bodyHash: 'h',
    result: 'ok',
    runId: RUN_ID,
  });
  const realisticLog = [
    '2026-08-04T04:58:39.1234567Z check-artifacts: OK（必須 artifact を確認）',
    `2026-08-04T04:58:39.2345678Z ${line}`,
  ].join('\n');
  assert.deepEqual(parseProofLine(realisticLog), {
    prNumber: '553',
    headSha: SHA_A,
    bodyHash: 'h',
    result: 'ok',
    runId: RUN_ID,
  });
});

test('parseProofLine: タイムスタンプを剥がしても、警告文に埋め込まれた偽の証明行は拾わない', () => {
  const forged = formatProofLine({
    prNumber: 1,
    headSha: SHA_B,
    bodyHash: 'forged',
    result: 'ok',
    runId: OTHER_RUN_ID,
  });
  const real = formatProofLine({
    prNumber: 1,
    headSha: SHA_A,
    bodyHash: 'real',
    result: 'ok',
    runId: RUN_ID,
  });
  const realisticLog = [
    `2026-08-04T04:58:39.1234567Z ${real}`,
    `2026-08-04T04:58:40.0000000Z ::warning::check-artifacts: 系統セルに受理トークン外の値があります: ${forged}`,
  ].join('\n');
  assert.deepEqual(parseProofLine(realisticLog), {
    prNumber: '1',
    headSha: SHA_A,
    bodyHash: 'real',
    result: 'ok',
    runId: RUN_ID,
  });
});

test('computeBodyHash: 同一本文は同一ハッシュ、本文が違えばハッシュも違う', () => {
  const h1 = computeBodyHash('本文A');
  const h2 = computeBodyHash('本文A');
  const h3 = computeBodyHash('本文B');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test('computeBodyHash: BOM の有無は無視する（取得経路差の吸収）', () => {
  assert.equal(computeBodyHash('本文'), computeBodyHash('﻿本文'));
});

test('computeBodyHash: null 本文は空文字列として扱う（"null" という文字列と区別する）', () => {
  assert.equal(computeBodyHash(null), computeBodyHash(''));
  assert.notEqual(computeBodyHash(null), computeBodyHash('null'));
});

// 仕様レビュー2周目 S-6: git の SHA は大文字小文字を区別しないため、--head-sha に大文字を
// 渡しても証明行（GitHub 由来で常に小文字）と不一致にならないよう比較側で正規化する。
test('proofLineMatches: head SHA の大文字小文字は区別しない', () => {
  const parsed = parseProofLine(
    formatProofLine({ prNumber: 553, headSha: SHA_A, bodyHash: 'h', result: 'ok', runId: RUN_ID }),
  );
  assert.equal(
    proofLineMatches(parsed, {
      prNumber: 553,
      headSha: SHA_A.toUpperCase(),
      bodyHash: 'h',
      runId: RUN_ID,
    }),
    true,
  );
});

// 敵対的レビュー3周目 ADV-r3-1: GitHub Actions runner 自身が step の `with:` 入力を
// ジョブログへ列0・逐語で出力するため、証明行と同じ書式の**ファイル名**を commit に混入
// させるだけで偽の証明行をログに注入できる（check-artifacts.js の出力経路を通らないため、
// 行全体一致・改行除去のいずれの対策も効かない）。run ID は攻撃者が commit を作る時点では
// 予測できない値（GitHub がその run を実際にスケジュールした時点で確定）であるため、
// pr/head/body-sha256 を偽装できても run ID までは事前に一致させられない。
test('proofLineMatches: pr/head/body-sha256 が一致していても run ID が違えば不一致', () => {
  const parsed = parseProofLine(
    formatProofLine({ prNumber: 553, headSha: SHA_A, bodyHash: 'h', result: 'ok', runId: RUN_ID }),
  );
  assert.equal(
    proofLineMatches(parsed, { prNumber: 553, headSha: SHA_A, bodyHash: 'h', runId: OTHER_RUN_ID }),
    false,
  );
});

// 運用性・仕様・敵対的の3系統が独立に指摘: 本文の取得経路（GitHub API 直接取得 vs
// ファイル保存）で改行コード・末尾改行の有無が変わり、生バイトの sha256 では意味的に
// 同一の本文が恒常的に不一致になっていた。
test('computeBodyHash: CRLF/LF・末尾改行の差は無視する（取得経路差の吸収）', () => {
  const lf = 'line1\nline2';
  const crlf = 'line1\r\nline2';
  const trailingNewline = 'line1\nline2\n';
  const trailingNewlines = 'line1\nline2\n\n\n';
  assert.equal(computeBodyHash(lf), computeBodyHash(crlf));
  assert.equal(computeBodyHash(lf), computeBodyHash(trailingNewline));
  assert.equal(computeBodyHash(lf), computeBodyHash(trailingNewlines));
});

test('computeBodyHash: 末尾以外の改行・空白の差は意味的な変更として区別する', () => {
  assert.notEqual(computeBodyHash('line1\nline2'), computeBodyHash('line1\n\nline2'));
  assert.notEqual(computeBodyHash('line1\nline2'), computeBodyHash('line1 \nline2'));
});

// --- 4ケース: 本文編集 / push / コメント / resolve で証明行の有効性がどう変わるか ---
//
// 検証時点の run が出した証明行（PR#553・head=H1・本文=B1）を、現在の PR 状態と突き合わせる。
// コメント投稿・スレッド resolve は pull_request イベントではないため artifacts-gate を
// 再実行させず、PR の本文・head SHA も変えない。したがって現在状態と検証時点の証明行は
// 一致したまま = 証明行はまだ有効。本文編集・push はどちらも PR の該当フィールドを変える
// ため、現在状態と証明行が食い違う = 証明行は無効（古い run を根拠に merge してはいけない）。
test('4ケース: 証明行の有効性', () => {
  const prNumber = 553;
  const headShaAtCheck = SHA_A;
  const bodyAtCheck = 'PR本文（検証時点）';
  const proofAtCheck = parseProofLine(
    formatProofLine({
      prNumber,
      headSha: headShaAtCheck,
      bodyHash: computeBodyHash(bodyAtCheck),
      result: 'ok',
      runId: RUN_ID,
    }),
  );

  // ケース1: 本文編集 → body-sha256 が変わり不一致（無効化される）
  const afterBodyEdit = {
    prNumber,
    headSha: headShaAtCheck,
    bodyHash: computeBodyHash('PR本文（編集後）'),
    runId: RUN_ID,
  };
  assert.equal(proofLineMatches(proofAtCheck, afterBodyEdit), false);

  // ケース2: push → head SHA が変わり不一致（無効化される）
  const afterPush = {
    prNumber,
    headSha: SHA_B,
    bodyHash: computeBodyHash(bodyAtCheck),
    runId: RUN_ID,
  };
  assert.equal(proofLineMatches(proofAtCheck, afterPush), false);

  // ケース3・4: コメント投稿／レビュースレッド resolve → どちらも pull_request イベントではなく
  // PR番号・head SHA・本文・run のいずれも変えないため、突き合わせ対象の値は検証時点と同一になる
  // （両イベントを区別する入力が無いため、同一の期待値に対する1つのアサーションで両方を表す）。
  const afterCommentOrResolve = {
    prNumber,
    headSha: headShaAtCheck,
    runId: RUN_ID,
    bodyHash: computeBodyHash(bodyAtCheck),
  };
  assert.equal(proofLineMatches(proofAtCheck, afterCommentOrResolve), true);
});

test('proofLineMatches: 証明行が無ければ常に false', () => {
  assert.equal(proofLineMatches(null, { prNumber: 1, headSha: SHA_A, bodyHash: 'b' }), false);
});

// 仕様・敵対的レビュー: 3値が一致していても、その run 自身の判定が失敗（result=failed）なら
// 合格として扱ってはならない。proofLineMatches は同一状態の検証かどうかだけを返す
// （result は呼び出し側 --verify-proof が別途見る）ので、ここでは result 込みで期待挙動を確認する。
test('4値一致でも result=failed なら --verify-proof は合格にしない（呼び出し側の責務を確認）', () => {
  const parsed = parseProofLine(
    formatProofLine({
      prNumber: 553,
      headSha: SHA_A,
      bodyHash: 'h',
      result: 'failed',
      runId: RUN_ID,
    }),
  );
  const expected = { prNumber: 553, headSha: SHA_A, bodyHash: 'h', runId: RUN_ID };
  // 他の値自体は一致する（同じ PR 状態・同じ run である）
  assert.equal(proofLineMatches(parsed, expected), true);
  // が、その run の判定結果は failed
  assert.equal(parsed.result, 'failed');
});

// --- runCli の証明行出力（bundled action 相当の env を渡す統合テスト） ---

test('runCli（PR_NUMBER/HEAD_SHA あり・成功時）: stdout に result=ok・run ID 込みの証明行を出す', () => {
  const body = FULL_ARTIFACTS;
  const { stdout, status } = spawnSync('node', [CHECK_ARTIFACTS_SCRIPT, '--body', body], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      CHANGED_FILES: 'src/lib/foo.js',
      PR_NUMBER: '553',
      HEAD_SHA: SHA_A,
      GITHUB_RUN_ID: '1234567890',
      GITHUB_RUN_ATTEMPT: '1',
    },
  });
  assert.equal(status, 0);
  const proof = parseProofLine(stdout);
  assert.ok(proof, `証明行が出力されていない: ${stdout}`);
  assert.equal(proof.prNumber, '553');
  assert.equal(proof.headSha, SHA_A);
  assert.equal(proof.bodyHash, computeBodyHash(body));
  assert.equal(proof.result, 'ok');
  assert.equal(proof.runId, '1234567890-1');
});

test('runCli（PR_NUMBER/HEAD_SHA あり・失敗時）: exit 1 でも result=failed の証明行を出す', () => {
  // 必須セクションを欠いた本文 → checkArtifacts が失敗（exit 1）する。証明行は失敗時にも
  // 必ず出力され、result=failed で失敗を自己申告する（仕様・敵対的レビュー: 失敗 run の
  // ログでも証明行だけを見た呼び出し元が誤って合格と読めないようにする）。
  const { stdout, status } = spawnSync(
    'node',
    [CHECK_ARTIFACTS_SCRIPT, '--body', '## 変更の概要\n手を抜いた。'],
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CHANGED_FILES: 'src/lib/foo.js',
        PR_NUMBER: '553',
        HEAD_SHA: SHA_A,
        GITHUB_RUN_ID: '1234567890',
        GITHUB_RUN_ATTEMPT: '1',
      },
    },
  );
  assert.equal(status, 1);
  const proof = parseProofLine(stdout);
  assert.ok(proof, `証明行が出力されていない: ${stdout}`);
  assert.equal(proof.result, 'failed');
});

test('runCli（PR_NUMBER/HEAD_SHA なし）: 証明行を出さない（CLI 単体実行の既存挙動を維持）', () => {
  const { stdout, status } = spawnSync('node', [CHECK_ARTIFACTS_SCRIPT, '--body', FULL_ARTIFACTS], {
    encoding: 'utf-8',
    env: { ...process.env, CHANGED_FILES: 'src/lib/foo.js', PR_NUMBER: '', HEAD_SHA: '' },
  });
  assert.equal(status, 0);
  assert.equal(parseProofLine(stdout), null);
});

// --- --verify-proof CLI（ci-run.md §3b が実際に呼ぶ経路） ---

// run ログに埋め込む証明行（headSha/result/runId/logExtra）と、--verify-proof に渡す現在の
// 状態（headSha/prNumberArg/headShaArg/runIdArg/omitLogFile）を差し替えて実行する（一時ファイル
// 構成は全テストで共通）。prNumberArg/headShaArg/runIdArg は CLI 引数の文字列をそのまま
// 上書きしたい場合（表記揺れ・欠落・run ID 不一致の検証）に使い、省略時は
// currentHeadSha/'553'/RUN_ID から素直に組み立てる。
function runVerifyProof({
  loggedHeadSha,
  currentHeadSha,
  loggedResult = 'ok',
  loggedRunId = RUN_ID,
  logExtra = '',
  logOverride,
  prNumberArg,
  headShaArg,
  runIdArg,
  omitLogFile = false,
}) {
  const dir = mkdtempSync(join(tmpdir(), 'check-artifacts-verify-proof-'));
  const body = 'PR本文（検証時点）';
  const logFile = join(dir, 'run.log');
  const bodyFile = join(dir, 'body.md');
  if (!omitLogFile) {
    writeFileSync(
      logFile,
      logOverride ??
        `${logExtra}${formatProofLine({
          prNumber: '553',
          headSha: loggedHeadSha,
          bodyHash: computeBodyHash(body),
          result: loggedResult,
          runId: loggedRunId,
        })}\n`,
    );
  }
  writeFileSync(bodyFile, body);

  return spawnSync(
    'node',
    [
      CHECK_ARTIFACTS_SCRIPT,
      '--verify-proof',
      '--log-file',
      omitLogFile ? join(dir, 'does-not-exist.log') : logFile,
      '--pr-number',
      prNumberArg ?? '553',
      '--head-sha',
      headShaArg ?? currentHeadSha,
      '--body-file',
      bodyFile,
      '--run-id',
      runIdArg ?? RUN_ID,
    ],
    { encoding: 'utf-8' },
  );
}

test('--verify-proof: 証明行が現在の PR 状態と一致し result=ok なら exit 0', () => {
  const { status, stdout } = runVerifyProof({ loggedHeadSha: SHA_A, currentHeadSha: SHA_A });
  assert.equal(status, 0, stdout);
});

test('--verify-proof: head SHA が食い違えば exit 非0（push 後の古い run を merge 根拠にしない）', () => {
  const { status } = runVerifyProof({ loggedHeadSha: SHA_A, currentHeadSha: SHA_B });
  assert.notEqual(status, 0);
});

test('--verify-proof: 3値が一致していても result=failed なら exit 非0（仕様・敵対的レビュー）', () => {
  const { status, stderr } = runVerifyProof({
    loggedHeadSha: SHA_A,
    currentHeadSha: SHA_A,
    loggedResult: 'failed',
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /result=failed/);
});

// 敵対的レビュー3周目 ADV-r3-1: pr/head/body-sha256 が一致していても、--run-id が
// ログの証明行と食い違えば合格しない（runner が `with:` 入力を逐語ログ出力する経路経由の
// 偽装は、攻撃者が commit 作成時点で知り得ない run ID までは一致させられない）。
test('--verify-proof: pr/head/body-sha256が一致していてもrun IDが食い違えばexit非0', () => {
  const { status, stderr } = runVerifyProof({
    loggedHeadSha: SHA_A,
    currentHeadSha: SHA_A,
    loggedRunId: RUN_ID,
    runIdArg: OTHER_RUN_ID,
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /run の証明行/);
  // run ID だけの不一致は、push/本文編集による通常の陳腐化と区別した専用の案内を出す
  // （仕様レビュー3周目: 「本文編集して再走」への画一的な誘導では §3a のやり直し忘れにも
  // 偽装混入にも対応できない）
  assert.match(stderr, /§3a を最初からやり直し/);
  assert.match(stderr, /偽装された証明行/);
});

// 敵対的レビュー A-1/A-2: ログ中に偽の証明行（攻撃者が望む head/hash を埋め込んだもの）が
// 文の一部として混入していても、それを根拠に合格させてはならない。
test('--verify-proof: 警告文に埋め込まれた偽の証明行では合格しない', () => {
  const forged = formatProofLine({
    prNumber: '553',
    headSha: SHA_B,
    bodyHash: computeBodyHash('PR本文（検証時点）'),
    result: 'ok',
  });
  const { status } = runVerifyProof({
    loggedHeadSha: SHA_A,
    currentHeadSha: SHA_B, // 攻撃者が「これが検証済みだったことにしたい」head
    logExtra: `::warning::check-artifacts: 系統セルに受理トークン外の値があります: ${forged}\n`,
  });
  // 本物の証明行（SHA_A）は currentHeadSha（SHA_B）と一致しないため不一致になる。
  // 埋め込まれた偽の証明行（SHA_B）が拾われて合格することがあってはならない。
  assert.notEqual(status, 0);
});

// 敵対的レビュー A-4: 不一致時の stderr が、そのまま別の検証呼び出しの「ログ」として
// 再投入しても合格してしまう「自己鍛造オラクル」になっていないことを確認する。
test('--verify-proof: 不一致時のエラー出力を log として再投入しても合格しない', () => {
  const first = runVerifyProof({ loggedHeadSha: SHA_A, currentHeadSha: SHA_B });
  assert.notEqual(first.status, 0);

  const replay = runVerifyProof({
    currentHeadSha: SHA_B,
    logOverride: `${first.stdout}${first.stderr}`,
  });
  assert.notEqual(replay.status, 0, replay.stdout);
});

// 運用性レビュー O-5・敵対的レビュー A-6: 証明行の表示（pr=#553）をそのまま貼ると
// # 付きで渡しがちだが、これは自然な誤用であって「push・本文編集で状態が変わった」わけ
// ではないため、CLI 側で吸収する。head SHA の短縮表記は曖昧さを許さず引数エラーにする。
test('--verify-proof: --pr-number の先頭 # は許容する', () => {
  const { status, stdout } = runVerifyProof({
    loggedHeadSha: SHA_A,
    currentHeadSha: SHA_A,
    prNumberArg: '#553',
  });
  assert.equal(status, 0, stdout);
});

test('--verify-proof: --head-sha が短縮 SHA だと引数エラー（不一致とは別の診断）', () => {
  const { status, stderr } = runVerifyProof({
    loggedHeadSha: SHA_A,
    currentHeadSha: SHA_A,
    headShaArg: SHA_A.slice(0, 7),
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /フル40桁/);
});

// 仕様レビュー3周目: run_attempt を落として --run-id <id> とだけ渡す誤用は自然に起こりうる
// （API が id と run_attempt を別フィールドで返すため）。これも「不一致」ではなく引数エラー
// として扱う（落とすと --head-sha と同じ非収束ループになる）。
test('--verify-proof: --run-id が <id>-<attempt> 形式でなければ引数エラー', () => {
  const { status, stderr } = runVerifyProof({
    loggedHeadSha: SHA_A,
    currentHeadSha: SHA_A,
    runIdArg: '1234567890', // run_attempt が無い
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /run id.*run attempt/);
});

// 運用性レビュー O-3: ログ・本文ファイルを読めない場合は「不一致」ではなく「確認不能」と
// 区別できる文言を出す（原因と無関係な「本文編集して再走」への誤誘導を避ける）。
test('--verify-proof: ログファイルが存在しない場合は確認不能と報告する（不一致と混同しない）', () => {
  const { status, stderr } = runVerifyProof({
    loggedHeadSha: SHA_A,
    currentHeadSha: SHA_A,
    omitLogFile: true,
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /確認不能/);
});

// --- artifacts-gate action エントリ（.github/actions/artifacts-gate/src/index.js）の
// fail-loud ガード（risk-model 検証3周目: この判定を実行系として検証するテストが無かった） ---

test('artifacts-gate action: GITHUB_ACTIONS 下で GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT が空だと fail-loud', () => {
  const { status, stderr } = spawnSync('node', [ARTIFACTS_GATE_ENTRY], {
    encoding: 'utf-8',
    env: {
      PATH: process.env.PATH,
      GITHUB_ACTIONS: 'true',
      'INPUT_CHANGED-FILES': 'src/a.js',
      'INPUT_PR-BODY': FULL_ARTIFACTS,
      'INPUT_PR-NUMBER': '553',
      'INPUT_HEAD-SHA': SHA_A,
      // GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT を意図的に未設定にする
    },
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /GITHUB_RUN_ID/);
  assert.match(stderr, /GITHUB_RUN_ATTEMPT/);
});

test('artifacts-gate action: INPUT_CHANGED-FILES 未設定は fail-loud（#446 round2: throw から process.exit(1) へ）', () => {
  const { status, stderr } = spawnSync('node', [ARTIFACTS_GATE_ENTRY], {
    encoding: 'utf-8',
    env: {
      PATH: process.env.PATH,
      // INPUT_CHANGED-FILES を意図的に未設定にする
      'INPUT_PR-BODY': FULL_ARTIFACTS,
      'INPUT_PR-NUMBER': '553',
      'INPUT_HEAD-SHA': SHA_A,
    },
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /changed-files input が未設定です/);
});

test('artifacts-gate action: INPUT_CHANGED-FILES が空文字列は正当な0件差分として正常終了する（#446 round2）', () => {
  const { status, stdout } = spawnSync('node', [ARTIFACTS_GATE_ENTRY], {
    encoding: 'utf-8',
    env: {
      PATH: process.env.PATH,
      'INPUT_CHANGED-FILES': '',
      'INPUT_PR-BODY': FULL_ARTIFACTS,
      'INPUT_PR-NUMBER': '553',
      'INPUT_HEAD-SHA': SHA_A,
    },
  });
  assert.equal(status, 0, stdout);
});

test('artifacts-gate action: 4値すべて揃っていれば証明行を出して正常終了する', () => {
  const { status, stdout } = spawnSync('node', [ARTIFACTS_GATE_ENTRY], {
    encoding: 'utf-8',
    env: {
      PATH: process.env.PATH,
      GITHUB_ACTIONS: 'true',
      'INPUT_CHANGED-FILES': 'src/a.js',
      'INPUT_PR-BODY': FULL_ARTIFACTS,
      'INPUT_PR-NUMBER': '553',
      'INPUT_HEAD-SHA': SHA_A,
      GITHUB_RUN_ID: '1234567890',
      GITHUB_RUN_ATTEMPT: '1',
    },
  });
  assert.equal(status, 0, stdout);
  const proof = parseProofLine(stdout);
  assert.ok(proof, `証明行が出力されていない: ${stdout}`);
  assert.equal(proof.runId, '1234567890-1');
});
