// consumer 側の agent-commons projection 検証スイート。
//
// novel-ide は agent-commons の canonical source（core/**・engine スクリプト）を持たない
// consumer リポジトリ。canonical source は外部リポジトリ `agent-commons` に
// あり、engine（render / marker / projector 等）のテストもそちらの責務（このリポジトリで
// 重複させると第二の正本になるため意図的に持たない）。
//
// このスイートが検証するのは consumer 側の契約だけ:
//   - agent-manifest.json のスキーマ健全性（commons.repo/version・projection-guard groups・
//     values の形式）
//   - agent-commons.lock.json（projection の受領証）の形式・manifest との整合
//   - scripts/agent/verify-projection.js が「正常な受領証どおりのツリー」で 0 終了し、
//     「受領証とずれたツリー」（手編集・削除・overlay 追加・入力変更・orphan）で
//     非 0 終了しファイル名を含むことを、実ファイルを一切変更しない一時コピー上で確認する
//   - overlays ディレクトリと docs/agent-workflows/overlays/README.md の一覧が同期している
//   - 「in-repo canonical source が残っていない」（agent-commons/ ディレクトリが無い・
//     agent-commons.lock.json 以外のファイルが local canonical source を名乗っていない）
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  copyFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(ROOT, 'agent-commons.lock.json');
const MANIFEST_PATH = join(ROOT, 'agent-manifest.json');
const VERIFY_SCRIPT = 'scripts/agent/verify-projection.js';
const OVERLAYS_DIR = join(ROOT, 'docs/agent-workflows/overlays');

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'));

function runVerify(cwd) {
  return spawnSync(process.execPath, [VERIFY_SCRIPT], { cwd, encoding: 'utf-8' });
}

// lock.outputs / lock.inputs に記録された全ファイル + lock 自身 + 検証スクリプト自身を
// 実ファイルから一時ディレクトリへコピーする（元ツリーは一切変更しない）。overlaysDir も
// ディレクトリごとコピーし、「overlay 追加」ミューテーションが書き込めるようにする。
function makeCleanCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-commons-consumer-'));
  const copyRel = (rel) => {
    const src = join(ROOT, rel);
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  };
  copyFileSync(LOCK_PATH, join(dir, 'agent-commons.lock.json'));
  for (const rel of Object.keys(lock.outputs)) copyRel(rel);
  for (const rel of Object.keys(lock.inputs)) copyRel(rel);
  // 検証スクリプト自身（consumerScriptsDir 配下の output に含まれるため通常は既にコピー済みだが、
  // lock 形式が変わっても検証だけは動かせるように明示コピーしておく）。
  copyRel(VERIFY_SCRIPT);
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// --- lock: 形式・manifest との整合 ------------------------------------------------------

test('agent-commons.lock.json: パースでき lockVersion: 1 を持つ', () => {
  assert.equal(lock.lockVersion, 1);
});

test('agent-commons.lock.json: commons.repo / commons.version が agent-manifest.json の commons と一致する', () => {
  assert.equal(lock.commons?.repo, manifest.commons?.repo);
  assert.equal(lock.commons?.version, manifest.commons?.version);
});

test('agent-commons.lock.json: outputs の全パスが実在し、manifest.targets のキーと整合する', () => {
  const targetEntries = Object.entries(manifest.targets);
  assert.ok(targetEntries.length > 0, 'agent-manifest.json に targets が無い');
  for (const rel of Object.keys(lock.outputs)) {
    const abs = join(ROOT, rel);
    assert.ok(existsSync(abs), `lock.outputs に記録された ${rel} が実在しない`);
    const posixRel = rel.split(sep).join('/');
    const matches = targetEntries.filter(([, dir]) => posixRel.startsWith(`${dir}/`));
    assert.ok(
      matches.length > 0,
      `${rel} がどの manifest.targets ディレクトリの配下にも属さない`,
    );
  }
});

// --- manifest: スキーマ健全性 -----------------------------------------------------------

test('agent-manifest.json: commons.repo / commons.version が単一行の非空文字列で存在する', () => {
  assert.equal(typeof manifest.commons?.repo, 'string');
  assert.ok(manifest.commons.repo.length > 0);
  assert.equal(typeof manifest.commons?.version, 'string');
  assert.ok(manifest.commons.version.length > 0);
});

test('agent-manifest.json: picks.groups が projection-guard を含む（無いと consumer に verifier が無くなる）', () => {
  assert.ok(Array.isArray(manifest.picks?.groups));
  assert.ok(
    manifest.picks.groups.includes('projection-guard'),
    'picks.groups に "projection-guard" が無い',
  );
});

