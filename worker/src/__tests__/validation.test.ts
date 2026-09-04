import { describe, expect, it } from 'vitest';
import {
  validateBranch,
  validateFileName,
  validateGitHubWritePath,
  validateOwnerRepo,
  validateWorkspaceRootPath,
} from '../validation';

// #151: GitHub 連携の境界検証。proxy 統合テスト (github-proxy.test.ts) を補完し、
// 純粋関数として境界違反を直接検証する。

describe('validateGitHubWritePath', () => {
  it('通常の本文パスは null（OK）', () => {
    expect(validateGitHubWritePath('works/chapter1.md')).toBeNull();
  });

  it('パストラバーサル (..) を拒否', () => {
    expect(validateGitHubWritePath('works/../secret.md')).not.toBeNull();
    expect(validateGitHubWritePath('a/.. /b.md')).not.toBeNull();
    expect(validateGitHubWritePath('a/. /b.md')).not.toBeNull();
  });

  it('.github 配下を拒否', () => {
    expect(validateGitHubWritePath('.github/workflows/ci.yml')).not.toBeNull();
  });

  it('.git セグメントを拒否する', () => {
    expect(validateGitHubWritePath('.git/config')).not.toBeNull();
    expect(validateGitHubWritePath('a/.git/config')).not.toBeNull();
    expect(validateGitHubWritePath('.git./config')).not.toBeNull();
    expect(validateGitHubWritePath('.git /config')).not.toBeNull();
  });

  it('.env を拒否', () => {
    expect(validateGitHubWritePath('.env')).not.toBeNull();
    expect(validateGitHubWritePath('config/.env.local')).not.toBeNull();
  });

  it('ルート直下の package.json を拒否、サブディレクトリ配下は許可', () => {
    expect(validateGitHubWritePath('package.json')).not.toBeNull();
    expect(validateGitHubWritePath('docs/package.json')).toBeNull();
    expect(validateGitHubWritePath('package.json.')).not.toBeNull();
    expect(validateGitHubWritePath('yarn.lock ')).not.toBeNull();
  });

  it('null byte / backslash / 空セグメントを拒否', () => {
    expect(validateGitHubWritePath('a\x00b.md')).not.toBeNull();
    expect(validateGitHubWritePath('a\\b.md')).not.toBeNull();
    expect(validateGitHubWritePath('a//b.md')).not.toBeNull();
  });

  it('非文字列・空文字・長すぎるパスを拒否', () => {
    expect(validateGitHubWritePath(undefined)).not.toBeNull();
    expect(validateGitHubWritePath('')).not.toBeNull();
    expect(validateGitHubWritePath(123)).not.toBeNull();
    expect(validateGitHubWritePath('a'.repeat(1025))).not.toBeNull();
  });
});

describe('validateBranch', () => {
  it('通常のブランチ名は null（OK）', () => {
    expect(validateBranch('main')).toBeNull();
    expect(validateBranch('feature/add-x')).toBeNull();
  });

  it('traversal/参照記法 (.. / @{) を拒否', () => {
    expect(validateBranch('a..b')).not.toBeNull();
    expect(validateBranch('a@{0}')).not.toBeNull();
  });

  it('制御文字・空白・禁止記号を拒否', () => {
    expect(validateBranch('a b')).not.toBeNull();
    expect(validateBranch('a~b')).not.toBeNull();
    expect(validateBranch('a:b')).not.toBeNull();
  });

  it('先頭末尾スラッシュ・ドット終わりを拒否', () => {
    expect(validateBranch('/main')).not.toBeNull();
    expect(validateBranch('main/')).not.toBeNull();
    expect(validateBranch('main.')).not.toBeNull();
  });

  it('非文字列・空文字・長すぎるブランチ名を拒否', () => {
    expect(validateBranch('')).not.toBeNull();
    expect(validateBranch(undefined)).not.toBeNull();
    expect(validateBranch(123)).not.toBeNull();
    expect(validateBranch('a'.repeat(256))).not.toBeNull();
  });
});

