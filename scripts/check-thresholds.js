import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// モジュールスコープの ALL_CAPS 数値リテラル定数を検出（式・計算値は対象外）
const CONST_PATTERN = /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]+)\s*=\s*\d+(?:_\d+)*\s*(?:;|\/\/|$)/;
const EXCLUDE_COMMENT = /\/\/\s*not-a-threshold/;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const docText = readFileSync(join(ROOT, 'docs/PERFORMANCE_THRESHOLDS.md'), 'utf-8');
const docWords = new Set(
  [...docText.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1].trim())
    .map((content) => {
      const m = content.match(/^([A-Z][A-Z0-9_]+)(?:\s*=.*)?$/);
      return m ? m[1] : null;
    })
    .filter(Boolean),
);

function walkJs(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkJs(full));
    else if (
      entry.isFile() &&
      ['.js', '.jsx'].includes(extname(full)) &&
      !entry.name.endsWith('.test.js') &&
      !entry.name.endsWith('.test.jsx')
    )
      files.push(full);
  }
  return files;
}

const files = [...walkJs(join(ROOT, 'src/hooks')), ...walkJs(join(ROOT, 'src/lib'))];
if (files.length === 0) {
  console.error(
    'check-thresholds: src/hooks/ と src/lib/ に JS ファイルが見つかりません。パスを確認してください。',
  );
  process.exit(1);
}

const missing = [];
for (const file of files) {
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    if (EXCLUDE_COMMENT.test(line)) continue;
    const m = CONST_PATTERN.exec(line);
    if (!m) continue;
    if (!docWords.has(m[1]))
      missing.push({ name: m[1], file: relative(ROOT, file).replace(/\\/g, '/') });
  }
}

if (missing.length > 0) {
  console.error('docs/PERFORMANCE_THRESHOLDS.md に記載のない定数が見つかりました:\n');
  for (const { name, file } of missing) console.error(`  ${name}  (${file})`);
  console.error(
    '\ndocs/PERFORMANCE_THRESHOLDS.md に追記するか、定数に // not-a-threshold コメントを付けてください。',
  );
  process.exit(1);
}

process.stdout.write('check-thresholds: OK\n');
