export const NAME_TAG_PRESETS = [
  { id: 'hashtag', label: '##NAME##', tag: '##NAME##' },
  { id: 'hashtag2', label: '#NAME_1#', tag: '#NAME_1#' },
  { id: 'paren', label: '(名前)', tag: '(名前)' },
  { id: 'bracket', label: '[NAME]', tag: '[NAME]' },
  { id: 'brace', label: '{名前}（ルビ記法と競合注意）', tag: '{名前}' },
];

export const RUBY_PRESETS = {
  none: { label: 'なし（変換しない）', template: null },
  kakuyomu: { label: 'カクヨム / なろう / ハーメルン', template: '｜{base}《{reading}》' },
  pixiv: { label: 'pixiv', template: '[[rb:{base} > {reading}]]' },
  novelup: { label: 'ノベルアップ+', template: '{base}《{reading}》' },
  custom: { label: 'カスタム', template: null },
};

// コメント除去は markdown.js のプレビュー前処理でも共用する
// CRLF/CR を先に LF に正規化する（Windows 環境での執筆・インポートを考慮）
export function stripComments(text) {
  return (text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

const BASE_PATTERNS = [
  [/%%[\s\S]*?%%/g, ''], // %% アノテーション %%
  [/^#{1,6}\s*/gm, ''], // 見出し記号
  [/\*\*([\s\S]*?)\*\*/g, '$1'], // ボールド **text**（*を含む場合も対応）
  [/\n{3,}/g, '\n\n'], // 連続空行を最大2行に
];

function applyBase(text) {
  let result = stripComments(text);
  for (const [p, r] of BASE_PATTERNS) result = result.replace(p, r);
  return result;
}

// .txt エクスポート用: ルビ → 漢字（かんじ）形式
export function toPlainText(content) {
  if (!content) return '';
  return applyBase(content)
    .replace(/\{([^|{}]*)\|([^{}]*)\}/g, '$1（$2）')
    .trim();
}

// サイト別出力用: applyBase + サイト別ルビ変換
export function toSiteText(content, rubyFormat, customRuby) {
  if (!content) return '';
  const base = applyBase(content);
  const template =
    rubyFormat === 'custom' ? customRuby || null : (RUBY_PRESETS[rubyFormat]?.template ?? null);
  if (!template) return base.trim();
  return base
    .replace(/\{([^|{}]*)\|([^{}]*)\}/g, (_, b, r) =>
      template.replace(/{base}|{reading}/g, (m) => (m === '{base}' ? b : r)),
    )
    .trim();
}

// 文字数カウント用: ルビ → 本文のみ（読み仮名を除外）
export function toWordCountText(content) {
  if (!content) return '';
  return applyBase(content)
    .replace(/\{([^|{}]*)\|[^{}]*\}/g, '$1')
    .trim();
}

// 投稿サイト向け文字数カウント用: ルビ記法・名前タグ等を文字数に含める
export function toSiteWordCountText(content) {
  if (!content) return '';
  return applyBase(content).trim();
}
