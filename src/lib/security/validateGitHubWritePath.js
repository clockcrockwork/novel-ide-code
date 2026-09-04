// parity: worker/src/validation.ts と対。変更手順は TRUST-BOUNDARY.md「内部シンボルの命名対応表」
//
// Bidi制御文字 (RLO, LRO, LRE, RLE, PDF, LRI, RLI, FSI, PDI, RLM)
// worker 側 validation.ts の BIDI_RE と source を一致させる（parity テストが機械検査）。
export const BIDI_RE = /[‪-‮⁦-⁩‏]/;

// どのセグメントにあっても禁止（サブディレクトリ配下も対象）
const FORBIDDEN_ANY_SEGMENT = new Set(['.env', '.envrc']);

// パッケージ管理ファイル名。worker 側 validation.ts の FORBIDDEN_PKG と要素を一致させる
// （parity テストが集合一致を機械検査。片側だけへの追加によるサイレント divergence を防ぐ #469）。
// 書き込みパス用途ではルート直下のみ禁止、rootPath 用途では全セグメント禁止。
export const FORBIDDEN_PKG = new Set([
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
]);

// セグメントごとに小文字化し末尾の `.`/空白を除去する（`package.json.` `PACKAGE.JSON ` 等の
// 正規化）。worker 側 validation.ts の同名処理とロジックを揃える（受理集合 parity の前提）。
function cleanPathSegments(path) {
  return path
    .toLowerCase()
    .split('/')
    .map((seg) => seg.replace(/[. ]+$/, ''));
}

// 書き込みパス用途: パッケージ管理ファイルはルート直下のみ禁止（worker 側 hasForbiddenWriteSegment と対）
function hasForbiddenWriteSegment(path) {
  const cleanSegments = cleanPathSegments(path);
  for (const cleanSeg of cleanSegments) {
    if (cleanSeg === '' || cleanSeg === '.git' || cleanSeg === '.github' || FORBIDDEN_ANY_SEGMENT.has(cleanSeg) || cleanSeg.startsWith('.env.')) return true;
  }
  if (cleanSegments.length === 1 && FORBIDDEN_PKG.has(cleanSegments[0])) return true;
  return false;
}

// rootPath 用途の**追加**判定（pkg 名を全セグメントで禁止）であって単独の完全判定ではない。
// 呼び出し元 validateWorkspaceSettings.js で validateGitHubWritePath() と合成される（#469）。
// worker と名前を揃えていない理由: TRUST-BOUNDARY.md「意図的に名前を揃えていない箇所」（#475）
export function hasForbiddenPkgSegment(path) {
  if (typeof path !== 'string') return false;
  return cleanPathSegments(path).some((seg) => FORBIDDEN_PKG.has(seg));
}

export function validateGitHubWritePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, reason: 'パスが空です' };
  }
  if (path.length > 1024) {
    return { ok: false, reason: 'パスが長すぎます（上限: 1024文字）' };
  }

  if (path.includes('\x00')) {
    return { ok: false, reason: 'パスにNullバイトが含まれています' };
  }

  if (path.includes('\\')) {
    return { ok: false, reason: 'パスにバックスラッシュが含まれています' };
  }

  if (BIDI_RE.test(path)) {
    return { ok: false, reason: 'パスにBidi制御文字が含まれています' };
  }

  const segments = path.split('/');
  for (const seg of segments) {
    if (seg.length === 0) {
      return { ok: false, reason: '空のパスセグメントが含まれています' };
    }
    if (seg.length > 255) {
      return { ok: false, reason: `パスセグメントが長すぎます: "${seg.slice(0, 20)}..."` };
    }
    if (seg === '.' || seg === '..') {
      return { ok: false, reason: '"." ".." はパスセグメントとして使用できません' };
    }
  }

  if (hasForbiddenWriteSegment(path)) {
    return { ok: false, reason: `このパスへの書き込みは禁止されています: ${path}` };
  }

  return { ok: true };
}
