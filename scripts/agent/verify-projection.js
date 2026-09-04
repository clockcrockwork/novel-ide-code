#!/usr/bin/env node
// <!-- agent-commons:generated source=consumer-verify-projection version=1.0.0 — 手編集しない。正本は agent-commons/core と docs/agent-workflows/overlays -->
// consumer リポジトリ側の projection 検証。**canonical source（agent-commons）へアクセスせずに**
// 「projected file が受領証（lock）どおりか」を fail-closed で検査する。
//
// なぜ commons を見ないのか: consumer の CI は public / fork PR でも動きうるため、private な
// canonical source への network / token 依存を持たせない。代わりに、trusted environment での
// projection が残した lock（各 projected file と各入力のハッシュ）だけで検証する。
//
// 検出する事象:
//   0. 受領証そのものの無効化（走査範囲の縮小・空の受領証・provenance 欠落）
//   1. projected file の手編集・欠落（outputs のハッシュ不一致 / 不在）
//   2. manifest / overlay / execConfigModule を変えたのに reprojection していない（inputs の不一致）
//   3. overlay を追加したのに reprojection していない（overlaysDir 内の未記録ファイル）
//   4. lock に無い生成マーカー付きファイル（orphan）
//
// 検査0 が必要な理由: lock は consumer リポジトリにコミットされた**書き換え可能な**ファイルであり、
// 走査範囲（targets / overlaysDir）を lock 側だけで決めると、lock の1行を縮めるだけで検査3・4 を
// 無効化できてしまう（ハッシュの再計算すら要らない）。そこで走査範囲は必ず consumer manifest と
// 突き合わせ、その manifest のパスは lock ではなくこのファイルの定数で固定する
// （lock 側に選ばせると、囮の manifest を1つ置いて lock をそこへ向けるだけで範囲を偽装できる）。
//
// **この検証が守る相手は「うっかり」であって「攻撃者」ではない。**
// 検出するのは、projected file の手編集・削除、入力を変えたのに再 projection していない状態、
// 消し忘れた生成物。**lock 自体を書き換える相手には勝てない** — 例えば lock.inputs から1行
// 削除すれば、その入力ファイルはハッシュ照合の対象から外れる（ハッシュの再計算も、生成マーカーの
// 除去も要らず、成功時のファイル数表示も変わらないので tell が無い）。lock.outputs 側も同様で、
// entry を落として当該ファイルの生成マーカーを消せば全検査を外れる。
// lock は改竄への防壁ではなく受領証である。
//
// 改竄に対する本当の backstop は canonical source 側の trusted reprojection
// （registry から出力を作り直してバイト比較する `--check`）と、それが consumer へ出す
// 差分 PR のレビューにある。上記の改竄はいずれも `--check` が exit 1 で検出する。
//
// なお、このスクリプト自身も lock.outputs に含まれるが、**自分で自分を検証しても改竄は防げない**。
// consumer 側はこのスクリプトから独立したハッシュ照合（テスト等）を1つ持つこと。
//
// 使い方: node <このファイル> [--lock agent-commons.lock.json]
// リポジトリルートは lock ファイルのあるディレクトリ。node ビルトインのみに依存する。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const DEFAULT_LOCK_FILE = 'agent-commons.lock.json';
// consumer manifest のパスも lock と同じく**固定**する。lock 側の値をそのまま信じて
// manifest を読むと、囮の JSON を1つ置いて lock の `manifest` をそこへ向けるだけで
// 走査範囲を偽装できてしまう（実 manifest を触らないのでハッシュ検査も通る）。
// アンカーを固定することで、範囲を偽るには実 manifest 自体の編集が必要になる。
const DEFAULT_MANIFEST_FILE = 'agent-manifest.json';
const SUPPORTED_LOCK_VERSION = 1;
// provenance は単一行の短い識別子（git SHA）に限る。改行や制御文字を許すと、検証成功時の
// 出力へ偽の行を差し込んで CI ログを偽装できる。
const REVISION_RE = /^[0-9A-Za-z._-]{7,64}$/;

