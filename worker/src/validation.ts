// parity: src/lib/security/validateGitHubWritePath.js と対。変更手順は TRUST-BOUNDARY.md「内部シンボルの命名対応表」
//
// client 側 validateGitHubWritePath.js の BIDI_RE / FORBIDDEN_PKG と一致させる
// （parity テスト rootPathValidationParity.test.js が source・集合の一致を機械検査。#469）。
export const BIDI_RE = /[‪-‮⁦-⁩‏]/;
export const FORBIDDEN_PKG = new Set(['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']);

// rootPath 用に拒否する Unicode カテゴリ deny-list（#478。u フラグ）。列挙式からカテゴリベースへ移行し
// homograph/不可視の網羅漏れ（whack-a-mole）を解消:
//  \p{Cc}=制御(C0/C1/DEL)・\p{Cf}=format(ZWSP/ZWNJ/ZWJ/WordJoiner/SHY/BOM/Bidi 等)・\p{Cs}=孤立サロゲート・
//  \p{Co}=私用領域・\p{Zl}/\p{Zp}=行/段落区切り・\p{Default_Ignorable_Code_Point}=VS/U+3164/U+115F 等・
//  末尾の明示コードポイント=\p{Zs} から通常スペース(U+0020)を除いた空白 homograph（NBSP/全角スペース/en-quad 系）。
// ASCII スペース(U+0020)のみ許容（設計判断 #478）。\p{Cs}/u は孤立サロゲートのみ検出し、正当な
// 単一コードポイントの astral（emoji・CJK 拡張B）は許容する。ただし ZWJ/VS/tag で合成した emoji 列
// （family 絵文字・キーキャップ・地域旗等）は連結子 ZWJ(\p{Cf})・VS(\p{Default_Ignorable_Code_Point}) が
// 拒否対象のため列全体が拒否される（連結子自体が spoofing ベクターのため意図的）。
// v フラグ(set 減算)は Safari17+ 必須・browserslist 未設定のため使わず、Zs の許容除外分を明示列挙する
// （\p{Zs} は Unicode で稀にしか増えない安定集合。増加時は \p{Zs} 被覆テストが検出）。
// 残る限界（対象外）: mixed-script homograph（Cyrillic а vs Latin a 等、文字クラスで判別不能）、
// blank レンダリングだがカテゴリ外の記号（U+2800 BRAILLE BLANK 等の \p{So}）、および client/worker が
// 別エンジン（ブラウザ ↔ Cloudflare V8）で動く場合の Unicode 版差による受理集合の理論的乖離。詳細は
// docs/security/TRUST-BOUNDARY.md。
// client 側 validateWorkspaceSettings.js の ROOTPATH_FORBIDDEN_CHAR_RE と source/flags を一致させる（parity テストが機械検査。
// unicodeSafety.js の INVISIBLE_WARN および \p{Zs}（U+0020 除く）の被覆も別途機械検査する）。
export const ROOTPATH_FORBIDDEN_CHAR_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u;

// セグメントごとに小文字化し末尾の `.`/空白を除去する（`package.json.` `PACKAGE.JSON ` 等の
// 正規化）。client 側 validateGitHubWritePath.js の同名処理とロジックを揃える（受理集合 parity の前提）。
function cleanPathSegments(path: string): string[] {
  return path.toLowerCase().split('/').map((seg) => seg.replace(/[. ]+$/, ''));
}

// ワークスペースルートパス用: 機微セグメント（''/.git/.github/.env*）＋パッケージ管理ファイルを
// 全セグメントでブロックする単独の完全判定。client と名前を揃えていない理由:
// TRUST-BOUNDARY.md「意図的に名前を揃えていない箇所」（#475）
function hasForbiddenRootPathSegment(path: string): boolean {
  const cleanSegments = cleanPathSegments(path);
  for (const seg of cleanSegments) {
    if (seg === '' || seg === '.git' || seg === '.github' || seg === '.env' || seg === '.envrc' ||
        seg.startsWith('.env.') || FORBIDDEN_PKG.has(seg)) return true;
  }
  return false;
}

