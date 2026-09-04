// docs 相対リンクチェッカー（正本計画 §Suggested new issues「docs 相対リンクのチェッカー」の (1)）
// - .md 内の相対リンク/画像のリンク切れ検出（error, exit 1）
// - アンカーを github-slugger（GitHub 本体と同一実装）で実見出しと照合（error）
// - コードフェンス内の Markdown リンク（描画されない死にリンク）を警告（PR #388 #15 の再発防止）
// - public→control 境界リンクを警告（分離後にリンク切れになる。denylist は public-release-checklist §2 が正本）
// 使い方: npm run docs:links:check（error 時 exit 1）。CI では docs 変更時に docs-links ジョブが実行（#426）。
//
// Markdown の構文解析は mdast-util-from-markdown（リンク・画像・見出しの正本）と
// micromark のイベント列（fenced/indented の区別・未クローズフェンス判定）で行う（#400）。
// 正規表現による Markdown 構文解析はしない。唯一の例外はフェンス内容中の
// 「リンクらしき文字列」の警告検出（FENCE_LINKISH_RE。描画されないため近似で足りる）。
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { parse, preprocess, postprocess } from 'micromark';
import { CONTROL_ONLY_DIRS, isControlOnlyPath } from './policy/public-tree-policy.js';

// GitHub 描画に合わせ table / strikethrough を GFM として解釈する（scripts/agent/mdast-body.js と同一構成）。
// 非 GFM だと連続するテーブル行が単一段落に融合し、セル内 code span の対応が崩れて
// リンクでない文字列を偽リンク検出する（#426）。
function parseMarkdown(text) {
  return fromMarkdown(text, {
    extensions: [gfmTable(), gfmStrikethrough()],
    mdastExtensions: [gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown()],
  });
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// public 側に出さないディレクトリ（正本: scripts/policy/public-tree-policy.js。意味論の正本は
// docs/security/public-release-checklist.md §2）。後方互換のため本モジュールからも再 export する。
export { CONTROL_ONLY_DIRS };

const EXTERNAL_RE = /^[a-z][a-z0-9+.-]*:/i;
// フェンス内容中の「リンクらしき文字列」検出。フェンス内は描画されない前提の警告用なので近似でよい
const FENCE_LINKISH_RE = /\]\((#|\.{0,2}\/|[\w./-]*\.md)/;

const SLUG_NODE_TYPES = new Set(['heading']);
const LINK_NODE_TYPES = new Set(['link', 'image', 'definition']);

// 不正なパーセントエンコーディング（単独の % 等）で decodeURIComponent は URIError を投げる。
// 走査ツールが1つの不正リンクで全滅しないよう、失敗時は元文字列にフォールバックする。
export function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// micromark イベント列から fenced コードブロック情報を集める。
// codeIndented（インデントコードブロック）は描画上コードであり mdast 側でも link にならないため対象外。
function scanFencedBlocks(text) {
  const events = postprocess(parse().document().write(preprocess()(text, undefined, true)));
  const fences = [];
  let current = null;
  for (const [kind, token, context] of events) {
    if (token.type === 'codeFenced') {
      if (kind === 'enter') {
        current = { openLine: token.start.line, endLine: token.end.line, fenceTokens: 0, linkish: [] };
      } else {
        fences.push(current);
        current = null;
      }
    } else if (current && kind === 'exit' && token.type === 'codeFencedFence') {
      current.fenceTokens += 1;
    } else if (current && kind === 'enter' && token.type === 'codeFlowValue') {
      const raw = context.sliceSerialize(token);
      if (FENCE_LINKISH_RE.test(raw)) {
        current.linkish.push({ line: token.start.line, raw: raw.trim().slice(0, 80) });
      }
    }
  }
  return fences;
}

function collectNodes(node, types, out = []) {
  if (types.has(node.type)) out.push(node);
  for (const child of node.children ?? []) collectNodes(child, types, out);
  return out;
}

// 末尾の改行を除いた実質行数（未クローズフェンスが「文書末尾まで達した」かの判定用）
function lastContentLine(text) {
  const lines = text.split(/\r?\n/);
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

export function extractSlugs(text) {
  const slugger = new GithubSlugger();
  const slugs = new Set();
  for (const h of collectNodes(parseMarkdown(text), SLUG_NODE_TYPES)) {
    slugs.add(slugger.slug(toString(h)));
  }
  return slugs;
}

export function extractLinks(text) {
  const links = [];
  // definition は reference link（[text][ref] + [ref]: url）の url 定義。従来は素通りだった検出漏れを塞ぐ。
  // 未定義参照（linkReference のみ）はレンダリングされずリンクにならないため対象外
  for (const n of collectNodes(parseMarkdown(text), LINK_NODE_TYPES)) {
    links.push({ target: n.url, line: n.position.start.line });
  }
  const fences = scanFencedBlocks(text);
  const fenceWarnings = fences.flatMap((f) => f.linkish);
  // 閉じフェンスを持たず文書末尾まで達したフェンスのみ未クローズ扱い。
  // blockquote 等のコンテナ終端で暗黙クローズされたものは描画が崩れないため対象外
  const docEnd = lastContentLine(text);
  const unclosed = fences.find((f) => f.fenceTokens < 2 && f.endLine >= docEnd);
  return { links, fenceWarnings, unclosedFence: unclosed ? unclosed.openLine : null };
}

export function checkFile(root, relFile, slugCache = new Map()) {
  const abs = join(root, relFile);
  const text = readFileSync(abs, 'utf-8');
  const relPosix = relFile.split(sep).join('/');
  const errors = [];
  const warnings = [];

  // 自己参照アンカー検証で同一ファイルを再読込しないよう、既読の text から slug を先行登録する
  if (!slugCache.has(abs)) slugCache.set(abs, extractSlugs(text));

  const { links, fenceWarnings, unclosedFence } = extractLinks(text);
  if (unclosedFence !== null) {
    // 閉じ忘れ fence は以降の開閉を全て反転させ、GitHub 描画とリンク検出の両方を壊す根本原因
    errors.push({ line: unclosedFence, msg: 'コードフェンス未クローズ（以降の描画・リンクが崩れる）' });
  }
  for (const w of fenceWarnings) {
    warnings.push({ line: w.line, msg: `コードフェンス内に Markdown リンク（描画されない）: ${w.raw}` });
  }

  const getSlugs = (file) => {
    if (!slugCache.has(file)) slugCache.set(file, extractSlugs(readFileSync(file, 'utf-8')));
    return slugCache.get(file);
  };

  for (const { target, line } of links) {
    if (EXTERNAL_RE.test(target)) continue;
    if (target.startsWith('/')) {
      warnings.push({ line, msg: `絶対パスリンク（GitHub 上ではドメイン基準になる）: ${target}` });
      continue;
    }
    const [rawPath, ...anchorParts] = target.split('#');
    const anchor = anchorParts.join('#');
    // クエリ文字列（?plain=1 等。GitHub がサポート）はファイル解決前に落とす
    const pathPart = rawPath.split('?')[0];
    const targetAbs = pathPart === '' ? abs : resolve(dirname(abs), safeDecode(pathPart));

    // Windows のドライブ文字大小差で startsWith が誤判定するため relative ベースで判定する。
    // 素の startsWith('..') は '..foo' という名前のファイルを誤検出するのでセグメント境界で見る。
    const rel = relative(root, targetAbs);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      errors.push({ line, msg: `リポジトリ外を指すリンク: ${target}` });
      continue;
    }
    if (!existsSync(targetAbs)) {
      errors.push({ line, msg: `リンク切れ（実在しない）: ${target}` });
      continue;
    }
    const isDir = statSync(targetAbs).isDirectory();
    const targetRel = rel.split(sep).join('/');
    if (!isControlOnlyPath(relPosix) && isControlOnlyPath(targetRel)) {
      warnings.push({ line, msg: `public→control リンク（repo 分離後に切れる）: ${target}` });
    }
    if (anchor) {
      if (isDir || !targetAbs.endsWith('.md')) {
        warnings.push({ line, msg: `.md 以外へのアンカー指定: ${target}` });
      } else if (!getSlugs(targetAbs).has(safeDecode(anchor))) {
        // slug は常に小文字。リンク側を小文字化すると大小文字違い（GitHub 実 id と不一致）を見逃すため素で照合する
        errors.push({ line, msg: `アンカー不在（見出しと不一致）: ${target}` });
      }
    }
  }
  return { errors, warnings };
}

export function checkRepo(root, relFiles) {
  const slugCache = new Map();
  const results = [];
  for (const f of relFiles) {
    const { errors, warnings } = checkFile(root, f, slugCache);
    if (errors.length || warnings.length) results.push({ file: f.split(sep).join('/'), errors, warnings });
  }
  return results;
}

// ベンダリングされた外部スキルのガイド本文（`skills` CLI が上流から同期する。例:
// .agents/skills/modern-web-guidance/guides/**）はチェック対象外。上流独自の見出し id 記法
// （`## 見出し {: #anchor }`）等は GitHub slug と一致せずアンカー error になるが、こちらで
// 直すと次回同期で必ず差し戻る（＝我々が修正できない error）。SKILL.md は自リポジトリ側の
// 追記（docs/ への相対リンク）を持つため対象に残す。
export function isVendoredSkillGuide(relFile) {
  const segs = relFile.split(sep).join('/').split('/');
  const i = segs.indexOf('skills');
  return i > 0 && (segs[i - 1] === '.agents' || segs[i - 1] === '.claude') && segs[i + 2] === 'guides';
}

// agent-commons の overlay 断片（projection input）は対象外（#agent-commons-vertical-slice）。
// core テンプレートは canonical source repo（agent-commons）側にあり、
// このリポジトリには存在しないため対象外判定も不要（projection 後の出力先
// docs/agent-workflows/** 等が正本チェック対象になる、通常の対象のまま）。
// - `docs/agent-workflows/overlays/*.md`（README.md を除く）: 抽出元ドキュメントの
//   意味単位のブロック（完結した文・段落）を保持する overlay ファイルで、相対リンクは
//   抽出元ドキュメントの置き場所（projection 先）を基準に書かれており、overlays/ 自身を
//   基準にチェックすると誤検出になる。README.md は overlay の使い方を説明する通常の
//   文書（相対リンクを持たない）なので対象に残す。
export function isOverlayFragment(relFile) {
  const posix = relFile.split(sep).join('/');
  // overlays/README.md は overlay の使い方を説明する通常の文書なので対象に残す。
  // それ以外の overlays/*.md は抽出元ドキュメントの断片・ブロックで、単独では
  // 文脈（見出し・相対パスの基準）を持たないため対象外とする。
  if (/^docs\/agent-workflows\/overlays\/(?!README\.md$).+\.md$/.test(posix)) return true;
  return false;
}

function listMarkdownFiles(root) {
  const run = (args) => {
    try {
      // -z で NUL 区切り出力にする。日本語/スペースを含むファイル名の8進エスケープ+クォートと
      // Windows の \r\n 混入の両方を回避できる（filter(Boolean) で末尾の空要素を除去）
      return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).split('\0').filter(Boolean);
    } catch {
      // git 非在・非 git リポジトリ環境向けの分かりやすいメッセージ（readdir フォールバックは
      // git 前提の tracked/denylist 判定と噛み合わないためスコープ外。PR #393 対応履歴参照）
      console.error('docs:links:check は git 管理下のリポジトリ内で実行してください（git コマンドの実行に失敗しました）。');
      process.exit(1);
    }
  };
  const tracked = run(['ls-files', '-z', '--', '*.md']);
  const untracked = run(['ls-files', '-z', '--others', '--exclude-standard', '--', '*.md']);
  // ローカル削除済み・未コミットの追跡ファイルは ls-files に残るため、実在するものだけに絞る（readFileSync の ENOENT 回避）
  return [...new Set([...tracked, ...untracked])]
    .filter((f) => existsSync(join(root, f)))
    .filter((f) => !isVendoredSkillGuide(f))
    .filter((f) => !isOverlayFragment(f));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const results = checkRepo(ROOT, listMarkdownFiles(ROOT));
  let errorCount = 0;
  let warnCount = 0;
  for (const r of results) {
    for (const e of r.errors) {
      errorCount += 1;
      console.error(`ERROR ${r.file}:${e.line} ${e.msg}`);
    }
    for (const w of r.warnings) {
      warnCount += 1;
      console.warn(`WARN  ${r.file}:${w.line} ${w.msg}`);
    }
  }
  console.error(`\ndocs:links:check — errors: ${errorCount}, warnings: ${warnCount}`);
  if (errorCount > 0) process.exit(1);
}