// 生成マーカー行（agent-commons/scripts/lib/marker.js と同一書式。行全体一致のみをマーカーとみなす）。
const MARKER_LINE_RE =
  /^(?:\/\/ )?<!-- agent-commons:generated source=(\S+) version=(\S+) — 手編集しない。正本は .+ -->$/;

function parseArgs(argv) {
  let lock = DEFAULT_LOCK_FILE;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--lock') {
      lock = argv[(i += 1)];
      if (!lock) throw new Error('--lock にはパスが必要です');
    } else {
      throw new Error(`未知の引数です: ${argv[i]}`);
    }
  }
  return { lock };
}

function hashFile(abs) {
  return `sha256:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`;
}

function toPosixRel(rootAbs, abs) {
  return relative(rootAbs, abs).split(sep).join('/');
}

// marker.js の detectGeneratedMarker と同じ判定位置（1行目 / shebang 直後 / frontmatter 直後 /
// `# ` 見出し直後の blockquote・コメント連続行）だけを見る。本文中の引用は誤検出しない。
function hasGeneratedMarker(text) {
  const lines = text.split('\n');
  if (MARKER_LINE_RE.test(lines[0] ?? '')) return true;
  if ((lines[0] ?? '').startsWith('#!') && MARKER_LINE_RE.test(lines[1] ?? '')) return true;
  const fm = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/.exec(text);
  if (fm && MARKER_LINE_RE.test(fm[2].split('\n')[0] ?? '')) return true;
  if ((lines[0] ?? '').startsWith('# ')) {
    let idx = 1;
    if (lines[idx] === '') idx += 1;
    while (lines[idx] && (lines[idx].startsWith('>') || lines[idx].startsWith('<!--'))) {
      if (MARKER_LINE_RE.test(lines[idx])) return true;
      idx += 1;
    }
  }
  return false;
}

function walkFiles(dirAbs, visit) {
  let entries;
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dirAbs, entry.name);
    if (entry.isDirectory()) walkFiles(abs, visit);
    else if (entry.isFile()) visit(abs);
  }
}

