import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { buildPublicTree } from '../../scripts/gh/build-public-tree.js';

// NUL 区切りの ls-tree 出力を組み立てる。各エントリ: `<mode> blob <sha>\t<path>`
function tree(entries) {
  return entries.map(([mode, sha, path]) => `${mode} ${sha === null ? 'commit' : 'blob'} ${sha}\t${path}`).join('\0');
}

// 差し替え可能な git ランナー。source の toplevel と各コマンド出力を制御する
function mockGit({ toplevel, porcelain = '', heads = ['h1', 'h1'], treeStr, blobs = {} }) {
  let headIdx = 0;
  return (args, opts = {}) => {
    const key = args.join(' ');
    if (key === 'rev-parse --show-toplevel') return `${toplevel}\n`;
    if (key === 'status --porcelain') return porcelain;
    if (key === 'rev-parse HEAD') return `${heads[Math.min(headIdx++, heads.length - 1)]}\n`;
    if (args[0] === 'ls-tree') return treeStr;
    if (args[0] === 'cat-file') {
      const sha = args[2];
      return opts.buffer ? Buffer.from(blobs[sha] ?? '') : (blobs[sha] ?? '');
    }
    throw new Error(`unexpected git: ${key}`);
  };
}

function tmpDirs() {
  const src = mkdtempSync(join(tmpdir(), 'src-'));
  const outParent = mkdtempSync(join(tmpdir(), 'out-'));
  const out = join(outParent, 'public');
  return { src, out, cleanup: () => { rmSync(src, { recursive: true, force: true }); rmSync(outParent, { recursive: true, force: true }); } };
}

test('happy path: 通常ファイルを含め control-only を除外、mode を保持する', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({
      toplevel: resolve(src),
      treeStr: tree([
        ['100644', 'a1', 'src/index.js'],
        ['100755', 'a2', 'scripts/run.sh'],
        ['100644', 'a3', 'docs/planning/secret-plan.md'],
        ['100644', 'a4', '.env.example'],
      ]),
      blobs: { a1: 'code', a2: '#!/bin/sh', a3: 'plan', a4: 'KEY=' },
    });
    const r = buildPublicTree({ sourceRepo: src, outDir: out, runGit });
    assert.equal(r.includedCount, 3);
    assert.equal(r.excludedCount, 1);
    assert.deepEqual(r.excluded, ['docs/planning/secret-plan.md']);
    assert.equal(readFileSync(join(out, 'src/index.js'), 'utf-8'), 'code');
    assert.equal(readFileSync(join(out, '.env.example'), 'utf-8'), 'KEY=');
    assert.equal(existsSync(join(out, 'docs/planning/secret-plan.md')), false);
    assert.ok(statSync(join(out, 'scripts/run.sh')).mode & 0o100, 'executable bit を保持');
  } finally {
    cleanup();
  }
});

test('secret 風 tracked ファイルは除外でなく fail（出力を残さない。#345 指摘3）', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({
      toplevel: resolve(src),
      treeStr: tree([['100644', 'a1', 'src/index.js'], ['100644', 'b1', '.env.production']]),
      blobs: { a1: 'code', b1: 'SECRET=xxx' },
    });
    assert.throws(() => buildPublicTree({ sourceRepo: src, outDir: out, runGit }), /secret 風/);
    assert.equal(existsSync(out), false, '失敗時に不完全な出力を残さない');
  } finally {
    cleanup();
  }
});

test('symlink（mode 120000）は fail 一択', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({
      toplevel: resolve(src),
      treeStr: tree([['100644', 'a1', 'src/index.js'], ['120000', 'l1', 'link']]),
      blobs: { a1: 'code' },
    });
    assert.throws(() => buildPublicTree({ sourceRepo: src, outDir: out, runGit }), /symlink/);
  } finally {
    cleanup();
  }
});

test('submodule（mode 160000 / type commit）は fail 一択', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({
      toplevel: resolve(src),
      treeStr: tree([['100644', 'a1', 'src/index.js'], ['160000', null, 'vendor/sub']]),
      blobs: { a1: 'code' },
    });
    assert.throws(() => buildPublicTree({ sourceRepo: src, outDir: out, runGit }), /submodule/);
  } finally {
    cleanup();
  }
});