describe('validateWorkspaceRootPath', () => {
  it('通常の相対パスは null（OK）', () => {
    expect(validateWorkspaceRootPath('novels')).toBeNull();
    expect(validateWorkspaceRootPath('works/series-a')).toBeNull();
  });

  it('先頭末尾スラッシュを拒否', () => {
    expect(validateWorkspaceRootPath('/novels')).not.toBeNull();
    expect(validateWorkspaceRootPath('novels/')).not.toBeNull();
  });

  it('URL メタ文字・エンコードスラッシュを拒否', () => {
    expect(validateWorkspaceRootPath('a?b')).not.toBeNull();
    expect(validateWorkspaceRootPath('a#b')).not.toBeNull();
    expect(validateWorkspaceRootPath('a%2Fb')).not.toBeNull();
  });

  it('traversal・機微セグメントを拒否', () => {
    expect(validateWorkspaceRootPath('a/../b')).not.toBeNull();
    expect(validateWorkspaceRootPath('.github')).not.toBeNull();
    expect(validateWorkspaceRootPath('a/package.json')).not.toBeNull();
  });

  it('非文字列・空文字・長すぎるパスを拒否', () => {
    expect(validateWorkspaceRootPath(undefined)).not.toBeNull();
    expect(validateWorkspaceRootPath('')).not.toBeNull();
    expect(validateWorkspaceRootPath(123)).not.toBeNull();
    expect(validateWorkspaceRootPath('a'.repeat(257))).not.toBeNull();
  });

  it('制御・不可視文字を拒否（#473）', () => {
    expect(validateWorkspaceRootPath('a\tb')).not.toBeNull(); // タブ
    expect(validateWorkspaceRootPath('a\nb')).not.toBeNull(); // 改行
    expect(validateWorkspaceRootPath('a\rb')).not.toBeNull(); // CR
    expect(validateWorkspaceRootPath('a\x1fb')).not.toBeNull(); // C0 制御
    expect(validateWorkspaceRootPath('a\x85b')).not.toBeNull(); // C1 制御 (NEL)
    expect(validateWorkspaceRootPath('a\u200bb')).not.toBeNull(); // ZWSP
    expect(validateWorkspaceRootPath('a\u00a0b')).not.toBeNull(); // NBSP
    expect(validateWorkspaceRootPath('a\ufeffb')).not.toBeNull(); // BOM
    expect(validateWorkspaceRootPath('a\u2028b')).not.toBeNull(); // Line Separator
    expect(validateWorkspaceRootPath('a\u2029b')).not.toBeNull(); // Paragraph Separator
  });

  it('homograph\u30fb\u7a7a\u767d homograph\u30fbVS\u30fb\u5b64\u7acb\u30b5\u30ed\u30b2\u30fc\u30c8\u3092\u62d2\u5426\u3057 ASCII \u30b9\u30da\u30fc\u30b9\u306f\u8a31\u5bb9\uff08#478\uff09', () => {
    expect(validateWorkspaceRootPath('a\u3164b')).not.toBeNull(); // Hangul Filler
    expect(validateWorkspaceRootPath('a\u115fb')).not.toBeNull(); // Choseong Filler
    expect(validateWorkspaceRootPath('a\u3000b')).not.toBeNull(); // \u5168\u89d2\u30b9\u30da\u30fc\u30b9
    expect(validateWorkspaceRootPath('a\u2000b')).not.toBeNull(); // EN QUAD
    expect(validateWorkspaceRootPath('a\u202fb')).not.toBeNull(); // Narrow NBSP
    expect(validateWorkspaceRootPath('a\ufe0fb')).not.toBeNull(); // VS-16
    expect(validateWorkspaceRootPath('a\ud800b')).not.toBeNull(); // \u5b64\u7acb\u30b5\u30ed\u30b2\u30fc\u30c8
    expect(validateWorkspaceRootPath('a\ue000b')).not.toBeNull(); // PUA (\p{Co})
    expect(validateWorkspaceRootPath('\u{1f468}\u200d\u{1f469}\u200d\u{1f467}')).not.toBeNull(); // family \u7d75\u6587\u5b57\uff08ZWJ \u5408\u6210\uff09
    expect(validateWorkspaceRootPath('1\ufe0f\u20e3')).not.toBeNull(); // \u30ad\u30fc\u30ad\u30e3\u30c3\u30d7\uff08VS \u5408\u6210\uff09
    // \u8a31\u5bb9: ASCII \u30b9\u30da\u30fc\u30b9\u30fb\u30cf\u30f3\u30b0\u30eb\u97f3\u7bc0\u30fb\u5358\u4e00 emoji\u30fbCJK \u62e1\u5f35B\uff08astral\uff09\u30fb\u7d50\u5408\u30de\u30fc\u30af \p{M}
    expect(validateWorkspaceRootPath('cafe\u0301')).toBeNull(); // NFD caf\u00e9\uff08\p{M} \u306f\u8a31\u5bb9\uff09
    expect(validateWorkspaceRootPath('my novel')).toBeNull();
    expect(validateWorkspaceRootPath('\ud55c\uae00')).toBeNull(); // \ud55c\uae00
    expect(validateWorkspaceRootPath('\u{1f4c1}/x')).toBeNull(); // \ud83d\udcc1
    expect(validateWorkspaceRootPath('\u{20000}')).toBeNull(); // CJK-ExtB
  });
});

describe('validateOwnerRepo', () => {
  it('通常の owner/repo は null（OK）', () => {
    expect(validateOwnerRepo('owner', 'repo')).toBeNull();
    expect(validateOwnerRepo('a', 'b')).toBeNull();
    expect(validateOwnerRepo('testuser', '.novel-ide')).toBeNull();
    expect(validateOwnerRepo('my-org', 'my-repo')).toBeNull();
  });

  it('トレイリングハイフンの owner を拒否', () => {
    expect(validateOwnerRepo('foo-', 'repo')).not.toBeNull();
    expect(validateOwnerRepo('-foo', 'repo')).not.toBeNull();
  });

  it('"." と ".." の repo を拒否', () => {
    expect(validateOwnerRepo('owner', '.')).not.toBeNull();
    expect(validateOwnerRepo('owner', '..')).not.toBeNull();
  });

  it('パストラバーサル・空文字・非文字列を拒否', () => {
    expect(validateOwnerRepo('../evil', 'r')).not.toBeNull();
    expect(validateOwnerRepo('o', '')).not.toBeNull();
    expect(validateOwnerRepo('', 'r')).not.toBeNull();
    expect(validateOwnerRepo(123, 'r')).not.toBeNull();
    expect(validateOwnerRepo('o', null)).not.toBeNull();
  });
});

describe('validateFileName', () => {
  it('undefined は true（未指定許容）、通常名も true', () => {
    expect(validateFileName(undefined)).toBe(true);
    expect(validateFileName('chapter1.md')).toBe(true);
  });

  it('スラッシュ・"."/".."・制御文字を拒否', () => {
    expect(validateFileName('a/b')).toBe(false);
    expect(validateFileName('..')).toBe(false);
    expect(validateFileName('a\x00b')).toBe(false);
  });

  it('非文字列・空文字・長すぎるファイル名を拒否', () => {
    expect(validateFileName('')).toBe(false);
    expect(validateFileName(123)).toBe(false);
    expect(validateFileName('a'.repeat(257))).toBe(false);
  });
});
