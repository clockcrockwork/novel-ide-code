import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';

// --- Markdown 構造解析の共有部品（mdast + GFM 拡張。#403 で check-artifacts.js に導入、
// #409 で plan ゲートと共有するため抽出） ---
// PR #396 のレビュー46件の相当数（エスケープパイプのセル境界・行末スペース・HTML コメント
// 適用漏れ・テーブルブロック境界）は「手書き Markdown 解析と GitHub 実描画の乖離」クラスだった。
// 構造の解釈（見出し→セクション、テーブル→行/セル、コメント）は GitHub と同系実装の
// micromark/mdast に委ね、正規表現による Markdown 構文解析はしない（scripts/check-doc-links.js と
// 同方針）。値の受理文法（収束宣言・証拠ポインタ等）は各ゲート側に残す。
// 注意: parseBody に渡した文字列と、sectionSourceLines の src には
// 同一の文字列を渡すこと（position offset の整合が前提）。例外として、長さ・改行位置を
// 保存する変換で対応づく offset 互換の文字列は渡してよい（check-plan.js のコメント空白化）。

export function parseBody(src) {
  return fromMarkdown(src, {
    extensions: [gfmTable(), gfmStrikethrough()],
    mdastExtensions: [gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown()],
  });
}

// 構文解析前の資源ガード。micromark は行数の多い入力（テーブル行等の行指向構造）で
// 二次時間になる（実測: 標準テーブル行 3200 で ~3s。先頭パイプなしの行・blockquote 内の表・
// 単一列表に吸収される平文行など「パイプを含まないテーブル行」が存在するため、テーブル行だけを
// 数える近似は原理的に迂回可能 — 全構成を一様に抑えるには総行数で上限を掛ける。最悪構成
// 〔標準テーブル行〕で 2000 行 ≈ 1.2s）。引用ネストは1行で成立する（`>>>…` 30000 段 ≈ 3s）
// ため行数と独立に上限を掛ける。上限は実 PR（#396 本文 ~200 行・引用 ~2 段）の約 10 倍。
// 超過時の扱い（fail-loud か警告か）と skip マーカーによる免除は呼び出し側の責務
export function resourceGuardErrors(
  src,
  { subject = 'PR 本文', maxLines = 2000, maxQuoteDepth = 32 } = {},
) {
  const errors = [];
  // src は文字列（従来）または呼び出し側が既に持つ行配列を直接受理する（check-plan.js の
  // guardLines 等。join→split の恒等往復を避ける。要素に改行を含まない配列前提）
  const lines = Array.isArray(src) ? src : src.split('\n');
  if (lines.length > maxLines) {
    errors.push(
      `${subject}の行数が多すぎます（${lines.length} 行 > 上限 ${maxLines} 行）。本文を分割・削減してください`,
    );
    // 行数超過が確定した時点で return する。呼び出し側はいずれも guard.length > 0 のみで
    // 分岐するため、以降の引用ネスト走査（行数分の追加ループ）は無駄
    return errors;
  }
  let deepest = 0;
  for (const line of lines) {
    const match = /^\s*(?:>\s*)+/.exec(line);
    if (!match) continue;
    const depth = match[0].replace(/[^>]/g, '').length;
    if (depth > deepest) deepest = depth;
  }
  if (deepest > maxQuoteDepth) {
    errors.push(
      `${subject}の引用（>）のネストが深すぎます（${deepest} 段 > 上限 ${maxQuoteDepth} 段）`,
    );
  }
  return errors;
}

// HTML コメントのみの html ノード（テンプレの説明文・例示）。全判定から除外する。
// skip マーカー自体は skip 判定用に生本文へ残す必要があるため各ゲート側で個別に扱う
export function isCommentNode(node) {
  if (node.type !== 'html') return false;
  if (!node.value.includes('<!--')) return false;
  return node.value.replace(/<!--[\s\S]*?-->/g, '').trim() === '';
}

