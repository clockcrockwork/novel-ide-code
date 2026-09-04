import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

import {
  classify,
  expandRenames,
  isKnownDepManifestPath,
} from '../scripts/agent/classify-changes.js';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../scripts/agent/classify-changes.js',
);

test('classify-changes CLI: CHANGED_FILES 未設定は fail-loud（exit 1・エラーメッセージ）（#406 Gemini 指摘）', () => {
  const { status, stderr, stdout } = spawnSync('node', [SCRIPT], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH },
  });
  assert.equal(status, 1);
  assert.match(stderr, /CHANGED_FILES/);
  assert.equal(stdout, '');
});

test('classify-changes CLI: CHANGED_FILES が空文字列（変更ファイルなし）は fail-closed で全 true を返す（#446）', () => {
  const { status, stdout, stderr } = spawnSync('node', [SCRIPT], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, CHANGED_FILES: '' },
  });
  assert.equal(status, 0);
  assert.equal(stdout, 'code=true\ndeps=true\ndocs=true\nbundle=true\n');
  assert.match(stderr, /CHANGED_FILES/);
});

test('classify-changes CLI: CHANGED_FILES にコード変更ファイルがあれば code=true', () => {
  const { status, stdout } = spawnSync('node', [SCRIPT], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, CHANGED_FILES: 'src/a.js' },
  });
  assert.equal(status, 0);
  assert.equal(stdout, 'code=true\ndeps=false\ndocs=false\nbundle=false\n');
});

test('classify-changes CLI: docs/.md 変更で docs=true', () => {
  const { status, stdout } = spawnSync('node', [SCRIPT], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, CHANGED_FILES: 'docs/foo.md' },
  });
  assert.equal(status, 0);
  assert.equal(stdout, 'code=false\ndeps=false\ndocs=true\nbundle=false\n');
});

test('classify: designDocsChanged — 設計文書パスの正例（各パターン代表）（#452）', () => {
  const positives = [
    'docs/agent-workflows/review-angles/README.md',
    'docs/planning/agent-memory-design.md',
    'docs/data-model/file-metadata.md',
    'docs/security/TRUST-BOUNDARY.md',
    'docs/ai/rules/verification-gates.md',
    'docs/maintenance/code-cleanup.md',
    'agent-manifest.json',
    '.claude/agents/review-spec.md',
    '.claude/commands/pick-issue.md',
    '.claude/skills/modern-web-guidance/SKILL.md',
    '.agents/skills/modern-web-guidance/SKILL.md',
    'CLAUDE.md',
    'AGENTS.md',
    'GEMINI.md',
    '.claude/settings.json',
    '.github/pull_request_template.md',
    '.github/copilot-instructions.md',
  ];
  for (const f of positives) {
    assert.equal(classify([f]).designDocsChanged, true, `設計文書と判定されるべき: ${f}`);
  }
});

test('classify: designDocsChanged — 説明・記録文書・コードは負例（#452）', () => {
  const negatives = [
    'docs/pr/PR-451.md',
    'docs/pr-analysis/review-angles-bench-round1.md',
    'README.md',
    'docs/ARCHITECTURE.md',
    'src/lib/db.js',
    'sub/CLAUDE.md',
  ];
  for (const f of negatives) {
    assert.equal(classify([f]).designDocsChanged, false, `設計文書と判定されるべきでない: ${f}`);
  }
});

test('classify-changes CLI: designDocs は CLI 出力に含めない（ci.yml の既存キー互換）（#452）', () => {
  const { status, stdout } = spawnSync('node', [SCRIPT], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, CHANGED_FILES: 'docs/agent-workflows/foo.md' },
  });
  assert.equal(status, 0);
  assert.equal(stdout, 'code=false\ndeps=false\ndocs=true\nbundle=false\n');
});

test('classify: bundleSourceChanged — bundle 再ビルドに影響するパスの正例（#551）', () => {
  const positives = [
    '.github/actions/artifacts-gate/src/index.js',
    '.github/actions/artifacts-gate/dist/index.js',
    'scripts/agent/check-artifacts.js',
    'scripts/agent/mdast-body.js',
    'scripts/agent/classify-changes.js',
    'scripts/agent/review-angle-tokens.js',
    'package.json',
    'package-lock.json',
    '.github/workflows/ci.yml',
  ];
  for (const path of positives) {
    assert.equal(classify([path]).bundleSourceChanged, true, path);
  }
});