test('fail-closed: ls-tree が空（0件）なら出力せず throw', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({ toplevel: resolve(src), treeStr: '' });
    assert.throws(() => buildPublicTree({ sourceRepo: src, outDir: out, runGit }), /tracked ファイルがありません/);
    assert.equal(existsSync(out), false);
  } finally {
    cleanup();
  }
});

test('fail-closed: git 実行が例外を投げたら伝播し出力を残さない', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = (args) => {
      if (args[0] === 'ls-tree') throw new Error('git ls-tree failed');
      return mockGit({ toplevel: resolve(src) })(args);
    };
    assert.throws(() => buildPublicTree({ sourceRepo: src, outDir: out, runGit }), /git ls-tree failed/);
    assert.equal(existsSync(out), false);
  } finally {
    cleanup();
  }
});

test('dirty worktree は fail', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({ toplevel: resolve(src), porcelain: ' M src/index.js\n', treeStr: tree([['100644', 'a1', 'x.js']]), blobs: { a1: 'x' } });
    assert.throws(() => buildPublicTree({ sourceRepo: src, outDir: out, runGit }), /未コミットの変更/);
  } finally {
    cleanup();
  }
});

test('生成中に HEAD が変化したら fail', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({
      toplevel: resolve(src),
      heads: ['h1', 'h2'],
      treeStr: tree([['100644', 'a1', 'src/index.js']]),
      blobs: { a1: 'code' },
    });
    assert.throws(() => buildPublicTree({ sourceRepo: src, outDir: out, runGit }), /HEAD が変化/);
    assert.equal(existsSync(out), false);
  } finally {
    cleanup();
  }
});

test('出力先が source repo 配下なら拒否（source 汚染防止）', () => {
  const { src, cleanup } = tmpDirs();
  try {
    const inside = join(src, 'public-out');
    const runGit = mockGit({ toplevel: resolve(src), treeStr: tree([['100644', 'a1', 'x.js']]), blobs: { a1: 'x' } });
    assert.throws(() => buildPublicTree({ sourceRepo: src, outDir: inside, runGit }), /source repo の外/);
  } finally {
    cleanup();
  }
});

test('出力先が非空なら拒否（stale file 混入防止）', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'stale.txt'), 'old');
    const runGit = mockGit({ toplevel: resolve(src), treeStr: tree([['100644', 'a1', 'x.js']]), blobs: { a1: 'x' } });
    assert.throws(() => buildPublicTree({ sourceRepo: src, outDir: out, runGit }), /存在しないか空/);
  } finally {
    cleanup();
  }
});

test('空白を含む ASCII パスも NUL 区切りで正しく扱う（#345 C3）', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({
      toplevel: resolve(src),
      treeStr: tree([['100644', 'a1', 'docs/memo list (1).md']]),
      blobs: { a1: 'text' },
    });
    const r = buildPublicTree({ sourceRepo: src, outDir: out, runGit });
    assert.equal(r.includedCount, 1);
    assert.equal(readFileSync(join(out, 'docs/memo list (1).md'), 'utf-8'), 'text');
  } finally {
    cleanup();
  }
});

// ラウンド4敵対的2で hasPathSeparatorLookalike が「非 ASCII を一括拒否」に一般化されたため、
// 日本語パスは NUL 区切りで正しく1エントリとして解析された**うえで** invalid-path として
// fail-closed になる（旧テストは「正しく解析されて include される」だったが、パス自体の denylist
// 判定が変わったため期待値を更新。パースの正しさは throw されたエラーメッセージにフルパスが
// 欠落なく現れることで確認する）。
test('日本語（非 ASCII）を含むパスは NUL 区切りで正しく1エントリに解析されるが invalid-path で fail-closed（#345 C3・ラウンド4敵対的2）', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({
      toplevel: resolve(src),
      treeStr: tree([['100644', 'a1', 'docs/メモ 一覧.md']]),
      blobs: { a1: 'テスト' },
    });
    assert.throws(
      () => buildPublicTree({ sourceRepo: src, outDir: out, runGit }),
      /パスに.*非 ASCII.*fail-closed.*docs\/メモ 一覧\.md/s,
    );
    assert.equal(existsSync(out), false, 'fail 時は出力を残さない');
  } finally {
    cleanup();
  }
});