// html ノード value 内の HTML コメント区間を、タグ／引用符状態を追跡する単一の左→右
// スキャンで収集し base offset を加えて spans へ push する。`<!--` は「データ状態（タグの
// 外）に現れた場合のみ」コメント開始として扱う（HTML の字句規則。属性値内の
// `title="<!-- x -->"` は GitHub 上もコメントではなく可視テキストのため strip しない）。
// 引用符は「タグ内（`<...>`）でのみ」属性値の区切りとして扱う — 要素テキスト内容の `"`/`'`
// は単なる文字であり、これを属性区切りと誤認すると要素テキスト中の実コメントを取り逃す
// （偽陰性＝ゲートバイパス。#414 追加レビュー指摘）。コメント検出時は閉じ `-->` まで i を
// ジャンプするためコメント本文内の引用符・タグは状態に混入しない。閉じ `-->` が無い閉じ忘れ
// コメントは文書末までの番兵 span（stripSpans 側で clamp）。引用符がタグ内で閉じないまま
// 終端に達した場合は属性の対応が崩れた不正 HTML のため、見逃しを避けて fail-closed: 未閉鎖
// quote 開始位置以降の `<!--` を未閉鎖コメント扱いで文書末まで無効化する
// （#413 rounds 3-6 の quote/属性/タグ文脈クラスを統合）
function collectHtmlCommentSpans(value, base, spans) {
  let inTag = false;
  let quote = null;
  let quoteStart = -1;
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        quoteStart = -1;
      }
      i++;
      continue;
    }
    if (!inTag && value.startsWith('<!--', i)) {
      const close = value.indexOf('-->', i + 4);
      if (close === -1) {
        spans.push([base + i, Number.MAX_SAFE_INTEGER]);
        return spans;
      }
      spans.push([base + i, base + close + 3]);
      i = close + 3;
      continue;
    }
    if (inTag) {
      if (ch === '>') inTag = false;
      else if (ch === '"' || ch === "'") {
        quote = ch;
        quoteStart = i;
      }
      i++;
      continue;
    }
    // データ状態の `<`。`<!--` は上でコメント処理済み。ここでの分岐は HTML5 tag-open-state に従う:
    // - `<!` / `<?`（マークアップ宣言・DOCTYPE・処理命令・bogus comment）は属性の引用符状態を
    //   持たず最初の `>` で終わる。引用符を属性区切りと誤認すると、宣言内の `"` で quote に入り
    //   後続の実コメント `<!--` を取り逃す（#414 追加レビュー指摘）。`>` まで読み飛ばす（`>` が
    //   無ければ GitHub 上不可視のまま文書末まで続くため fail-closed で番兵 span）
    // - `<` + ASCII 英字 / `/` は開始・終了タグ（属性引用符を追跡する tag 文脈へ）
    // - それ以外（`< b` `<4` 等、後続が空白・数字）はリテラルテキストで tag ではない
    const next = value[i + 1] ?? '';
    if (ch === '<' && (next === '!' || next === '?')) {
      const gt = value.indexOf('>', i + 1);
      if (gt === -1) {
        spans.push([base + i, Number.MAX_SAFE_INTEGER]);
        return spans;
      }
      i = gt + 1;
      continue;
    }
    if (ch === '<' && /[A-Za-z/]/.test(next)) inTag = true;
    i++;
  }
  if (quote) {
    const u = value.indexOf('<!--', quoteStart);
    if (u !== -1) spans.push([base + u, Number.MAX_SAFE_INTEGER]);
  }
  return spans;
}