test('classify: bundleSourceChanged — 無関係な変更では false（#551）', () => {
  const negatives = ['src/App.jsx', 'docs/foo.md', 'worker/package.json', 'scripts/agent/hooks/check-plan-gates.js'];
  for (const path of negatives) {
    assert.equal(classify([path]).bundleSourceChanged, false, path);
  }
});

test('classify-changes CLI: bundle source 変更で bundle=true（#551）', () => {
  const { status, stdout } = spawnSync('node', [SCRIPT], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, CHANGED_FILES: 'scripts/agent/mdast-body.js' },
  });
  assert.equal(status, 0);
  assert.equal(stdout, 'code=true\ndeps=false\ndocs=false\nbundle=true\n');
});

// --- #446: prose ディレクトリ配下のコード密輸対策（allowlist 方式への反転。観点別レビュー反映） ---

test('classify: prose ディレクトリ配下でも不活性拡張子以外は codeChanged=true（コード密輸対策 #446）', () => {
  const positives = [
    'docs/evil.js',
    'docs/EVIL.JS',
    'docs/x.test.js',
    'docs/x.d.ts',
    'docs/run',
    'docs/evil.bash',
    'docs/Makefile',
    'docs/x.html',
    'docs/x.svg', // script を含みうる能動形式のため allowlist から除外（#446 round2）
    '.claude/skills/x/run',
    '.agents/x.ts',
    '.claude/settings.json',
    '.claude/skills/x/hooks.json', // .claude/ 配下の機械可読設定は settings.json 以外も code（#446 round3）
  ];
  for (const f of positives) {
    const result = classify([f]);
    assert.equal(result.codeChanged, true, `code 扱いになるべき: ${f}`);
    assert.ok(result.codeFiles.includes(f), `codeFiles に含まれるべき: ${f}`);
  }
});

test('classify: prose ディレクトリ配下の不活性拡張子は codeChanged=false のまま（#446）', () => {
  const negatives = [
    'docs/x.md',
    'docs/x.json',
    'docs/x.yml', // yaml が prose のままである回帰確認（#446 round2/round3）
    '.gemini/config.yaml', // TRUST-BOUNDARY の実行境界に無い外部サービス設定のため CODE_FORCE
    // 対象から外した（#446 round3。round1 の結論に戻す）
    'docs/x.png',
    'docs/設計.md',
    'docs/.gitkeep',
    '.claude/agents/x.md',
    'LICENSE',
    '.gitignore',
  ];
  for (const f of negatives) {
    assert.equal(classify([f]).codeChanged, false, `prose のまま扱われるべき: ${f}`);
  }
});

test('classify: LICENSE / .gitignore はルート限定（ネストした同名ファイルは code。#446 round3）', () => {
  // round2 で (^|/) 一般化していたが round3 で撤回した — docs/LICENSE 等は「たまたま LICENSE
  // という名前の docs content」であり、拡張子なしのため code 密輸経路になりうる
  assert.equal(classify(['docs/LICENSE']).codeChanged, true);
  assert.equal(classify(['docs/.gitignore']).codeChanged, true);
});

test('classify: docs/evil.js は docsChanged=true のまま（docs-links 起動判定は広いまま。#446）', () => {
  const result = classify(['docs/evil.js']);
  assert.equal(result.docsChanged, true);
  assert.equal(result.codeChanged, true);
});

test('classify: .github/workflows/*.yml は元から prose 対象外（変更なし。#446）', () => {
  const result = classify(['.github/workflows/ci.yml']);
  assert.equal(result.codeChanged, true);
});

test('classify-changes CLI: docs/evil.js（コード密輸）は code=true（#446）', () => {
  const { status, stdout } = spawnSync('node', [SCRIPT], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, CHANGED_FILES: 'docs/evil.js' },
  });
  assert.equal(status, 0);
  assert.equal(stdout, 'code=true\ndeps=false\ndocs=true\nbundle=false\n');
});

test('classify-changes CLI: code=true のとき stderr に code と判定したファイルを全件列挙する（#446 round2/round3: 省略ロジックは撤回）', () => {
  const { status, stderr } = spawnSync('node', [SCRIPT], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, CHANGED_FILES: 'src/a.js\ndocs/x.md' },
  });
  assert.equal(status, 0);
  assert.match(stderr, /code と判定したファイル/);
  assert.match(stderr, /src\/a\.js/);
  assert.doesNotMatch(stderr, /docs\/x\.md/);
});

