import test from 'node:test';
import assert from 'node:assert/strict';

import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CONTROL_ONLY_DIRS,
  isControlOnlyPath,
  isForbiddenSecretPath,
  isAgentMemoryRecordPath,
  hasPathSeparatorLookalike,
  classifyPublicTreePath,
  isPathInside,
} from '../../scripts/policy/public-tree-policy.js';
import { CONTROL_ONLY_DIRS as REEXPORTED } from '../../scripts/check-doc-links.js';

test('denylist パリティ: CONTROL_ONLY_DIRS は末尾スラッシュ正規化後に厳密4ディレクトリ（#345 B2。agent-memory records/ 追加は preflight blocker 1）', () => {
  const normalized = CONTROL_ONLY_DIRS.map((d) => d.replace(/\/+$/, '')).sort();
  assert.deepEqual(normalized, ['docs/agent-memory/records', 'docs/planning', 'docs/pr', 'docs/pr-analysis']);
});

test('check-doc-links.js の再 export は policy と同一参照（単一正本。再ハードコードでない）', () => {
  assert.equal(REEXPORTED, CONTROL_ONLY_DIRS);
});

test('isControlOnlyPath: セグメント境界で判定（前方一致の誤除外/誤include を避ける。#345 B3/B4）', () => {
  // 除外対象
  assert.equal(isControlOnlyPath('docs/pr/PR-1.md'), true);
  assert.equal(isControlOnlyPath('docs/pr-analysis/items.json'), true);
  assert.equal(isControlOnlyPath('docs/planning/x.md'), true);
  assert.equal(isControlOnlyPath('docs/pr'), true); // ディレクトリ自身
  assert.equal(isControlOnlyPath('docs/agent-memory/records/mem-20260101-abcdef.json'), true);
  assert.equal(isControlOnlyPath('docs/agent-memory/records'), true); // ディレクトリ自身
  // 非除外（前方一致の巻き添えを起こさない）
  assert.equal(isControlOnlyPath('docs/pr2/x.md'), false);
  assert.equal(isControlOnlyPath('docs/planning-public/x.md'), false);
  assert.equal(isControlOnlyPath('src/pr/x.js'), false);
  assert.equal(isControlOnlyPath('docs/ARCHITECTURE.md'), false);
  // docs/agent-memory/README.md は public に残す（説明文書。records/ 配下のみ control-only）
  assert.equal(isControlOnlyPath('docs/agent-memory/README.md'), false);
});

test('isControlOnlyPath: 大文字小文字揺れの private ディレクトリも除外（fail-open 締め。#345 adversarial 🟡）', () => {
  assert.equal(isControlOnlyPath('docs/Planning/x.md'), true);
  assert.equal(isControlOnlyPath('docs/PR/PR-1.md'), true);
  assert.equal(isControlOnlyPath('DOCS/PR-ANALYSIS/items.json'), true);
  // 別ディレクトリを巻き込まない
  assert.equal(isControlOnlyPath('docs/PLANNING-PUBLIC/x.md'), false);
});

test('isForbiddenSecretPath: .gitignore プレフィックスグロブと同義（#345 adversarial 🔴 / spec 所見3）', () => {
  // 禁止（tracked されていてはならない）— アンカー正規表現では漏れていた実在 secret ファイル名
  for (const p of [
    '.env',
    '.env.local',
    '.env.production',
    '.envrc', // direnv（.gitignore が明示的に列挙）
    '.env-prod',
    '.environment',
    'config/.envrc',
    '.env ', // 末尾空白
    'worker/.dev.vars',
    'worker/.dev.vars.production',
    'worker/.dev.vars-backup', // ハイフン継続
    'worker/sub/.dev.vars', // サブ階層
    'foo.local',
    'config/app.local',
    'foo.local/secret.js', // *.local ディレクトリ配下
    'foo.local/.env.example', // *.local 配下は .env.example 例外より優先で禁止（PR #458 Codex 指摘1）
    'config.local/sub/.env.example',
    '.claude/settings.local.json',
    '.env.example.bak', // example の派生は許可しない
  ]) {
    assert.equal(isForbiddenSecretPath(p), true, `禁止されるべき: ${p}`);
  }
  // 許可
  for (const p of ['.env.example', 'worker/.env.example', 'src/index.js', 'README.md', '.claude/settings.json']) {
    assert.equal(isForbiddenSecretPath(p), false, `許可されるべき: ${p}`);
  }
});

