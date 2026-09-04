import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { runStrictSecretScan, gitBlobSha1 } from '../../scripts/gh/run-strict-secret-scan.js';

// 非空・非 git の走査対象ディレクトリを用意する（生成済み public tree の模擬）
function makeTarget(files = { 'src/index.js': 'code' }) {
  const dir = mkdtempSync(join(tmpdir(), 'tree-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

// files（makeTarget と同じ形）から正しい includedShas を持つ manifest を組み立てる
// （round4 で追加された内容ハッシュ束縛。#458 Codex round4 指摘2）
function manifestFor(files) {
  const included = Object.keys(files);
  const includedShas = Object.fromEntries(included.map((p) => [p, gitBlobSha1(Buffer.from(files[p]))]));
  return { included, includedShas };
}

// canary positive control が要求する3ルール（run-strict-secret-scan.js の REQUIRED_CANARY_RULE_IDS
// と同じ値。実装側の定数を import せず値で持つのは、テストが実装の内部定数に依存しすぎないため）。
const CANARY_REQUIRED_RULE_IDS = ['github-pat', 'slack-bot-token', 'private-key'];

// 引数配列から `--report-path <path>` を検出し、canary の gitleaks 呼び出しかどうかを判定する。
function canaryReportPathOf(args) {
  const idx = args.indexOf('--report-path');
  return idx === -1 ? null : args[idx + 1];
}

// canary の gitleaks 呼び出しに対し、指定したルール ID 群を検出したという体で report.json を書く
// （本物の gitleaks は --report-path 指定時に検出結果を JSON で書き出す。テストではその副作用を模す）。
function writeCanaryReport(reportPath, ruleIds) {
  writeFileSync(reportPath, JSON.stringify(ruleIds.map((id) => ({ RuleID: id }))));
}

// version/canary/実 detect を区別するヘルパー。version は既知の値、canary（--report-path 付き
// 呼び出し）は REQUIRED_CANARY_RULE_IDS 全件を検出したことにして report.json を書く（positive
// control 通過）、本番対象（target）への detect は呼び出し側が指定した結果を返す。
function spawnWithPositiveControl(target, realDetectResult) {
  return (cmd, args) => {
    if (Array.isArray(args) && args[0] === 'version') return { status: 0, stdout: 'v8.21.2\n' };
    const reportPath = canaryReportPathOf(args);
    if (reportPath) {
      writeCanaryReport(reportPath, CANARY_REQUIRED_RULE_IDS);
      return { status: 1 }; // canary: leaks 検出（positive control 通過）
    }
    return realDetectResult;
  };
}

test('検出 0（gitleaks exit 0）は成功', () => {
  const target = makeTarget();
  try {
    const r = runStrictSecretScan({ source: target, spawn: spawnWithPositiveControl(target, { status: 0 }) });
    assert.equal(r.ok, true);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// S9: gitleaks version をログ（main）に残せるよう結果に含める。取得失敗は fail-closed にせず「不明」。
test('gitleaksVersion: version サブコマンドの出力を結果に含める', () => {
  const target = makeTarget();
  try {
    const r = runStrictSecretScan({ source: target, spawn: spawnWithPositiveControl(target, { status: 0 }) });
    assert.equal(r.ok, true);
    assert.equal(r.gitleaksVersion, 'v8.21.2');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// ラウンド4敵対的3: version が「不明」のまま scan を続行していた旧実装を修正——検出結果の信頼性を
// 保証できないため fail-closed（exit 1 相当の throw）にする。
test('gitleaksVersion: version 取得に失敗（timeout 等・ENOENT ではない）したら fail-closed で停止する', () => {
  const target = makeTarget();
  try {
    const spawn = (cmd, args) =>
      Array.isArray(args) && args[0] === 'version'
        ? { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }
        : { status: 1 };
    assert.throws(() => runStrictSecretScan({ source: target, spawn }), /gitleaks version が取得できません/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// PR-preflight round6 F-3: version 取得コマンド自体は成功しても、出力が semver 風
// （`v?数字.数字.数字` 始まり）でなければ「不明」と同じ fail-closed にする。
test('gitleaksVersion: 出力が semver 形式でなければ「不明」と同じ fail-closed で停止する（round6 F-3）', () => {
  const target = makeTarget();
  try {
    const spawn = (cmd, args) =>
      Array.isArray(args) && args[0] === 'version'
        ? { status: 0, stdout: 'not-a-version\n' }
        : { status: 1 };
    assert.throws(() => runStrictSecretScan({ source: target, spawn }), /gitleaks version が取得できません/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// PR-preflight round7 L-f: 記録・出力するのは先頭行のうち semver 正規表現に**マッチした部分文字列
// のみ**とし、末尾の ANSI エスケープ・CR・後続行のノイズは捨てる。
test('gitleaksVersion: 先頭行の semver 部分だけを記録し、末尾の ANSI/CR・後続行は捨てる（round7 L-f）', () => {
  const target = makeTarget();
  try {
    const spawn = (cmd, args) => {
      if (Array.isArray(args) && args[0] === 'version') {
        // 末尾に ANSI エスケープ・CR、2行目に別のノイズを含む出力を模す
        return { status: 0, stdout: 'v8.21.2[0m\r\nsome other noisy line\n' };
      }
      const reportPath = canaryReportPathOf(args);
      if (reportPath) {
        writeCanaryReport(reportPath, CANARY_REQUIRED_RULE_IDS);
        return { status: 1 };
      }
      return { status: 0 };
    };
    const r = runStrictSecretScan({ source: target, spawn });
    assert.equal(r.gitleaksVersion, 'v8.21.2');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('gitleaksVersion: version コマンドが非0終了（エラーではないが異常終了）でも fail-closed で停止する', () => {
  const target = makeTarget();
  try {
    const spawn = (cmd, args) =>
      Array.isArray(args) && args[0] === 'version'
        ? { status: 1, stdout: '' }
        : { status: 1 };
    assert.throws(() => runStrictSecretScan({ source: target, spawn }), /gitleaks version が取得できません/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// S16/A-12: version は detect 呼び出しの**前**に stderr へ出す。detect が失敗して例外を投げても
// version 行は既に出力済みで欠落しない（成功時のみログしていた旧実装への回帰防止）。
test('gitleaks version: detect が失敗（gitleaks 検出あり=exit 1）でも version 行は stderr に残る', () => {
  const target = makeTarget();
  const originalWrite = process.stderr.write;
  const written = [];
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const spawn = (cmd, args) => {
      if (Array.isArray(args) && args[0] === 'version') return { status: 0, stdout: 'v8.21.2\n' };
      const reportPath = canaryReportPathOf(args);
      if (reportPath) {
        writeCanaryReport(reportPath, CANARY_REQUIRED_RULE_IDS); // canary は positive control 通過
        return { status: 1 };
      }
      return { status: 1 }; // 本番 detect が検出ありで失敗
    };
    assert.throws(() => runStrictSecretScan({ source: target, spawn }), /検出あり/);
    assert.ok(written.some((l) => l.includes('gitleaks version: v8.21.2')), 'version 行が失敗経路でも出力される');
  } finally {
    process.stderr.write = originalWrite;
    rmSync(target, { recursive: true, force: true });
  }
});

test('gitleaks version: 取得コマンドに timeout 10s を指定する（ハング対策。ラウンド3敵対的 A-12）', () => {
  const target = makeTarget();
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  let versionOpts;
  try {
    const spawn = (cmd, args, opts) => {
      if (Array.isArray(args) && args[0] === 'version') {
        versionOpts = opts;
        return { status: 0, stdout: 'v8.21.2\n' };
      }
      const reportPath = canaryReportPathOf(args);
      if (reportPath) {
        writeCanaryReport(reportPath, CANARY_REQUIRED_RULE_IDS);
        return { status: 1 };
      }
      return { status: 0 };
    };
    runStrictSecretScan({ source: target, spawn });
    assert.equal(versionOpts.timeout, 10000);
  } finally {
    process.stderr.write = originalWrite;
    rmSync(target, { recursive: true, force: true });
  }
});

// PR-preflight round6 L-1: canary の spawn に timeout 30s、本番 detect の spawn に timeout 10分を
// 指定する（既存の version の 10s と同じハング対策）。
test('gitleaks: canary の spawn に timeout 30s、本番 detect の spawn に timeout 10分を指定する（round6 L-1）', () => {
  const target = makeTarget();
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  let canaryOpts;
  let detectOpts;
  try {
    const spawn = (cmd, args, opts) => {
      if (Array.isArray(args) && args[0] === 'version') return { status: 0, stdout: 'v8.21.2\n' };
      const reportPath = canaryReportPathOf(args);
      if (reportPath) {
        canaryOpts = opts;
        writeCanaryReport(reportPath, CANARY_REQUIRED_RULE_IDS);
        return { status: 1 };
      }
      detectOpts = opts;
      return { status: 0 };
    };
    runStrictSecretScan({ source: target, spawn });
    assert.equal(canaryOpts.timeout, 30000);
    assert.equal(detectOpts.timeout, 600000);
  } finally {
    process.stderr.write = originalWrite;
    rmSync(target, { recursive: true, force: true });
  }
});

// round6 L-1: canary の timeout 超過は version の timeout と同じ扱い（fail-closed）にする。
test('positive control: canary が timeout（ETIMEDOUT）で fail-closed（round6 L-1）', () => {
  const target = makeTarget();
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const spawn = (cmd, args) => {
      if (Array.isArray(args) && args[0] === 'version') return { status: 0, stdout: 'v8.21.2\n' };
      return { error: Object.assign(new Error('spawnSync gitleaks ETIMEDOUT'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM', status: null };
    };
    assert.throws(() => runStrictSecretScan({ source: target, spawn }), /positive control（canary 検出）が timeout 30秒/);
  } finally {
    process.stderr.write = originalWrite;
    rmSync(target, { recursive: true, force: true });
  }
});

// round6 L-1: 本番 detect の timeout 超過も fail-closed にする。
test('gitleaks: 本番 detect が timeout（ETIMEDOUT）で fail-closed（round6 L-1）', () => {
  const target = makeTarget();
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const spawn = (cmd, args) => {
      if (Array.isArray(args) && args[0] === 'version') return { status: 0, stdout: 'v8.21.2\n' };
      const reportPath = canaryReportPathOf(args);
      if (reportPath) {
        writeCanaryReport(reportPath, CANARY_REQUIRED_RULE_IDS);
        return { status: 1 };
      }
      return { error: Object.assign(new Error('spawnSync gitleaks ETIMEDOUT'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM', status: null };
    };
    assert.throws(() => runStrictSecretScan({ source: target, spawn }), /gitleaks の検出が timeout 10分/);
  } finally {
    process.stderr.write = originalWrite;
    rmSync(target, { recursive: true, force: true });
  }
});

test('gitleaks 不在（ENOENT）は fail-closed（未検査を成功扱いしない。#345 D3）', () => {
  const target = makeTarget();
  try {
    const spawn = () => ({ error: Object.assign(new Error('spawn gitleaks ENOENT'), { code: 'ENOENT' }) });
    assert.throws(() => runStrictSecretScan({ source: target, spawn }), /gitleaks コマンドが見つかりません/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('検出あり（exit 1）は fail', () => {
  const target = makeTarget();
  try {
    assert.throws(
      () => runStrictSecretScan({ source: target, spawn: spawnWithPositiveControl(target, { status: 1 }) }),
      /検出あり|exit=1/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('シグナル終了は fail', () => {
  const target = makeTarget();
  try {
    const spawn = spawnWithPositiveControl(target, { signal: 'SIGKILL', status: null });
    assert.throws(() => runStrictSecretScan({ source: target, spawn }), /シグナル/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('空ディレクトリは fail（stale/取り違えを合格させない。#345 adversarial 🟠#3）', () => {
  const target = mkdtempSync(join(tmpdir(), 'empty-'));
  try {
    assert.throws(() => runStrictSecretScan({ source: target, spawn: () => ({ status: 0 }) }), /空です/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('走査対象が git 作業ツリー内なら拒否（cwd 非依存・対象基準。#345 adversarial 🟠#3）', () => {
  // テスト実行者の cwd（process.cwd()）が常に git 管理下とは限らない（生成済み public tree で
  // このテストスイート自体を実行する場合、tree は push 前は git 管理外のため process.cwd() を
  // 対象に使う旧実装は false negative になる。runbook §4 step 5.5）。対象自身が git 管理下かを
  // 検証したいので、cwd に依存せず専用の一時 git リポジトリを用意する。
  const gitTarget = mkdtempSync(join(tmpdir(), 'gitwt-'));
  try {
    execFileSync('git', ['init', '--quiet', gitTarget]);
    assert.throws(
      () => runStrictSecretScan({ source: gitTarget, spawn: () => ({ status: 0 }) }),
      /git 作業ツリー内/,
    );
  } finally {
    rmSync(gitTarget, { recursive: true, force: true });
  }
});

// PR-preflight round7 L-e: .gitleaksignore は gitleaks の検出除外機構であり、strict pass の
// 「project allowlist を一切持たない」前提に反するため、走査対象ツリー配下に存在するだけで
// fail-closed にする。
test('走査対象ツリーに .gitleaksignore があれば fail-closed（strict pass の allowlist 不採用に反する。round7 L-e）', () => {
  const target = makeTarget({ 'src/index.js': 'code' });
  writeFileSync(join(target, '.gitleaksignore'), 'somehash:somefile.txt:some-rule:1\n');
  try {
    assert.throws(
      () => runStrictSecretScan({ source: target, spawn: () => ({ status: 0 }) }),
      /\.gitleaksignore/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('manifest 指定で included が対象に無ければ fail（build 出力と束縛。#345 adversarial 🟠#3-b）', () => {
  const target = makeTarget({ 'src/index.js': 'code' });
  const manifestDir = mkdtempSync(join(tmpdir(), 'mani-'));
  const manifestPath = join(manifestDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ included: ['src/index.js', 'src/missing.js'] }));
  try {
    assert.throws(
      () => runStrictSecretScan({ source: target, manifestPath, spawn: () => ({ status: 0 }) }),
      /実ファイルと一致しません/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(manifestDir, { recursive: true, force: true });
  }
});

test('included 無し/非配列の manifest は fail-closed（束縛ゲートをすり抜けさせない。PR #458 Codex 指摘4）', () => {
  const target = makeTarget({ 'src/index.js': 'code' });
  const manifestDir = mkdtempSync(join(tmpdir(), 'mani-'));
  try {
    for (const bad of ['{}', '{"included":[]}', '{"included":"src/index.js"}', '{"name":"novel-ide"}']) {
      const manifestPath = join(manifestDir, 'm.json');
      writeFileSync(manifestPath, bad);
      assert.throws(
        () => runStrictSecretScan({ source: target, manifestPath, spawn: () => ({ status: 0 }) }),
        /included が非空配列ではありません/,
        `不正 manifest を拒否すべき: ${bad}`,
      );
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(manifestDir, { recursive: true, force: true });
  }
});

test('included のジャンク要素（空/./../ディレクトリ）は束縛をすり抜けさせない（PR #458 敵対的再レビュー）', () => {
  const target = makeTarget({ 'src/index.js': 'code' });
  const manifestDir = mkdtempSync(join(tmpdir(), 'mani-'));
  try {
    for (const bad of ['[""]', '["."]', '[".."]', '["src"]', '["../escape"]']) {
      const manifestPath = join(manifestDir, 'm.json');
      writeFileSync(manifestPath, `{"included":${bad}}`);
      assert.throws(
        () => runStrictSecretScan({ source: target, manifestPath, spawn: () => ({ status: 0 }) }),
        /実ファイルと一致しません/,
        `ジャンク included を拒否すべき: ${bad}`,
      );
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(manifestDir, { recursive: true, force: true });
  }
});

test('対象に manifest 未記載の余剰ファイルがあれば fail（取り違え検出。PR #458 敵対的再レビュー round2 指摘1）', () => {
  const target = makeTarget({ 'src/index.js': 'code', 'src/extra.js': '追加ファイル' });
  const manifestDir = mkdtempSync(join(tmpdir(), 'mani-'));
  try {
    const manifestPath = join(manifestDir, 'm.json');
    writeFileSync(manifestPath, JSON.stringify(manifestFor({ 'src/index.js': 'code' })));
    assert.throws(
      () => runStrictSecretScan({ source: target, manifestPath, spawn: () => ({ status: 0 }) }),
      /manifest 未記載のファイル/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(manifestDir, { recursive: true, force: true });
  }
});

test('included に Windows 区切りの traversal（..\\outside.txt）があれば fail（PR #458 Codex round3 指摘1）', () => {
  // 隔離された wrapper 配下に target と outside.txt を置く（共有 tmpdir への固定名書き込みを避ける）
  const wrapper = mkdtempSync(join(tmpdir(), 'wrap-'));
  const target = join(wrapper, 'target');
  const manifestDir = mkdtempSync(join(tmpdir(), 'mani-'));
  try {
    mkdirSync(join(target, 'src'), { recursive: true });
    writeFileSync(join(target, 'src/index.js'), 'code');
    writeFileSync(join(wrapper, 'outside.txt'), 'secret-outside');
    const manifestPath = join(manifestDir, 'm.json');
    writeFileSync(manifestPath, JSON.stringify({ included: ['..\\outside.txt'] }));
    assert.throws(
      () => runStrictSecretScan({ source: target, manifestPath, spawn: () => ({ status: 0 }) }),
      /実ファイルと一致しません/,
    );
  } finally {
    rmSync(wrapper, { recursive: true, force: true });
    rmSync(manifestDir, { recursive: true, force: true });
  }
});

test('対象内に symlink 等の非通常エントリがあれば manifest 一致でも fail（PR #458 Codex round3 指摘2）', () => {
  const target = makeTarget({ 'src/index.js': 'code' });
  const manifestDir = mkdtempSync(join(tmpdir(), 'mani-'));
  try {
    // symlink 先も target 内の既存ファイルにし、included が「一見完全一致」する状況を作る
    symlinkSync(join(target, 'src/index.js'), join(target, 'src/link.js'));
    const manifestPath = join(manifestDir, 'm.json');
    writeFileSync(manifestPath, JSON.stringify(manifestFor({ 'src/index.js': 'code' })));
    assert.throws(
      () => runStrictSecretScan({ source: target, manifestPath, spawn: () => ({ status: 0 }) }),
      /非通常ファイル/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(manifestDir, { recursive: true, force: true });
  }
});

test('manifest の included が全て対象に在れば成功', () => {
  const files = { 'src/index.js': 'code', 'README.md': '# x' };
  const target = makeTarget(files);
  const manifestDir = mkdtempSync(join(tmpdir(), 'mani-'));
  const manifestPath = join(manifestDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifestFor(files)));
  try {
    const r = runStrictSecretScan({ source: target, manifestPath, spawn: spawnWithPositiveControl(target, { status: 0 }) });
    assert.equal(r.ok, true);
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(manifestDir, { recursive: true, force: true });
  }
});

test('manifestPath が空文字なら fail-closed（未指定との取り違えを防ぐ。PR #458 Codex round5 指摘1）', () => {
  const target = makeTarget();
  try {
    assert.throws(
      () => runStrictSecretScan({ source: target, manifestPath: '', spawn: () => ({ status: 0 }) }),
      /manifestPath が空文字です/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('included が symlink だと内容ハッシュ読み込みより前に非通常ファイルとして fail（PR #458 Codex round5 指摘2）', () => {
  const wrapper = mkdtempSync(join(tmpdir(), 'wrap-'));
  const manifestDir = mkdtempSync(join(tmpdir(), 'mani-'));
  try {
    const target = join(wrapper, 'target');
    mkdirSync(join(target, 'src'), { recursive: true });
    // target 外の「秘密」ファイルへの symlink を included の一員として置く
    const secretOutside = join(wrapper, 'secret-outside.txt');
    writeFileSync(secretOutside, 'super secret content outside target');
    symlinkSync(secretOutside, join(target, 'src/link.js'));
    const manifestPath = join(manifestDir, 'm.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({ included: ['src/link.js'], includedShas: { 'src/link.js': gitBlobSha1(Buffer.from('super secret content outside target')) } }),
    );
    assert.throws(
      () => runStrictSecretScan({ source: target, manifestPath, spawn: () => ({ status: 0 }) }),
      /非通常ファイル/, // ハッシュ不一致等の後続エラーではなく、irregular 検出で先に fail することを確認
    );
  } finally {
    rmSync(wrapper, { recursive: true, force: true });
    rmSync(manifestDir, { recursive: true, force: true });
  }
});

test('git 判定不能（偽 git が非git-repository以外の理由で非0終了）は fail-closed（PR #458 Codex round5 指摘3）', () => {
  const target = makeTarget();
  const fakeBin = mkdtempSync(join(tmpdir(), 'fakebin-'));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(fakeBin, 'git'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.PATH = `${fakeBin}:${originalPath}`;
    assert.throws(
      () => runStrictSecretScan({ source: target, spawn: () => ({ status: 0 }) }),
      /git の実行結果から対象が git 管理外か判定できません/,
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(target, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('git 実行自体が失敗（ENOENT 相当）でも fail-closed（PR #458 Codex round5 指摘3）', () => {
  const target = makeTarget();
  const emptyBin = mkdtempSync(join(tmpdir(), 'emptybin-'));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = emptyBin; // git を一切解決できない PATH にする
    assert.throws(
      () => runStrictSecretScan({ source: target, spawn: () => ({ status: 0 }) }),
      /git 実行に失敗しました/,
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(target, { recursive: true, force: true });
    rmSync(emptyBin, { recursive: true, force: true });
  }
});

test('対象ファイルの内容だけが manifest 記録と異なれば fail（内容差し替え検出。PR #458 Codex round4 指摘2）', () => {
  const files = { 'README.md': '# public description' };
  const target = makeTarget(files);
  const manifestDir = mkdtempSync(join(tmpdir(), 'mani-'));
  try {
    const manifestPath = join(manifestDir, 'm.json');
    // manifest は元の内容のハッシュを記録するが、target 側のファイルは後から中身だけ差し替わっている想定
    writeFileSync(manifestPath, JSON.stringify(manifestFor(files)));
    writeFileSync(join(target, 'README.md'), '# private prose replaced after manifest generation');
    assert.throws(
      () => runStrictSecretScan({ source: target, manifestPath, spawn: () => ({ status: 0 }) }),
      /manifest の記録と一致しません/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(manifestDir, { recursive: true, force: true });
  }
});

test('includedShas 欠落/不正な manifest は fail-closed（PR #458 Codex round4 指摘2）', () => {
  const target = makeTarget({ 'src/index.js': 'code' });
  const manifestDir = mkdtempSync(join(tmpdir(), 'mani-'));
  try {
    for (const bad of ['{"included":["src/index.js"]}', '{"included":["src/index.js"],"includedShas":[]}', '{"included":["src/index.js"],"includedShas":"x"}']) {
      const manifestPath = join(manifestDir, 'm.json');
      writeFileSync(manifestPath, bad);
      assert.throws(
        () => runStrictSecretScan({ source: target, manifestPath, spawn: () => ({ status: 0 }) }),
        /includedShas が不正です/,
        `不正 includedShas を拒否すべき: ${bad}`,
      );
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(manifestDir, { recursive: true, force: true });
  }
});

// ラウンド4敵対的3: stub/劣化した gitleaks が detect で常に exit 0 を返すケースを positive control
// が検出できることを確認する（canary secret すら検出しないなら本番対象の「検出0」も信頼できない）。
test('positive control: gitleaks が canary secret を検出できない（劣化 stub。report が空）場合は fail-closed', () => {
  const target = makeTarget();
  try {
    const spawn = (cmd, args) => {
      if (Array.isArray(args) && args[0] === 'version') return { status: 0, stdout: 'v8.21.2\n' };
      const reportPath = canaryReportPathOf(args);
      if (reportPath) {
        writeCanaryReport(reportPath, []); // 劣化 stub: 何も検出しない
        return { status: 0 };
      }
      return { status: 0 };
    };
    assert.throws(
      () => runStrictSecretScan({ source: target, spawn }),
      /positive control 失敗.*canary secret.*検出できません/s,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// PR-preflight round6 F-3: github-pat 系統だけが生きていて他ルールの正規表現が壊れている「部分劣化」も、
// 3ルール要求により検出できることを確認する。
test('positive control: 3ルールのうち一部（github-pat のみ）しか検出できない部分劣化は fail-closed（検出ルールを列挙。round6 F-3）', () => {
  const target = makeTarget();
  try {
    const spawn = (cmd, args) => {
      if (Array.isArray(args) && args[0] === 'version') return { status: 0, stdout: 'v8.21.2\n' };
      const reportPath = canaryReportPathOf(args);
      if (reportPath) {
        writeCanaryReport(reportPath, ['github-pat']); // slack-bot-token・private-key ルールが劣化
        return { status: 1 };
      }
      return { status: 0 };
    };
    assert.throws(
      () => runStrictSecretScan({ source: target, spawn }),
      /positive control 失敗（検出ルール: github-pat）/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// PR-preflight round7 N-2: JSON report のルール判定だけを見ていると、「report は正しく書くが
// exit code が常に 0」の gitleaks（本番の scan 判定は exit code のみを見るため fail-open になる）
// を positive control が見逃す。3ルールすべてが report に出現していても、canary の exit code が
// 0 なら positive control 自体を失敗させる（round4 の exit code 判定を復活）。
test('positive control: report は3ルール正しいが exit code が 0 の gitleaks は fail-closed（exit code 判定を復活。round7 N-2）', () => {
  const target = makeTarget();
  try {
    const spawn = (cmd, args) => {
      if (Array.isArray(args) && args[0] === 'version') return { status: 0, stdout: 'v8.21.2\n' };
      const reportPath = canaryReportPathOf(args);
      if (reportPath) {
        writeCanaryReport(reportPath, CANARY_REQUIRED_RULE_IDS); // report は3ルールとも検出済み
        return { status: 0 }; // だが exit code は常に 0（劣化 gitleaks の疑い）
      }
      return { status: 0 };
    };
    assert.throws(
      () => runStrictSecretScan({ source: target, spawn }),
      /positive control 失敗.*exit code が 0/s,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('positive control: canary 検出がシグナルで終了したら fail-closed', () => {
  const target = makeTarget();
  try {
    const spawn = (cmd, args) => {
      if (Array.isArray(args) && args[0] === 'version') return { status: 0, stdout: 'v8.21.2\n' };
      return { signal: 'SIGKILL', status: null }; // canary 呼び出しがシグナルで終了
    };
    assert.throws(() => runStrictSecretScan({ source: target, spawn }), /positive control.*シグナル/s);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('--source 未指定は fail', () => {
  assert.throws(() => runStrictSecretScan({ spawn: () => ({ status: 0 }) }), /--source/);
});