// ファイル書き込みパス用: パッケージ管理ファイルはルート直下のみブロック（client 側 hasForbiddenWriteSegment と対）
function hasForbiddenWriteSegment(path: string): boolean {
  const cleanSegments = cleanPathSegments(path);
  for (const seg of cleanSegments) {
    if (seg === '' || seg === '.git' || seg === '.github' || seg === '.env' || seg === '.envrc' || seg.startsWith('.env.')) return true;
  }
  if (cleanSegments.length === 1 && FORBIDDEN_PKG.has(cleanSegments[0])) return true;
  return false;
}

// WorkSettings.githubRepoPath の検証（ファイルパスより厳格：先頭末尾スラッシュ禁止、URLメタ文字禁止）
export function validateWorkspaceRootPath(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > 256) return 'invalid rootPath';
  if (path.includes('%2F') || path.includes('%2f')) return 'invalid rootPath: encoded slash';
  if (path.includes('?') || path.includes('#')) return 'invalid rootPath: url meta char';
  if (path.startsWith('/') || path.endsWith('/')) return 'invalid rootPath: leading/trailing slash';
  if (path.includes('\x00')) return 'invalid rootPath: null byte';
  if (path.includes('\\')) return 'invalid rootPath: backslash';
  // Bidi は下の ROOTPATH_FORBIDDEN_CHAR_RE（\p{Cf}）にも包含されるが、固有ログ理由のため先に判定
  // （BIDI_RE は validateGitHubWritePath と共有。防御多層）
  if (BIDI_RE.test(path)) return 'invalid rootPath: bidi';
  if (ROOTPATH_FORBIDDEN_CHAR_RE.test(path)) return 'invalid rootPath: control/invisible char';
  for (const seg of path.split('/')) {
    if (seg.length === 0 || seg.length > 255 || seg === '.' || seg === '..') return 'invalid rootPath: segment';
  }
  if (hasForbiddenRootPathSegment(path)) return 'forbidden rootPath: sensitive segment';
  return null;
}

// null = OK。文字列 = エラー理由（Workerログ用、クライアントには返さない）
export function validateGitHubWritePath(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) return 'invalid _path';
  if (path.includes('\x00')) return 'invalid _path: null byte';
  if (path.includes('\\')) return 'invalid _path: backslash';
  if (BIDI_RE.test(path)) return 'invalid _path: bidi';
  for (const seg of path.split('/')) {
    if (seg.length === 0 || seg.length > 255 || seg === '.' || seg === '..') return 'invalid _path: segment';
  }
  if (hasForbiddenWriteSegment(path)) return 'forbidden _path: sensitive segment';
  return null;
}

// Git が禁じる文字（git-check-ref-format 準拠）
// eslint-disable-next-line no-control-regex -- 制御文字の拒否が目的の検証用正規表現
const BRANCH_FORBIDDEN_RE = /[\x00-\x1f\x7f ~^:?*[\]\\]/;

export function validateBranch(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 255) return 'invalid _branch';
  if (v === '@') return 'invalid _branch';
  if (BRANCH_FORBIDDEN_RE.test(v)) return 'invalid _branch';
  if (v.includes('..') || v.includes('//') || v.includes('@{')) return 'invalid _branch';
  if (v.startsWith('/') || v.endsWith('/') || v.endsWith('.')) return 'invalid _branch';
  for (const seg of v.split('/')) {
    if (seg.startsWith('.') || seg.endsWith('.lock')) return 'invalid _branch';
  }
  return null;
}

// GitHub の owner(login) / repo 名検証。authorize 入力のサニタイズ用。
// null = OK / 文字列 = エラー理由（Workerログ用）。
const OWNER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const REPO_RE = /^[a-zA-Z0-9._-]{1,100}$/;

export function validateOwnerRepo(owner: unknown, repo: unknown): string | null {
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) return 'invalid owner';
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return 'invalid repo';
  if (repo === '.' || repo === '..') return 'invalid repo';
  return null;
}

export function validateFileName(v: unknown): boolean {
  if (v === undefined) return true;
  if (typeof v !== 'string') return false;
  if (v.length < 1 || v.length > 256) return false;
  if (v === '.' || v === '..') return false;
  if (v.includes('/') || v.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex -- 制御文字の拒否が目的の検証用正規表現
  if (/[\x00-\x1f\x7f]/.test(v)) return false;
  return true;
}