test('isForbiddenSecretPath: 大文字変種の secret も禁止（case-insensitive・isControlOnlyPath と対称。PR #458 敵対的再レビュー）', () => {
  for (const p of [
    '.ENV',
    '.Env.production',
    '.DEV.VARS',
    'worker/.DEV.VARS-backup',
    'foo.LOCAL/.env.example', // 大文字 .local ディレクトリ配下
    'docs/x.Local/y.md',
    '.ENV.EXAMPLE', // 大文字 example 変種は許可しない（完全一致の小文字のみ許可）
  ]) {
    assert.equal(isForbiddenSecretPath(p), true, `禁止されるべき: ${p}`);
  }
  // 完全一致の小文字 example は許可（任意ディレクトリ）
  assert.equal(isForbiddenSecretPath('.env.example'), false);
  assert.equal(isForbiddenSecretPath('worker/.env.example'), false);
});

test('isForbiddenSecretPath: .env*/.dev.vars* はディレクトリ名としても forbidden（配下ファイル含め。PR #458 Codex round3 指摘3）', () => {
  for (const p of [
    '.env.production/secret.json',
    '.dev.vars.d/config',
    'worker/.dev.vars.d/x.json',
    'sub/.env.local/inner.txt',
  ]) {
    assert.equal(isForbiddenSecretPath(p), true, `禁止されるべき（ディレクトリ配下）: ${p}`);
  }
  // .env.example は basename としてのみ許可。祖先が .env* でなければ引き続き許可される
  assert.equal(isForbiddenSecretPath('sub/.env.example'), false);
});

test('isPathInside: セグメント境界で包含判定（..foo の誤判定を避ける。#345 quality 所見1/2）', () => {
  const root = resolve('/tmp/base');
  assert.equal(isPathInside(root, resolve('/tmp/base')), true); // 自身
  assert.equal(isPathInside(root, resolve('/tmp/base/sub/x')), true);
  assert.equal(isPathInside(root, resolve('/tmp/other')), false);
  assert.equal(isPathInside(root, resolve('/tmp/base-sibling')), false); // 前方一致の巻き添えなし
  assert.equal(isPathInside(root, resolve('/tmp')), false); // 親
});

test('classifyPublicTreePath: 5分類（invalid-path > secret > control-only > agent-memory-misplaced > include）', () => {
  assert.equal(classifyPublicTreePath('docs\\agent-memory\\records\\x.json'), 'invalid-path');
  assert.equal(classifyPublicTreePath('.env.production'), 'forbidden-secret');
  assert.equal(classifyPublicTreePath('docs/planning/x.md'), 'control-only');
  assert.equal(classifyPublicTreePath('docs/agent-memory/records/x.json'), 'control-only');
  assert.equal(classifyPublicTreePath('docs/agent-memory/x.json'), 'agent-memory-misplaced');
  assert.equal(classifyPublicTreePath('worker/docs/agent-memory/records/x.json'), 'agent-memory-misplaced');
  assert.equal(classifyPublicTreePath('docs/agent-memory/digest.md'), 'include');
  assert.equal(classifyPublicTreePath('docs/agent-memory/README.md'), 'include');
  assert.equal(classifyPublicTreePath('src/index.js'), 'include');
  assert.equal(classifyPublicTreePath('.env.example'), 'include');
  // round7 N-1: 実在ファイル。規則(b)撤回により include（撤回前は basename 一致で誤って misplaced 判定されていた）
  assert.equal(classifyPublicTreePath('scripts/agent-memory.js'), 'include');
});

