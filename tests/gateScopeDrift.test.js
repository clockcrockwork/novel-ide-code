import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// gate の走査範囲・実行引数が複数箇所に手動複製された結果としての drift を検出する
// （減算/敵対的/仕様/運用性/品質の各レビューが独立に同型の指摘をした所見の機械化。#gate-scope-drift）。
// 検査不能（ファイルが読めない・パターンが一致しない）は fail-closed にする。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('security:semgrep の引数が package.json と ci.yml の semgrep ジョブで一致する（二重管理の drift 検査）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const npmScript = pkg.scripts?.['security:semgrep'];
  assert.ok(npmScript, 'package.json に scripts["security:semgrep"] が無い');
  const npmArgs = npmScript.slice(npmScript.indexOf('semgrep scan'));
  assert.ok(
    npmArgs.startsWith('semgrep scan'),
    'security:semgrep の引数列から "semgrep scan" 以降を抽出できない',
  );

  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8');
  const match = ci.match(/- run: (semgrep scan[^\n]*)/);
  assert.ok(
    match,
    'ci.yml に "- run: semgrep scan ..." 行が見つからない（semgrep ジョブの run 手順が変わった）',
  );
  const ciArgs = match[1].trim();

  assert.equal(
    npmArgs,
    ciArgs,
    'package.json の security:semgrep と ci.yml の semgrep ジョブで引数列が一致しない。' +
      '引数を変えるときは両方を同時に更新すること',
  );
});

// 4本（gate が存在する検出カテゴリを持つ系統）は category 部分だけが異なり、
// 「は機械化済みの検出カテゴリ」以降の構造は逐語同一のはず。
// 3本（gate 不在の系統）は category 部分を持たず、行全体が逐語同一のはず。
// この2グループ以外の第3のパターンが生じたら drift（PR #593 の7本テンプレ展開事故と同型）。
const ANGLE_FILES_TO_CHECK = [
  'angle-adversarial.md',
  'angle-cleanup.md',
  'angle-operability.md',
  'angle-quality.md',
  'angle-riskmodel.md',
  'angle-spec.md',
  'angle-subtractive.md',
];
const CATEGORY_ANCHOR = 'は機械化済みの検出カテゴリ';

function extractMachineBoundaryLine(text, file) {
  const line = text.split('\n').find((l) => l.startsWith('> **Machine boundary:**'));
  assert.ok(line, `${file} に "> **Machine boundary:**" 行が見つからない`);
  return line;
}

function normalizeMachineBoundaryLine(line) {
  const idx = line.indexOf(CATEGORY_ANCHOR);
  // category 列挙を持つ系統（アンカーで始まる構造から先頭の固有名詞部分だけを落とす）
  return idx === -1 ? line : line.slice(idx);
}

test('angle-*.md の Machine boundary 行が2バリアントに収まる（angle-memory.md を除く。テンプレ分裂検査）', () => {
  const variants = new Set();
  for (const file of ANGLE_FILES_TO_CHECK) {
    const text = readFileSync(join(ROOT, 'docs/agent-workflows/review-angles', file), 'utf-8');
    const line = extractMachineBoundaryLine(text, file);
    variants.add(normalizeMachineBoundaryLine(line));
  }
  assert.ok(
    variants.size <= 2,
    `Machine boundary 行が${variants.size}バリアントに分裂している（想定は2以下）。\n` +
      [...variants].map((v, i) => `--- variant ${i + 1} ---\n${v}`).join('\n'),
  );
});

// グロブから走査範囲の doc 記述と突き合わせる先頭ディレクトリ部分を取り出す。
// `**` / `*` を含む最初のセグメントより前を取る
// （例: `src/**/*.{js,jsx}` → `src`、`.github/actions/*/src/**/*.js` → `.github/actions`）。
function extractGlobPrefix(glob) {
  const segments = glob.split('/');
  const idx = segments.findIndex((seg) => seg.includes('*'));
  assert.ok(
    idx > 0,
    `グロブ "${glob}" から先頭ディレクトリ部分を抽出できない（ワイルドカードの位置が想定外）`,
  );
  return segments.slice(0, idx).join('/');
}

function findGatesRow(gatesDoc, prefix, file) {
  const row = gatesDoc.split('\n').find((l) => l.startsWith(prefix));
  assert.ok(row, `${file} に "${prefix}" 行が見つからない`);
  return row;
}

// agent-manifest.json / overlays 等の .md-only diff は classify-changes.js 上 code=false になり
// lint-test / semgrep（npm test 経由の agentCommons.test.js を含む）が skip される。この diff は
// docs=true になるため、docs-links job に agent-commons projection の drift 検査ステップが
// 無いと CI が fail-open で required-gate を通してしまう（敵対的レビュー所見）。job / step の存在を
// 機械的に固定する。verify-projection.js は consumer 側の lock だけを見る検証で、canonical
// source（agent-commons リポジトリ）への network / token アクセスを持たない。
test('ci.yml: docs-links job が agent-commons projection の drift 検査を実行する（.md-only diff の CI fail-open 回帰防止）', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8');
  const jobStart = ci.indexOf('\n  docs-links:');
  assert.ok(jobStart !== -1, 'ci.yml に docs-links job が見つからない');
  const jobEnd = ci.indexOf('\n  bundle-check:', jobStart);
  assert.ok(jobEnd !== -1, 'ci.yml に bundle-check job が見つからない（docs-links job の終端検出に失敗）');
  const jobBlock = ci.slice(jobStart, jobEnd);
  assert.match(
    jobBlock,
    /node scripts\/agent\/verify-projection\.js/,
    'docs-links job に scripts/agent/verify-projection.js の実行ステップが無い',
  );
  assert.match(
    jobBlock,
    /node --test tests\/agentCommons\.test\.js/,
    'docs-links job に tests/agentCommons.test.js の実行ステップが無い',
  );
});