// 配列や null を「オブジェクト」として通すと、走査対象が空のまま検証が成立してしまう。
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// 検査0: 受領証そのものが有効か。ここを緩めると以降の検査が空振りでも exit 0 になる。
function assertLockUsable(lock, lockAbs) {
  if (lock.lockVersion !== SUPPORTED_LOCK_VERSION) {
    throw new Error(
      `lock の lockVersion ${lock.lockVersion} はこの検証スクリプト（対応: ${SUPPORTED_LOCK_VERSION}）では扱えません`,
    );
  }
  for (const key of ['outputs', 'inputs', 'targets']) {
    if (!isPlainObject(lock[key])) {
      throw new Error(`lock の "${key}" がオブジェクトではありません: ${lockAbs}`);
    }
  }
  if (lock.manifest !== DEFAULT_MANIFEST_FILE) {
    throw new Error(
      `lock の "manifest" は "${DEFAULT_MANIFEST_FILE}" 固定です（受け取った値: ${JSON.stringify(lock.manifest)}）。` +
        'lock 側で走査範囲の照合先を選べると、囮の manifest を置くだけで範囲を偽装できるため固定する',
    );
  }
  if (!(lock.manifest in lock.inputs)) {
    throw new Error(
      `lock の "manifest"（${lock.manifest}）が inputs に含まれていません（受領証として不整合）: ${lockAbs}`,
    );
  }
  if (Object.keys(lock.outputs).length === 0) {
    throw new Error(`lock の "outputs" が空です（0 件の検証は検証になりません）: ${lockAbs}`);
  }
  if (Object.keys(lock.targets).length === 0) {
    throw new Error(`lock の "targets" が空です（走査範囲が無いと orphan を検出できません）: ${lockAbs}`);
  }
  if (!isPlainObject(lock.commons)) {
    throw new Error(`lock に "commons" がありません: ${lockAbs}`);
  }
  if (!lock.commons.repo && !lock.commons.path) {
    throw new Error(`lock の "commons" に repo / path のどちらもありません: ${lockAbs}`);
  }
  if (typeof lock.commons.version !== 'string' || lock.commons.version === '') {
    throw new Error(`lock の "commons.version" がありません: ${lockAbs}`);
  }
  // revision は「未記録（null）」は許すが、空文字は provenance を失ったまま記録された印なので拒否する。
  // 併せて書式（単一行の短い識別子）も課す。改行を含む値は成功時の出力へ偽の行を差し込める。
  if (lock.commons.revision !== null && lock.commons.revision !== undefined) {
    if (typeof lock.commons.revision !== 'string' || lock.commons.revision.trim() === '') {
      throw new Error(
        `lock の "commons.revision" が空です（projection 時に revision の解決へ失敗した受領証）: ${lockAbs}`,
      );
    }
    if (!REVISION_RE.test(lock.commons.revision)) {
      throw new Error(
        `lock の "commons.revision" の書式が不正です（単一行の英数字・. _ - のみ、7〜64文字）: ${JSON.stringify(lock.commons.revision)}`,
      );
    }
  }
  // inputs / outputs のキーはリポジトリルート相対の POSIX パスに限る。絶対パスや ".." を
  // 許すと、リポジトリ外のファイルを検証対象にした受領証が環境次第で通ってしまう。
  for (const [field, table] of [['inputs', lock.inputs], ['outputs', lock.outputs]]) {
    for (const rel of Object.keys(table)) {
      if (
        rel === '' ||
        rel.startsWith('/') ||
        rel.startsWith('\\') ||
        // 区切りは `/` と `\` の両方を見る（Windows consumer では `docs\..\..\x` が
        // リポジトリ外へ解決するため、forward slash だけの判定では素通りする）
        /(^|[/\\])\.\.([/\\]|$)/.test(rel) ||
        /^[A-Za-z]:/.test(rel)
      ) {
        throw new Error(`lock の "${field}" にリポジトリ外を指しうるパスがあります: ${rel}`);
      }
    }
  }
}

// 検査0（続き）: 走査範囲を manifest と突き合わせる。lock 側だけで範囲を縮める攻撃を封じる。
function assertScopeMatchesManifest(lock, rootAbs, lockAbs) {
  const manifestAbs = resolve(rootAbs, DEFAULT_MANIFEST_FILE);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestAbs, 'utf-8'));
  } catch (err) {
    throw new Error(`consumer manifest を読めません（${DEFAULT_MANIFEST_FILE}）: ${err.message}`, { cause: err });
  }
  if (!isPlainObject(manifest.targets)) {
    throw new Error(`manifest に "targets" がありません: ${manifestAbs}`);
  }
  const lockTargets = JSON.stringify(Object.keys(lock.targets).sort().map((k) => [k, lock.targets[k]]));
  const manifestTargets = JSON.stringify(
    Object.keys(manifest.targets).sort().map((k) => [k, manifest.targets[k]]),
  );
  if (lockTargets !== manifestTargets) {
    throw new Error(
      `lock の "targets" が manifest の targets と一致しません（走査範囲が改変されたか、reprojection されていません）: ${lockAbs}`,
    );
  }
  if ((lock.overlaysDir ?? '') !== (manifest.overlaysDir ?? '')) {
    throw new Error(
      `lock の "overlaysDir" が manifest の overlaysDir と一致しません（走査範囲が改変されたか、reprojection されていません）: ${lockAbs}`,
    );
  }
}