// ノード配下の HTML コメント区間（offset の組）を文書順に収集する。
// position は unist 仕様上 optional（本文＝外部入力由来の AST という境界のため、
// GFM 拡張が付与し忘れるノードがあっても構造検査全体をクラッシュさせない）
// html ノード内埋め込みコメントも offset 変換で収集する（`<!-- refs #N --><b>x</b>` 同居ノードのバイパス対策 #413。閉じ忘れは文書末までを番兵 span とし stripSpans 側で clamp）
export function commentSpans(node, spans = []) {
  if (node.type === 'html' && node.value.includes('<!--')) {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start == null || end == null) return spans;
    if (isCommentNode(node)) {
      spans.push([start, end]);
      return spans;
    }
    collectHtmlCommentSpans(node.value, start, spans);
    return spans;
  }
  for (const child of node.children ?? []) commentSpans(child, spans);
  return spans;
}

// 未クローズ HTML コメント（`-->` が無い）の有無。commentSpans が未クローズを文書末までの番兵 span（end=Number.MAX_SAFE_INTEGER）で表すことを利用する（フェンス内 `<!--` は code ノードのため対象外）（#415）
export function hasUnclosedHtmlComment(tree) {
  return commentSpans(tree).some(([, end]) => end === Number.MAX_SAFE_INTEGER);
}

// src の [start, end) からコメント区間を除いたテキストを返す。番兵 span が先行しても後続の span で prev が巻き戻らないよう prev 基準で clamp する。
// spans は呼び出し元（commentSpans の文書順走査）により開始オフセット昇順が保証されるため、
// s >= end に達したら以降の span も必ず s >= end であり break で走査を打ち切れる（#414 追加レビュー指摘）
export function stripSpans(src, start, end, spans) {
  let out = '';
  let prev = start;
  for (const [s, e] of spans) {
    if (e <= prev) continue;
    if (s >= end) break;
    out += src.slice(prev, Math.max(s, prev));
    prev = Math.min(e, end);
  }
  return out + src.slice(prev, end);
}

// 見出しが keywords にマッチするセクションの本文ノード列（次の同位以上の見出しまで）を返す。
// depths で採用する見出しレベルを指定する。PR 本文は H2 固定（デフォルト。サブ見出し・
// タイトルを誤採用しない）、plan 本文は見出しレベルが揺れるため [2, 3] を渡す（#409）
export function findSection(tree, keywords, { depths = [2] } = {}) {
  const children = tree.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const h = children[i];
    if (h.type !== 'heading' || !depths.includes(h.depth)) continue;
    // includeHtml: false — GitHub 上で不可視の HTML コメント（`## <!-- 証拠表 -->`）を
    // 見出しテキストに含めない。含めると可視のセクション名が無くてもコメントだけで
    // 必須セクションを満たせてしまう（Codex 指摘）
    const title = toString(h, { includeHtml: false });
    if (!keywords.some((k) => title.includes(k))) continue;
    const nodes = [];
    for (let j = i + 1; j < children.length; j++) {
      const n = children[j];
      if (n.type === 'heading' && n.depth <= h.depth) break;
      nodes.push(n);
    }
    return { found: true, nodes };
  }
  return { found: false, nodes: [] };
}

// セクション内ノードの原文行（コメント除外・ノード間はブロック境界の空行を挟む）。
// 実質判定・チェックリスト走査は行構文が対象のため原文行に対して行う。
// ネストしたインラインコメントも除去する（`- [x] 項目 — <!-- 偽の証拠 -->` の
// コメント内ポインタが証拠として通らないように。旧 stripComments と同じ境界）。
// spans はセクション内の全ノードから事前に一括収集する（ノードごとに個別収集すると、
// あるノードの閉じ忘れコメントの番兵 span が後続の兄弟ノードへ伝播しない。#413 追加レビュー指摘）
export function sectionSourceLines(src, nodes) {
  const spans = [];
  for (const node of nodes) commentSpans(node, spans);
  const lines = [];
  for (const node of nodes) {
    if (isCommentNode(node)) continue;
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start == null || end == null) continue;
    lines.push(...stripSpans(src, start, end, spans).split('\n'), '');
  }
  return lines;
}