test('agent-manifest.json: values の各エントリが単一行文字列で、制御文字・{{/}}・先頭 --- を含まない', () => {
  const values = manifest.values ?? {};
  assert.ok(Object.keys(values).length > 0, 'agent-manifest.json に values が無い');
  // eslint-disable-next-line no-control-regex -- 制御文字混入の検出そのものが目的
  const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
  for (const [key, value] of Object.entries(values)) {
    assert.equal(typeof value, 'string', `values.${key} が文字列でない`);
    assert.doesNotMatch(value, /\n/, `values.${key} が複数行を含む`);
    assert.doesNotMatch(value, CONTROL_CHARS_RE, `values.${key} が制御文字を含む`);
    assert.doesNotMatch(value, /\{\{/, `values.${key} が "{{" を含む`);
    assert.doesNotMatch(value, /\}\}/, `values.${key} が "}}" を含む`);
    assert.ok(!value.startsWith('---'), `values.${key} が "---" で始まる`);
  }
});

// --- in-repo canonical source が残っていないこと ---------------------------------------

test('agent-commons/ ディレクトリが存在しない（canonical source は外部リポジトリへ移管済み）', () => {
  assert.equal(existsSync(join(ROOT, 'agent-commons')), false);
});

// git に依存せずリポジトリ配下のファイルを列挙する。`git ls-files` を使うと、public 化 runbook の
// 「生成した sanitized tree（まだ git init していない）で npm run check を通す」ゲートで
// 「not a git repository」になって落ちる。走査対象は生成物・依存を除いた作業ファイル。
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.vite', 'playwright-report', 'test-results']);
function listRepoFiles(dirAbs = ROOT, relPrefix = '') {
  const out = [];
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    if (SCAN_SKIP_DIRS.has(entry.name)) continue;
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listRepoFiles(join(dirAbs, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

test('ローカルの agent-commons/ を実行・走査対象として参照する設定やコマンドが残っていない', () => {
  const tracked = listRepoFiles();
  // canonical source はこのリポジトリに存在しないので、`agent-commons/` 配下を**実際に使う**
  // 参照（projection CLI の起動コマンド、lint / 重複検査などの走査対象グロブ、import パス）が
  // 残っていてはならない。散文での言及（「このリポジトリは agent-commons/core を直接持たない」等）は
  // 正当なので対象にしない — 判定を散文へ広げると、正しい説明文を書けなくなる。
  // docs（.md）は散文で `agent-commons/core` に言及するのが正当なので、実行されうる形
  // （旧 CLI の起動コマンド）だけを見る。設定・スクリプトは引用符付きのパス・グロブ・import も見る。
  const COMMAND_RE = /node\s+agent-commons\//;
  const CONFIG_REF_RES = [
    /["'`]agent-commons\/[^"'`]*["'`]/, // 設定ファイルのパス・グロブ
    /from\s+['"][^'"]*agent-commons\/(core|scripts)/, // import 文
  ];
  const offenders = [];
  for (const rel of tracked) {
    if (rel === 'agent-commons.lock.json') continue;
    if (rel === 'tests/agentCommons.test.js') continue; // 本ファイル自身（上の正規表現リテラルの走査対象外）
    if (rel in lock.outputs) continue; // projected file の生成マーカーは正本の所在を示すもので参照ではない
    const abs = join(ROOT, rel);
    if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
    let text;
    try {
      text = readFileSync(abs, 'utf-8');
    } catch {
      continue; // バイナリ等
    }
    const res = rel.endsWith('.md') ? [COMMAND_RE] : [COMMAND_RE, ...CONFIG_REF_RES];
    if (res.some((re) => re.test(text))) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `ローカルの agent-commons/ を実行・走査対象として参照している: ${offenders.join(', ')}`,
  );
});

test('projected file の生成マーカーが owner 付きの private リポジトリ名を含まない', () => {
  // public tree には canonical source repository の owner 付き名を出さない方針。
  // 生成マーカーの「正本の所在」ラベルは agent-manifest.json の commons.repo が決めるので、
  // ここが owner 付きへ戻ったら projected file 全件に波及する。
  assert.equal(manifest.commons.repo, 'agent-commons');
  assert.equal(lock.commons.repo, 'agent-commons');
  for (const rel of Object.keys(lock.outputs)) {
    const text = readFileSync(join(ROOT, rel), 'utf-8');
    assert.doesNotMatch(
      text,
      /[A-Za-z0-9-]+\/agent-commons/,
      `${rel} の生成マーカーが owner 付きのリポジトリ名を含む`,
    );
  }
});

// --- overlays ディレクトリ ↔ overlays/README.md の parity -------------------------------

test('overlays: 意味のある名前を持ち、25 ファイル以下である（連番断片への回帰防止）', () => {
  const files = readdirSync(OVERLAYS_DIR).filter((f) => f !== 'README.md');
  assert.ok(files.length <= 25, `overlay ファイルが25件を超えている: ${files.length}件`);
  for (const f of files) {
    assert.doesNotMatch(
      f,
      /^[a-zA-Z0-9-]+\.\d{3}\.md$/,
      `overlay ファイル名が意味のない連番断片になっている: ${f}`,
    );
  }
});

test('overlays/README.md の一覧表に載っている overlay 名がすべて実在する', () => {
  const readmeText = readFileSync(join(OVERLAYS_DIR, 'README.md'), 'utf-8');
  const actualFiles = new Set(readdirSync(OVERLAYS_DIR).filter((f) => f !== 'README.md'));
  const namesInReadme = [...readmeText.matchAll(/`([a-zA-Z0-9.-]+\.md)`/g)].map((m) => m[1]);
  const listedOverlayNames = namesInReadme.filter((n) => actualFiles.has(n) || n !== 'README.md');
  assert.ok(listedOverlayNames.length > 0, 'overlays/README.md に overlay 名の言及が見つからない');
  for (const name of new Set(listedOverlayNames)) {
    assert.ok(actualFiles.has(name), `overlays/README.md が言及する "${name}" が実在しない`);
  }
});

test('overlays: 実在する overlay ファイルがすべて overlays/README.md の一覧表に載っている', () => {
  const readmeText = readFileSync(join(OVERLAYS_DIR, 'README.md'), 'utf-8');
  const actualFiles = readdirSync(OVERLAYS_DIR).filter((f) => f !== 'README.md');
  for (const f of actualFiles) {
    assert.ok(readmeText.includes(f), `overlay ファイル "${f}" が overlays/README.md の一覧表に載っていない`);
  }
});

// --- verify-projection.js: 正常系 --------------------------------------------------------

test('verify-projection.js: クリーンなツリー（リポジトリ本体）で exit 0', () => {
  const r = runVerify(ROOT);
  assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.match(r.stdout, /agent-commons projection OK/);
});

test('verify-projection.js: 一時コピー（クリーン）でも exit 0', () => {
  const dir = makeCleanCopy();
  try {
    const r = runVerify(dir);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
  } finally {
    cleanup(dir);
  }
});

// --- verify-projection.js: 異常系（すべて一時コピー上で行い、実ツリーは変更しない） -----------

test('verify-projection.js: projected file を手編集すると exit 非0 でファイル名を含む', () => {
  const dir = makeCleanCopy();
  try {
    const [rel] = Object.keys(lock.outputs);
    const abs = join(dir, rel);
    writeFileSync(abs, `${readFileSync(abs, 'utf-8')}\n手編集\n`);
    const r = runVerify(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    cleanup(dir);
  }
});

test('verify-projection.js: projected file を削除すると exit 非0 でファイル名を含む', () => {
  const dir = makeCleanCopy();
  try {
    const [rel] = Object.keys(lock.outputs);
    rmSync(join(dir, rel));
    const r = runVerify(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(r.stderr, /欠落/);
  } finally {
    cleanup(dir);
  }
});

test('verify-projection.js: overlay ファイルを編集すると exit 非0 でファイル名を含む（reprojection 漏れ）', () => {
  const dir = makeCleanCopy();
  try {
    const overlayRel = Object.keys(lock.inputs).find((rel) => rel.startsWith(`${manifest.overlaysDir}/`));
    assert.ok(overlayRel, '前提: lock.inputs に overlay ファイルが記録されている');
    const abs = join(dir, overlayRel);
    writeFileSync(abs, `${readFileSync(abs, 'utf-8')}\n編集\n`);
    const r = runVerify(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(overlayRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(r.stderr, /未反映/);
  } finally {
    cleanup(dir);
  }
});

test('verify-projection.js: 新しい overlay ファイルを追加すると exit 非0（reprojection 漏れ）', () => {
  const dir = makeCleanCopy();
  try {
    const newOverlay = join(dir, manifest.overlaysDir, 'new-overlay-test.md');
    writeFileSync(newOverlay, '新規 overlay の本文\n');
    const r = runVerify(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /new-overlay-test\.md/);
    assert.match(r.stderr, /未反映/);
  } finally {
    cleanup(dir);
  }
});

test('verify-projection.js: agent-manifest.json を編集すると exit 非0（reprojection 漏れ）', () => {
  const dir = makeCleanCopy();
  try {
    const abs = join(dir, 'agent-manifest.json');
    const edited = JSON.parse(readFileSync(abs, 'utf-8'));
    edited.values = { ...edited.values, __test_added_key__: 'x' };
    writeFileSync(abs, JSON.stringify(edited, null, 2));
    const r = runVerify(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /agent-manifest\.json/);
  } finally {
    cleanup(dir);
  }
});

test('verify-projection.js: execConfigModule を編集すると exit 非0（reprojection 漏れ）', () => {
  const dir = makeCleanCopy();
  try {
    const rel = manifest.execConfigModule;
    assert.ok(rel, '前提: agent-manifest.json に execConfigModule がある');
    const abs = join(dir, rel);
    writeFileSync(abs, `${readFileSync(abs, 'utf-8')}\n// test edit\n`);
    const r = runVerify(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    cleanup(dir);
  }
});

test('verify-projection.js: targets 配下に生成マーカー付きの余分なファイルを置くと exit 非0（orphan 検出）', () => {
  const dir = makeCleanCopy();
  try {
    const targetDir = join(dir, manifest.targets.claudeAgentsDir);
    const strayAbs = join(targetDir, 'stray-orphan-test.md');
    writeFileSync(
      strayAbs,
      '<!-- agent-commons:generated source=stray-orphan-test version=1.0.0 — 手編集しない。正本は agent-commons/core と docs/agent-workflows/overlays -->\n\nbody\n',
    );
    const r = runVerify(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /stray-orphan-test\.md/);
    assert.match(r.stderr, /余分な生成物/);
  } finally {
    cleanup(dir);
  }
});


// --- verify-projection.js から独立したハッシュ照合（敵対的レビュー N1 の回帰ガード） ------
//
// scripts/agent/verify-projection.js は projection の生成物であり、lock.outputs に自分自身も
// 含んでいる。しかし**自分で自分を検証しても改竄は防げない** — 検証スクリプトに「このファイルは
// 飛ばす」という数行を足せば、lock を一切触らずに全検出を無効化できる（実測済み）。
// そこで consumer 側は、その検証スクリプトを一切実行しない独立した照合を1つ持つ。
// このテストが verify-projection.js を spawn しないことが本質なので、ここで runVerify を
// 使ってはならない。
function sha256Of(absPath) {
  return `sha256:${createHash('sha256').update(readFileSync(absPath)).digest('hex')}`;
}

test('独立照合: lock.outputs の全ファイルが受領証のハッシュと一致する（verify-projection.js を実行しない）', () => {
  const mismatched = [];
  for (const [rel, expected] of Object.entries(lock.outputs)) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      mismatched.push(`${rel}: 欠落`);
      continue;
    }
    const actual = sha256Of(abs);
    if (actual !== expected) mismatched.push(`${rel}: ${actual} !== ${expected}`);
  }
  assert.deepEqual(mismatched, [], `projected file が受領証と一致しない:\n${mismatched.join('\n')}`);
});

test('独立照合: lock.inputs の全ファイルが受領証のハッシュと一致する', () => {
  const mismatched = [];
  for (const [rel, expected] of Object.entries(lock.inputs)) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      mismatched.push(`${rel}: 欠落`);
      continue;
    }
    const actual = sha256Of(abs);
    if (actual !== expected) mismatched.push(`${rel}: ${actual} !== ${expected}`);
  }
  assert.deepEqual(mismatched, [], `projection 入力が受領証と一致しない（再 projection 漏れ）:\n${mismatched.join('\n')}`);
});

test('独立照合: 検証スクリプト自身も受領証の対象で、そのハッシュが一致する', () => {
  assert.ok(VERIFY_SCRIPT in lock.outputs, '検証スクリプトが lock.outputs に含まれていること');
  assert.equal(sha256Of(join(ROOT, VERIFY_SCRIPT)), lock.outputs[VERIFY_SCRIPT]);
});

test('独立照合: lock の走査範囲は manifest の targets / overlaysDir と一致する', () => {
  assert.deepEqual(lock.targets, manifest.targets);
  assert.equal(lock.overlaysDir, manifest.overlaysDir);
  assert.equal(lock.manifest, 'agent-manifest.json');
  assert.ok(lock.manifest in lock.inputs, '受領証のアンカーである manifest 自身がハッシュ検証対象であること');
});

// --- 結合点の drift ガード ---------------------------------------------------------------

test('agents:project は npm の追加引数（--prune 等）を projection CLI へ素通しする', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const script = pkg.scripts['agents:project'];
  assert.match(
    script,
    /"\$@"/,
    'sh -c でラップすると npm の追加引数が落ちるため、"$@" で明示的に素通しすること',
  );
  assert.match(script, /--commons-revision/, 'provenance（revision）を必ず記録すること');
});

test('projected な .js は Prettier の整形対象から除外されている', () => {
  const ignore = readFileSync(join(ROOT, '.prettierignore'), 'utf-8')
    .split('\n')
    .map((l) => l.trim());
  for (const rel of Object.keys(lock.outputs)) {
    if (!rel.endsWith('.js')) continue;
    assert.ok(
      ignore.includes(rel),
      `projected file "${rel}" が .prettierignore に無い（npm run format が生成物を書き換える）`,
    );
  }
});