test('classify-changes CLI: 入力分割は改行のみ（空白は区切り文字ではない）。空白入りファイル名を誤分割しない（#446 round3 敵対的）', () => {
  // 旧実装（/\s+/ も区切りに含む）だと 'docs/two words.png' が
  // ['docs/two', 'words.png'] に割れ、拡張子なしの 'docs/two' が code 誤判定される
  const { status, stdout } = spawnSync('node', [SCRIPT], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, CHANGED_FILES: 'docs/two words.png' },
  });
  assert.equal(status, 0);
  assert.equal(stdout, 'code=false\ndeps=false\ndocs=true\nbundle=false\n');
});

test('classify-changes CLI: 空白を含む1ファイルが LICENSE 等の inert basename と偶然前方一致しても code のまま（#446 round3 敵対的）', () => {
  // 'docs/x.md LICENSE' は改行を挟まない1行＝1ファイル名として扱われる。旧実装（空白分割）
  // だと ['docs/x.md', 'LICENSE'] に割れ両方 prose になってしまうが、改行のみ分割では
  // 1つの奇妙なファイル名として残り、どの allowlist パターンにも一致しないため code になる
  const { status, stdout } = spawnSync('node', [SCRIPT], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, CHANGED_FILES: 'docs/x.md LICENSE' },
  });
  assert.equal(status, 0);
  assert.equal(stdout, 'code=true\ndeps=false\ndocs=true\nbundle=false\n');
});

test('expandRenames: oldPath があれば path と両方、無ければ path のみを返す（#446 round4 減算#4）', () => {
  assert.deepEqual(
    expandRenames([
      { path: 'docs/x.md', oldPath: 'src/x.js' },
      { path: 'docs/y.md' },
    ]),
    ['docs/x.md', 'src/x.js', 'docs/y.md'],
  );
  assert.deepEqual(expandRenames([]), []);
});

test('classify: CODE_FORCE_PATTERNS は大文字小文字を区別しない（.claude/settings.JSON 等。#446 round4 敵対的 F-r4-2）', () => {
  assert.equal(classify(['.claude/settings.JSON']).codeChanged, true);
  assert.equal(classify(['.claude/skills/x/hooks.YAML']).codeChanged, true);
});

test('classify: DESIGN_DOC_PATTERNS / RECORD_DOC_PATTERNS は大文字小文字を区別しない（加算方向のみ。#446 round7 観点別レビュー 敵対的N1）', () => {
  assert.equal(classify(['.claude/settings.JSON']).designDocsChanged, true);
  assert.equal(classify(['.CLAUDE/agents/x.md']).designDocsChanged, true);
  assert.equal(classify(['Claude.md']).designDocsChanged, true);
  assert.equal(classify(['DOCS/AGENT-MEMORY/records/a.json']).recordDocsChanged, true);
});

test('isKnownDepManifestPath: リポジトリルート・worker/ 直下の package.json / package-lock.json のみ true（#446 round8 敵対的N4）', () => {
  assert.equal(isKnownDepManifestPath('package.json'), true);
  assert.equal(isKnownDepManifestPath('package-lock.json'), true);
  assert.equal(isKnownDepManifestPath('worker/package.json'), true);
  assert.equal(isKnownDepManifestPath('worker/package-lock.json'), true);
  assert.equal(isKnownDepManifestPath('.github/actions/artifacts-gate/dist/package.json'), false);
  assert.equal(isKnownDepManifestPath('apps/foo/package-lock.json'), false);
  assert.equal(isKnownDepManifestPath('worker/apps/package.json'), false);
});

test('classify: depOnly は既知 npm プロジェクト外の package.json を「純粋な依存のみ」とみなさない（#446 round8 敵対的N4/N2r）', () => {
  assert.equal(
    classify(['.github/actions/artifacts-gate/dist/package.json', 'package-lock.json']).depOnly,
    false,
  );
  assert.equal(
    classify(['worker/package.json', 'worker/package-lock.json']).depOnly,
    true,
    'Dependabot の worker/ プロジェクトの週次バンプは depOnly のまま（回帰防止）',
  );
});

test('classify: hasLockfileChange は既知 npm プロジェクト直下の lockfile に限定する。任意階層の lockfile では depOnly が立たない（#446 round9）', () => {
  const result = classify(['package.json', 'docs/legacy/package-lock.json']);
  assert.equal(result.depOnly, false);
});