// 改行等の制御文字も同じ一般化で invalid-path になる（旧テストは NUL 区切りパースの回帰防止が
// 目的だったため、まず解析の正しさ〔1エントリとして分割されないこと〕は throw メッセージで
// 確認し、その上で fail-closed になることを確認する）。
test('改行を含むパスは NUL 区切りで1エントリとして解析されるが invalid-path で fail-closed（#345 C3・行区切り誤改修の回帰防止・ラウンド4敵対的2）', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({
      toplevel: resolve(src),
      treeStr: tree([['100644', 'a1', 'docs/foo\nbar.md']]),
      blobs: { a1: 'x' },
    });
    assert.throws(
      () => buildPublicTree({ sourceRepo: src, outDir: out, runGit }),
      /パスに.*制御文字.*fail-closed.*docs\/foo\nbar\.md/s,
    );
    assert.equal(existsSync(out), false, 'fail 時は出力を残さない');
  } finally {
    cleanup();
  }
});

test('--source が repo ルートでない（toplevel 不一致）なら拒否（#345 C4）', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({ toplevel: resolve(src, 'subdir'), treeStr: tree([['100644', 'a1', 'x.js']]), blobs: { a1: 'x' } });
    assert.throws(() => buildPublicTree({ sourceRepo: src, outDir: out, runGit }), /リポジトリのルート/);
  } finally {
    cleanup();
  }
});

test('path traversal（.. を含む tree エントリ）は書き込み拒否（#345 C9）', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({ toplevel: resolve(src), treeStr: tree([['100644', 'a1', '../evil.js']]), blobs: { a1: 'x' } });
    assert.throws(() => buildPublicTree({ sourceRepo: src, outDir: out, runGit }), /path traversal/);
    assert.equal(existsSync(out), false);
  } finally {
    cleanup();
  }
});

test('manifest に included / excluded の全一覧を出力する（目視レビュー用。#345 operability F3）', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({
      toplevel: resolve(src),
      treeStr: tree([['100644', 'a1', 'src/index.js'], ['100644', 'a2', 'docs/pr/PR-1.md']]),
      blobs: { a1: 'code', a2: 'log' },
    });
    const r = buildPublicTree({ sourceRepo: src, outDir: out, runGit });
    const manifest = JSON.parse(readFileSync(r.manifestPath, 'utf-8'));
    assert.deepEqual(manifest.included, ['src/index.js']);
    assert.deepEqual(manifest.excluded, ['docs/pr/PR-1.md']);
  } finally {
    cleanup();
  }
});

test('manifest が public tree 内を指すと rename 前に拒否し出力を残さない（PR #458 Codex 指摘2）', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({ toplevel: resolve(src), treeStr: tree([['100644', 'a1', 'src/index.js']]), blobs: { a1: 'code' } });
    assert.throws(
      () => buildPublicTree({ sourceRepo: src, outDir: out, manifestPath: join(out, 'manifest.json'), runGit }),
      /manifest は public tree の外/,
    );
    assert.equal(existsSync(out), false, '不正 manifest パスで public tree を残さない');
  } finally {
    cleanup();
  }
});

test('manifest 書き込み失敗（パスがディレクトリ=EISDIR）でも public tree を残さない（PR #458 敵対的再レビュー）', () => {
  const { src, out, cleanup } = tmpDirs();
  const manifestAsDir = mkdtempSync(join(tmpdir(), 'man-as-dir-'));
  try {
    const runGit = mockGit({ toplevel: resolve(src), treeStr: tree([['100644', 'a1', 'src/index.js']]), blobs: { a1: 'code' } });
    // manifestPath が既存ディレクトリ → writeFileSync が EISDIR で throw（rename 前）
    assert.throws(() => buildPublicTree({ sourceRepo: src, outDir: out, manifestPath: manifestAsDir, runGit }), /EISDIR|illegal operation/i);
    assert.equal(existsSync(out), false, 'manifest 書込失敗時に public tree を残さない');
  } finally {
    rmSync(manifestAsDir, { recursive: true, force: true });
    cleanup();
  }
});

