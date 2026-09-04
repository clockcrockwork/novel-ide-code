import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateGitHubWritePath } from '../../src/lib/security/validateGitHubWritePath.js';

const ok = (path) =>
  assert.deepEqual(validateGitHubWritePath(path), { ok: true }, `should allow: ${path}`);
const ng = (path) => assert.equal(validateGitHubWritePath(path).ok, false, `should deny: ${path}`);

describe('validateGitHubWritePath — 許可（allowlist相当）', () => {
  it('通常の markdown ファイル', () => ok('works/chapter1.md'));
  it('日本語ディレクトリ', () => ok('原稿/第一章.md'));
  it('深いネスト', () => ok('a/b/c/d/e.txt'));
  it('ルート直下のファイル', () => ok('README.md'));
  it('.gitignore は許可（.github とは別）', () => ok('.gitignore'));
  it('.environment は許可（.env. プレフィックスではない）', () => ok('.environment'));
  it('my-package.json は許可（package.json に似ているが別ファイル）', () => ok('my-package.json'));
  it('サブディレクトリの package.json は許可（ルートのみブロック）', () =>
    ok('packages/mylib/package.json'));
  it('manuscripts/draft.txt', () => ok('manuscripts/draft.txt'));
  it('exports/output.json', () => ok('exports/output.json'));
  it('..bar.md は許可（セグメントが ".." ではないため）', () => ok('..bar.md'));
  it('..bar/baz.md は許可（セグメントが ".." ではないため）', () => ok('..bar/baz.md'));
});

describe('validateGitHubWritePath — パストラバーサル', () => {
  it('../ から始まる', () => ng('../etc/passwd'));
  it('中間に /../ を含む', () => ng('works/../.env'));
  it('末尾に /.. を含む', () => ng('works/..'));
  it('絶対パス（/ 始まり）', () => ng('/etc/passwd'));
  it('先頭 ./', () => {
    // ./ は traversal ではないが、セグメント '.' として拒否される
    ng('./works/file.md');
  });
  it('末尾スペース付き ".." — Windows バイパス対策', () => ng('a/.. /b.md'));
  it('末尾スペース付き "." — Windows バイパス対策', () => ng('a/. /b.md'));
});

describe('validateGitHubWritePath — Null byte', () => {
  it('パス中にNullバイト', () => ng('works/file\x00.md'));
  it('パス末尾にNullバイト', () => ng('works/file.md\x00'));
});

describe('validateGitHubWritePath — バックスラッシュ', () => {
  it('バックスラッシュを含む', () => ng('works\\file.md'));
  it('バックスラッシュ区切りのパス', () => ng('works\\.github\\workflows\\ci.yml'));
});

describe('validateGitHubWritePath — Bidi制御文字', () => {
  it('RLO (U+202E) を含む', () => ng('works/‮file.md'));
  it('LRI (U+2066) を含む', () => ng('works/⁦file.md'));
  it('RLM (U+200F) を含む', () => ng('works/‏file.md'));
  it('LRE (U+202A) を含む', () => ng('works/‪file.md'));
});

describe('validateGitHubWritePath — .git denylist', () => {
  it('.git/config', () => ng('.git/config'));
  it('a/.git/config（サブディレクトリ内）', () => ng('a/.git/config'));
  it('.GIT/CONFIG（大文字）', () => ng('.GIT/CONFIG'));
  it('.git.（末尾ドット）Windows バイパス対策', () => ng('.git./config'));
  it('.git （末尾スペース）Windows バイパス対策', () => ng('.git /config'));
});

describe('validateGitHubWritePath — .github denylist', () => {
  it('.github/workflows/ci.yml', () => ng('.github/workflows/ci.yml'));
  it('.github 単体', () => ng('.github'));
  it('.GitHub/workflows（大文字）', () => ng('.GitHub/workflows/ci.yml'));
  it('.GITHUB/WORKFLOWS（全大文字）', () => ng('.GITHUB/WORKFLOWS/CI.YML'));
});

describe('validateGitHubWritePath — .env denylist', () => {
  it('.env', () => ng('.env'));
  it('.env.production', () => ng('.env.production'));
  it('.env.local', () => ng('.env.local'));
  it('.ENV（大文字）', () => ng('.ENV'));
  it('.Env.Local（混合）', () => ng('.Env.Local'));
});

describe('validateGitHubWritePath — パッケージ管理ファイル denylist', () => {
  it('package.json', () => ng('package.json'));
  it('Package.JSON（大文字）', () => ng('Package.JSON'));
  it('package.json.（末尾ドット）Windows バイパス対策', () => ng('package.json.'));
  it('yarn.lock （末尾スペース）Windows バイパス対策', () => ng('yarn.lock '));
  it('package-lock.json', () => ng('package-lock.json'));
  it('yarn.lock', () => ng('yarn.lock'));
  it('pnpm-lock.yaml', () => ng('pnpm-lock.yaml'));
  it('YARN.LOCK（大文字）', () => ng('YARN.LOCK'));
  it('bun.lockb', () => ng('bun.lockb'));
  it('BUN.LOCKB（大文字）', () => ng('BUN.LOCKB'));
});

describe('validateGitHubWritePath — .envrc denylist', () => {
  it('.envrc', () => ng('.envrc'));
  it('.ENVRC（大文字）', () => ng('.ENVRC'));
  it('.Envrc（混合）', () => ng('.Envrc'));
});

describe('validateGitHubWritePath — 空・長さ・セグメント', () => {
  it('空文字', () => ng(''));
  it('null', () => ng(null));
  it('undefined', () => ng(undefined));
  it('数値', () => ng(42));
  it('1025文字超', () => ng('a'.repeat(1025) + '.md'));
  it('空セグメント（//）', () => ng('works//chapter.md'));
  it('"." セグメント（./works）', () => ng('./works/file.md'));
  it('256文字のセグメント', () => ng('works/' + 'a'.repeat(256) + '.md'));
  it('255文字のセグメントは許可', () => ok('works/' + 'a'.repeat(255)));
});