test('isAgentMemoryRecordPath: docs/agent-memory 配下は .md 以外すべて真（規則(a)のみ。規則(b)は round7 N-1 で撤回）', () => {
  // 真: (a) docs/agent-memory 配下（任意深さ）の非 .md はすべて記憶レコード扱い
  //     records/ 配下も想定外配置も同じ規則で判定する（control-only との切り分けは classifyPublicTreePath 側の優先順位）
  for (const p of [
    'docs/agent-memory/records/mem-20260101-abcdef.json',
    'docs/agent-memory/x.json',
    'worker/docs/agent-memory/records/x.json',
    'DOCS/AGENT-MEMORY/X.JSON', // 大文字小文字非依存
    'docs/agent-memory/digest.jsonl',
    'docs/agent-memory/digest.NDJSON',
    'worker/docs/agent-memory/records/x.jsonl',
    'docs/agent-memory/x.jsonl.bak', // 規則反転: 拡張子 allowlist 撤廃により真（旧: 偽）
  ]) {
    assert.equal(isAgentMemoryRecordPath(p), true, `真であるべき: ${p}`);
  }
  // 偽: .md（説明文書）・非該当セグメント。round7 N-1: 規則(b)（basename が agent-memory 始まりの
  // 非 .md は配下外でも真）は撤回——実在する scripts/agent-memory.js（記憶 CLI 本体。ディレクトリ
  // ではなく単体ファイル）を誤検出し build-public-tree.js を必ず失敗させていたため。
  for (const p of [
    'docs/agent-memory/README.md',
    'docs/agent-memory/digest.md',
    'docs/agent-memory/design.md', // (a) 配下でも .md は真にしない
    'docs/agent-memory-old/x.json', // セグメント境界（前方一致で誤爆しない。segment は 'agent-memory-old' で 'agent-memory' と不一致）
    'docs/planning/agent-memory-design.md',
    'scripts/agent-memory.js', // round7 N-1: 実在ファイル。規則(b)撤回により偽（旧: 誤って真だった）
    'src/agent-memory.json', // 規則(b)撤回により偽に反転
    'docs/agent-memory.json', // 規則(b)撤回により偽に反転（`docs/agent-memory` セグメント自体を持たない）
    'docs/Agent-Memory-backup.ndjson', // 規則(b)撤回により偽に反転（大文字小文字非依存の確認を兼ねる）
  ]) {
    assert.equal(isAgentMemoryRecordPath(p), false, `偽であるべき: ${p}`);
  }
});

test('hasPathSeparatorLookalike: `\\`・制御文字・非 ASCII（コードポイント全域、astral 面を含む）を一般化して検出（ラウンド3敵対的 A-11／ラウンド4敵対的2。同形グリフの列挙をやめた）', () => {
  // 旧列挙の代表例（U+2215/U+FF0F/U+2044 は非 ASCII の部分集合として引き続き検出される）
  assert.equal(hasPathSeparatorLookalike('docs\\agent-memory\\x.json'), true);
  assert.equal(hasPathSeparatorLookalike('docs\u2215agent-memory\u2215x.json'), true); // division slash
  assert.equal(hasPathSeparatorLookalike('docs\uFF0Fagent-memory\uFF0Fx.json'), true); // fullwidth solidus
  assert.equal(hasPathSeparatorLookalike('docs\u2044agent-memory\u2044x.json'), true); // fraction slash
  // 一般化: 非 ASCII 文字を含む任意のパス（列挙されていない未知のグリフも拒否できる）
  assert.equal(hasPathSeparatorLookalike('docs/メモ.md'), true); // 日本語（非 ASCII）
  assert.equal(hasPathSeparatorLookalike('docs/e\u0301migre.md'), true); // 合成アクセント（U+0301）
  // astral 面（U+10000 以上）: 旧実装（\u0080-\uFFFF の BMP 止まりレンジ指定）は通過させていたが、
  // 否定文字クラス [^\x00-\x7F] への一般化で検出できる（PR-preflight round6 F-1）
  assert.equal(hasPathSeparatorLookalike('docs/\u{1F600}.md'), true); // U+1F600 絵文字（GRINNING FACE）
  assert.equal(hasPathSeparatorLookalike('docs/\u{E0041}.md'), true); // U+E0041 TAG LATIN SMALL LETTER A（タグ文字）
  assert.equal(hasPathSeparatorLookalike('docs/\u{2F800}.md'), true); // U+2F800 CJK 互換漢字拡張
  // 一般化: 制御文字（U+0000〜U+001F・U+007F）
  assert.equal(hasPathSeparatorLookalike('docs/foo\nbar.md'), true); // 改行
  assert.equal(hasPathSeparatorLookalike('docs/foo\tbar.md'), true); // タブ
  assert.equal(hasPathSeparatorLookalike('docs/foo\x7Fbar.md'), true); // DEL
  // 通常の ASCII パス（記号含む）は誤検出しない
  assert.equal(hasPathSeparatorLookalike('docs/agent-memory/x.json'), false);
  assert.equal(hasPathSeparatorLookalike('docs/foo-bar_baz (1).md'), false);
});