test('manifest が source repo 内（lexical）を指すと拒否（PR #458 敵対的再レビュー round2 指摘2）', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({ toplevel: resolve(src), treeStr: tree([['100644', 'a1', 'src/index.js']]), blobs: { a1: 'code' } });
    assert.throws(
      () => buildPublicTree({ sourceRepo: src, outDir: out, manifestPath: join(src, 'manifest.json'), runGit }),
      /manifest は source repo（control repo）の外/,
    );
    assert.equal(existsSync(out), false);
  } finally {
    cleanup();
  }
});

test('出力先が symlink 経由で source 配下を指すと realpath で検出し拒否（PR #458 敵対的再レビュー round2 指摘4）', () => {
  const { src, cleanup } = tmpDirs();
  const linkParent = mkdtempSync(join(tmpdir(), 'link-'));
  try {
    const link = join(linkParent, 'link-to-src');
    symlinkSync(src, link, 'dir');
    const outViaSymlink = join(link, 'public'); // link は src を指す symlink → 実体は src 配下
    const runGit = mockGit({ toplevel: resolve(src), treeStr: tree([['100644', 'a1', 'x.js']]), blobs: { a1: 'x' } });
    assert.throws(
      () => buildPublicTree({ sourceRepo: src, outDir: outViaSymlink, runGit }),
      /出力先を source repo の外に指定/,
    );
  } finally {
    rmSync(linkParent, { recursive: true, force: true });
    cleanup();
  }
});

test('manifest が symlink 経由で source 配下を指すと realpath で検出し拒否（PR #458 敵対的再レビュー round2 指摘4）', () => {
  const { src, out, cleanup } = tmpDirs();
  const linkParent = mkdtempSync(join(tmpdir(), 'link-'));
  try {
    const link = join(linkParent, 'link-to-src');
    symlinkSync(src, link, 'dir');
    const manifestViaSymlink = join(link, 'manifest.json');
    const runGit = mockGit({ toplevel: resolve(src), treeStr: tree([['100644', 'a1', 'x.js']]), blobs: { a1: 'x' } });
    assert.throws(
      () => buildPublicTree({ sourceRepo: src, outDir: out, manifestPath: manifestViaSymlink, runGit }),
      /manifest は source repo（control repo）の外/,
    );
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(linkParent, { recursive: true, force: true });
    cleanup();
  }
});

test('manifest が symlink 経由で out（public tree）自身の実体を指すと拒否（PR #458 Codex round4 指摘3）', () => {
  // out を先に空ディレクトリとして用意し（許容される前提条件）、別名の symlink 経由で
  // 同じ実体を manifest が指す状況を再現する（--out /real --manifest /link/manifest.json, /link -> /real）
  const { src, cleanup } = tmpDirs();
  const outParent = mkdtempSync(join(tmpdir(), 'out2-'));
  try {
    const realOut = join(outParent, 'real-out');
    mkdirSync(realOut, { recursive: true });
    const linkToOut = join(outParent, 'link-to-out');
    symlinkSync(realOut, linkToOut, 'dir');
    const manifestViaLink = join(linkToOut, 'manifest.json');
    const runGit = mockGit({ toplevel: resolve(src), treeStr: tree([['100644', 'a1', 'x.js']]), blobs: { a1: 'x' } });
    assert.throws(
      () => buildPublicTree({ sourceRepo: src, outDir: realOut, manifestPath: manifestViaLink, runGit }),
      /symlink 経由の実体パスで検出/,
    );
  } finally {
    rmSync(outParent, { recursive: true, force: true });
    cleanup();
  }
});

test('manifest に includedShas（git blob sha1）が含まれ、実ファイル内容と一致する（PR #458 Codex round4 指摘2）', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({
      toplevel: resolve(src),
      treeStr: tree([['100644', 'a1', 'src/index.js']]),
      blobs: { a1: 'code' },
    });
    const r = buildPublicTree({ sourceRepo: src, outDir: out, runGit });
    const manifest = JSON.parse(readFileSync(r.manifestPath, 'utf-8'));
    assert.equal(manifest.includedShas['src/index.js'], 'a1');
  } finally {
    cleanup();
  }
});

test('生成物（.vite/）が含まれると generatedLeaks に載る（denylist 素通りの警告。#345 F4/A2）', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({
      toplevel: resolve(src),
      treeStr: tree([['100644', 'a1', 'src/index.js'], ['100644', 'a2', '.vite/deps/_metadata.json']]),
      blobs: { a1: 'code', a2: '{}' },
    });
    const r = buildPublicTree({ sourceRepo: src, outDir: out, runGit });
    assert.deepEqual(r.generatedLeaks, ['.vite/deps/_metadata.json']);
  } finally {
    cleanup();
  }
});