function verify(lockAbs) {
  const rootAbs = dirname(lockAbs);
  const errors = [];
  const lock = JSON.parse(readFileSync(lockAbs, 'utf-8'));
  assertLockUsable(lock, lockAbs);
  assertScopeMatchesManifest(lock, rootAbs, lockAbs);

  // 1. projected file が受領証どおりか（手編集・欠落の検出）
  for (const [rel, expected] of Object.entries(lock.outputs)) {
    const abs = resolve(rootAbs, rel);
    if (!existsSync(abs)) {
      errors.push(`欠落: ${rel}（lock に記録された projected file が存在しない）`);
      continue;
    }
    if (hashFile(abs) !== expected) {
      errors.push(`手編集/drift: ${rel}（内容が lock のハッシュと一致しない。正本を直して再 projection すること）`);
    }
  }

  // 2. 入力（manifest / overlay / exec 設定）が受領証どおりか（reprojection 漏れの検出）
  for (const [rel, expected] of Object.entries(lock.inputs)) {
    const abs = resolve(rootAbs, rel);
    if (!existsSync(abs)) {
      errors.push(`欠落: ${rel}（lock に記録された projection 入力が存在しない）`);
      continue;
    }
    if (hashFile(abs) !== expected) {
      errors.push(`未反映: ${rel}（入力が変更されているのに reprojection されていない）`);
    }
  }

  // 3. overlay の追加漏れ（lock に無い overlay ファイル）
  if (typeof lock.overlaysDir === 'string' && lock.overlaysDir !== '') {
    const overlaysAbs = resolve(rootAbs, lock.overlaysDir);
    let entries;
    try {
      entries = readdirSync(overlaysAbs, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === 'README.md') continue;
      const rel = toPosixRel(rootAbs, join(overlaysAbs, entry.name));
      if (!(rel in lock.inputs)) {
        errors.push(`未反映: ${rel}（overlay が追加されているのに reprojection されていない）`);
      }
    }
  }

  // 4. orphan（lock に無い生成マーカー付きファイル）
  const targetDirs = [...new Set(Object.values(lock.targets))].map((rel) => resolve(rootAbs, rel));
  const roots = targetDirs.filter(
    (dirAbs) => !targetDirs.some((other) => other !== dirAbs && !relative(other, dirAbs).startsWith('..')),
  );
  const seen = new Set();
  for (const dirAbs of roots) {
    walkFiles(dirAbs, (abs) => {
      if (seen.has(abs)) return;
      seen.add(abs);
      let text;
      try {
        text = readFileSync(abs, 'utf-8');
      } catch {
        return;
      }
      if (!hasGeneratedMarker(text)) return;
      const rel = toPosixRel(rootAbs, abs);
      if (!(rel in lock.outputs)) {
        errors.push(`余分な生成物: ${rel}（生成マーカーを持つが lock に無い）`);
      }
    });
  }

  return { errors, lock };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lockAbs = resolve(process.cwd(), args.lock);
  if (!existsSync(lockAbs)) {
    process.stderr.write(`projection lock が見つかりません: ${lockAbs}\n`);
    process.exitCode = 1;
    return;
  }
  const { errors, lock } = verify(lockAbs);
  if (errors.length > 0) {
    process.stderr.write(
      `agent-commons projection の検証に失敗しました:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const rev = lock.commons.revision ?? '(revision 未記録)';
  process.stdout.write(
    `agent-commons projection OK — ${Object.keys(lock.outputs).length} ファイル / commons ${lock.commons.repo ?? lock.commons.path} @ ${lock.commons.version} ${rev}\n`,
  );
}

try {
  main();
} catch (err) {
  // 他のエラー経路（欠落 / 手編集 / 未反映 / 余分な生成物）と書式をそろえる。生の stack trace は
  // 「次に何をすればよいか」を示さないため、受領証が壊れている場合も同じ形で案内する。
  process.stderr.write(
    `agent-commons projection の検証に失敗しました:\n  - ${err.message}\n` +
      '  受領証（agent-commons.lock.json）と projected file は canonical source から再生成します。' +
      '手順は consumer リポジトリの docs（agent-commons の更新手順）を参照してください。\n',
  );
  process.exitCode = 1;
}