test('classifyPublicTreePath: astral 面の非 ASCII を含むパスは invalid-path（PR-preflight round6 F-1）', () => {
  assert.equal(classifyPublicTreePath('docs/\u{1F600}.md'), 'invalid-path');
  assert.equal(classifyPublicTreePath('docs/\u{E0041}.md'), 'invalid-path');
  assert.equal(classifyPublicTreePath('docs/\u{2F800}.md'), 'invalid-path');
});

// round7 N-1 再発防止: 実在ファイル（scripts/agent-memory.js 等）が classifyPublicTreePath の
// 誤検出（invalid-path・agent-memory-misplaced）に巻き込まれていないかを、実際の tracked corpus
// で回帰的に確認する。単体の想定ケースだけでは round6 のような「規則は妥当だが実在ファイルと
// 衝突する」バグを事前に検出できなかったため、実データで機械的に保証する。
function isGitWorkTree(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf-8' }).trim() === 'true';
  } catch {
    return false;
  }
}
const REAL_CORPUS_CWD = process.cwd();
// cwd が git 作業ツリーでない場合（generated public tree 上でこのテストを直接実行する場合等）は
// 対象コーパス自体が取得できないため skip する（無言 skip にせず stderr に理由を残す）。
const REAL_CORPUS_SKIP = isGitWorkTree(REAL_CORPUS_CWD) ? false : `cwd（${REAL_CORPUS_CWD}）が git 作業ツリーではありません`;
if (REAL_CORPUS_SKIP) {
  process.stderr.write(`note: 実 tracked corpus 回帰テスト（classifyPublicTreePath）を skip します（${REAL_CORPUS_SKIP}）\n`);
}

test(
  'classifyPublicTreePath: 実 tracked corpus 回帰（agent-memory-misplaced / invalid-path が 0 件。round7 N-1 再発防止）',
  { skip: REAL_CORPUS_SKIP },
  () => {
    const raw = execFileSync('git', ['ls-files', '-z'], { cwd: REAL_CORPUS_CWD, encoding: 'utf-8' });
    const paths = raw.split('\0').filter(Boolean);
    const counts = new Map();
    for (const p of paths) {
      const kind = classifyPublicTreePath(p);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const misplaced = paths.filter((p) => classifyPublicTreePath(p) === 'agent-memory-misplaced');
    assert.equal(counts.get('agent-memory-misplaced') ?? 0, 0, `agent-memory-misplaced 誤検出: ${JSON.stringify(misplaced)}`);
    const invalid = paths.filter((p) => classifyPublicTreePath(p) === 'invalid-path');
    assert.equal(counts.get('invalid-path') ?? 0, 0, `invalid-path 誤検出: ${JSON.stringify(invalid)}`);
    // positive control: 検査自体が空回り（コーパス取得失敗で0件を誤って green にする）でないこと
    assert.ok((counts.get('include') ?? 0) >= 1, 'include が0件（コーパス取得の空回りの疑い）');
    assert.ok((counts.get('control-only') ?? 0) >= 1, 'control-only が0件（コーパス取得の空回りの疑い）');
  },
);