test('denylist 規則: docs/agent-memory/ の想定外配置・`\\`/制御文字/非 ASCII は生成中止（fail-closed。ラウンド2 A-4／ラウンド3減算 S-1/S-2/S-8／ラウンド3敵対的 A-11／ラウンド4敵対的2。拒否テスト3件をパス配列1テストに統合）', () => {
  const cases = [
    {
      label: 'docs/agent-memory/x.json（root 直下・records/ 外）',
      path: 'docs/agent-memory/x.json',
      re: /docs\/agent-memory\/ 配下の想定外の場所にある記憶レコード.*fail-closed.*docs\/agent-memory\/x\.json/s,
    },
    {
      label: 'worker/docs/agent-memory/records/x.json（ネスト。isControlOnlyPath は root anchored のため素通りする）',
      path: 'worker/docs/agent-memory/records/x.json',
      re: /docs\/agent-memory\/ 配下の想定外の場所にある記憶レコード.*fail-closed.*worker\/docs\/agent-memory\/records\/x\.json/s,
    },
    {
      label: 'docs/agent-memory\\records\\x.json（バックスラッシュで区切り文字判定をすり抜けようとする）',
      path: 'docs\\agent-memory\\records\\x.json',
      re: /パスに.*非 ASCII.*fail-closed/,
    },
    {
      label: 'docs／agent-memory／x.json（U+FF0F 全角スラッシュ。ラウンド3敵対的 A-11。非 ASCII の一般化で検出）',
      path: 'docs\uFF0Fagent-memory\uFF0Fx.json',
      re: /パスに.*非 ASCII.*fail-closed/,
    },
    {
      label: 'docs/agent-memory/x\u0001.json（NUL は git パス区切りと衝突するため SOH〔U+0001〕で制御文字を代表させる。ラウンド4敵対的2）',
      path: 'docs/agent-memory/x\u0001.json',
      re: /パスに.*制御文字.*fail-closed/,
    },
  ];
  for (const { label, path: p, re } of cases) {
    const { src, out, cleanup } = tmpDirs();
    try {
      const runGit = mockGit({
        toplevel: resolve(src),
        treeStr: tree([['100644', 'a1', 'src/index.js'], ['100644', 'a2', p]]),
        blobs: { a1: 'code', a2: '{}' },
      });
      assert.throws(() => buildPublicTree({ sourceRepo: src, outDir: out, runGit }), re, label);
      assert.equal(existsSync(out), false, `fail 時は出力を残さない: ${label}`);
    } finally {
      cleanup();
    }
  }
});

test('denylist 規則: docs/agent-memory/ 配下の非 json（README.md・digest.md）は denylist 既定どおり included・records/ 配下は control-only で excluded（ラウンド3減算 S-2）', () => {
  const { src, out, cleanup } = tmpDirs();
  try {
    const runGit = mockGit({
      toplevel: resolve(src),
      treeStr: tree([
        ['100644', 'a1', 'src/index.js'],
        ['100644', 'a2', 'docs/agent-memory/README.md'],
        ['100644', 'a3', 'docs/agent-memory/digest.md'],
        ['100644', 'a4', 'docs/agent-memory/records/mem-20260101-abcdef.json'],
      ]),
      blobs: { a1: 'code', a2: '# agent-memory', a3: '# digest', a4: '{}' },
    });
    const r = buildPublicTree({ sourceRepo: src, outDir: out, runGit });
    assert.equal(r.includedCount, 3);
    assert.deepEqual(r.excluded, ['docs/agent-memory/records/mem-20260101-abcdef.json']);
    assert.equal(readFileSync(join(out, 'docs/agent-memory/README.md'), 'utf-8'), '# agent-memory');
    assert.equal(readFileSync(join(out, 'docs/agent-memory/digest.md'), 'utf-8'), '# digest');
    assert.equal(existsSync(join(out, 'docs/agent-memory/records/mem-20260101-abcdef.json')), false);
  } finally {
    cleanup();
  }
});