// agent-manifest.json / agent-commons.lock.json / scripts/agent/** の変更は code=true・docs=false に
// なるため docs-links job は skip される。この形状を担保しているのは lint-test の npm test 経由で走る
// tests/agentCommons.test.js の「実リポジトリに対する検証」だけであり、この結合は docs にも
// ci.yml にも現れない。テスト側の1行が消えると manifest 単体変更の検証が無言で失われるため固定する
// （敵対的レビュー R4）。
test('tests/agentCommons.test.js が実リポジトリ本体を検証する（code=true / docs=false 差分の唯一の CI 経路）', () => {
  const suite = readFileSync(join(ROOT, 'tests/agentCommons.test.js'), 'utf-8');
  assert.match(
    suite,
    /runVerify\(ROOT\)/,
    'リポジトリ本体に対する verify-projection.js の実行が無い（manifest 単体変更の CI 検証経路が失われる）',
  );
  assert.match(
    suite,
    /lock\.outputs\)\) \{/,
    '受領証と実ファイルを突き合わせる独立照合が無い（検証スクリプト自身の改竄を検出できない）',
  );
});

test('.jscpdrc.json の path / knip.json の project が verification-gates.md の該当行の走査範囲記述に現れる（drift 検査）', () => {
  const gatesDoc = readFileSync(join(ROOT, 'docs/ai/rules/verification-gates.md'), 'utf-8');

  const jscpdrc = JSON.parse(readFileSync(join(ROOT, '.jscpdrc.json'), 'utf-8'));
  assert.ok(
    Array.isArray(jscpdrc.path) && jscpdrc.path.length > 0,
    '.jscpdrc.json に path 配列が無い',
  );
  const dupRow = findGatesRow(gatesDoc, '| 重複コード |', 'verification-gates.md');
  for (const p of jscpdrc.path) {
    assert.ok(
      dupRow.includes(`\`${p}\``),
      `.jscpdrc.json の path "${p}" が verification-gates.md の重複コード行に走査範囲として書かれていない`,
    );
  }

  // knip.json の project は ignore（worker/** 等）を含まない走査対象のみを見る
  // （worker/** は「対象外」として doc に書く運用のため、検査対象は project だけでよい）
  const knipConfig = JSON.parse(readFileSync(join(ROOT, 'knip.json'), 'utf-8'));
  assert.ok(
    Array.isArray(knipConfig.project) && knipConfig.project.length > 0,
    'knip.json に project 配列が無い',
  );
  const unusedRow = findGatesRow(gatesDoc, '| 未使用 export / コード |', 'verification-gates.md');
  for (const glob of knipConfig.project) {
    const prefix = extractGlobPrefix(glob);
    assert.ok(
      unusedRow.includes(prefix),
      `knip.json の project グロブ "${glob}"（先頭 "${prefix}"）が verification-gates.md の` +
        '未使用 export / コード行の文中に現れない',
    );
  }
});

// #551 の「PR push では CI を起動しない」方針と、public repo の required status checks は
// 構造的に両立しない（required は head SHA 単位で評価され、workflow_dispatch 由来の check run は
// required 欄を満たさない — public repo で実測）。ci.yml から pull_request トリガーが落ちると
// public 側の required-gate が恒久的に Expected のまま詰まるため、トリガーとガードの両方を固定する。
test('ci.yml: pull_request トリガーと visibility ガードが揃っている（required-gate が PR の required 欄を満たす前提）', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8');
  const onBlock = ci.slice(ci.indexOf('\non:'), ci.indexOf('\npermissions:'));
  assert.match(
    onBlock,
    /^\s{2}pull_request:\s*$/m,
    'ci.yml の on: に pull_request トリガーが無い。required status checks は head SHA 単位で評価され、' +
      'workflow_dispatch 由来の check run では public repo の required 欄を満たせない',
  );
  assert.doesNotMatch(
    onBlock,
    /^\s{4}paths(-ignore)?:/m,
    'on.pull_request に paths フィルタを付けてはいけない。対象外の変更では workflow 自体が起動せず、' +
      'required-gate が報告されないまま Expected で詰まる（job 側の changes 分類で絞ること）',
  );

  // ガードは changes / secret-scan / required-gate の3 job に必要。
  // 他 job は needs: changes の cascade で skip されるため不要だが、この3つが欠けると
  // private repo の PR で CI が走る（#551 違反）か、private PR に恒常的な赤が付く。
  const GUARD = "github.event_name != 'pull_request' || github.event.repository.visibility == 'public'";
  for (const job of ['changes', 'secret-scan', 'required-gate']) {
    const start = ci.indexOf(`\n  ${job}:`);
    assert.ok(start !== -1, `ci.yml に ${job} job が見つからない`);
    const rest = ci.slice(start + 1);
    const nextJob = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    const block = nextJob === -1 ? rest : rest.slice(0, nextJob);
    assert.ok(
      block.includes(GUARD),
      `ci.yml の ${job} job に visibility ガードが無い（PR 起動を public に限る条件）。` +
        '正本: docs/ai/rules/ci-run.md「PR 起動の適用範囲」',
    );
  }

  // required-gate は always() との AND を保つ（always() を落とすと上流 skip で job ごと skip され、
  // branch protection が skipped required を成功扱いにする穴が戻る。#430）
  const gateStart = ci.indexOf('\n  required-gate:');
  const gateBlock = ci.slice(gateStart, gateStart + 1200);
  assert.match(
    gateBlock,
    /if: always\(\) &&/,
    'required-gate の if から always() が落ちている（上流 skip 時に job ごと skip され required が素通りする）',
  );
});
