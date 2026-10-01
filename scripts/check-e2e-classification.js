import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = resolve(ROOT, 'e2e/classification.json');

export const RUNTIME_TAGS = [
  '@smoke',
  '@editor-critical',
  '@heavy',
  '@perf',
  '@ime',
];

const RUNTIME_TAG_SET = new Set(RUNTIME_TAGS);
const ALL_ONLY = 'all-only';

export function extractRuntimeTags(content) {
  const tags = new Set();
  const tagProperty = /\btag\s*:\s*(\[[^\]]*\]|['"]@(?:smoke|editor-critical|heavy|perf|ime)['"])/g;
  for (const match of content.matchAll(tagProperty)) {
    const value = match[1];
    for (const tagMatch of value.matchAll(/['"](@(?:smoke|editor-critical|heavy|perf|ime))['"]/g)) {
      tags.add(tagMatch[1]);
    }
  }
  return [...tags].sort();
}

export function validateClassification({ specPaths, manifest, readFile }) {
  const errors = [];
  if (!manifest || manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object') {
    return ['classification manifest は version=1 の files object を持つ必要があります'];
  }

  const tracked = [...specPaths].sort();
  const declared = Object.keys(manifest.files).sort();

  for (const path of tracked) {
    if (!Object.hasOwn(manifest.files, path)) errors.push(`未分類の E2E spec: ${path}`);
  }
  for (const path of declared) {
    if (!tracked.includes(path)) errors.push(`manifest にだけ存在する E2E spec: ${path}`);
  }

  for (const path of tracked) {
    if (!Object.hasOwn(manifest.files, path)) continue;
    const expected = manifest.files[path];
    if (!Array.isArray(expected) || expected.length === 0) {
      errors.push(`${path}: 分類は1件以上の配列で指定してください`);
      continue;
    }
    if (new Set(expected).size !== expected.length) {
      errors.push(`${path}: 分類が重複しています: ${expected.join(', ')}`);
    }
    const unknown = expected.filter((v) => v !== ALL_ONLY && !RUNTIME_TAG_SET.has(v));
    if (unknown.length > 0) {
      errors.push(`${path}: 未知の分類: ${unknown.join(', ')}`);
      continue;
    }
    if (expected.includes(ALL_ONLY) && expected.length !== 1) {
      errors.push(`${path}: all-only は runtime tag と併用できません`);
      continue;
    }

    const actual = extractRuntimeTags(readFile(path));
    const expectedRuntime = expected.filter((v) => v !== ALL_ONLY).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expectedRuntime)) {
      errors.push(
        `${path}: runtime tag が manifest と不一致 (expected=${expectedRuntime.join(',') || 'none'} actual=${actual.join(',') || 'none'})`,
      );
    }

    if (expected.includes('@smoke') && expected.length !== 1) {
      errors.push(`${path}: @smoke は他分類と重複させません`);
    }
    if (expected.includes('@editor-critical') && expected.length !== 1) {
      errors.push(`${path}: @editor-critical は他分類と重複させません`);
    }
  }

  return errors;
}

export function trackedSpecPaths(root = ROOT) {
  return execFileSync('git', ['ls-files', '--', 'e2e'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /\.spec\.(?:js|jsx|ts|tsx)$/.test(s))
    .sort();
}

export function runCheck(root = ROOT) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'e2e/classification.json'), 'utf8'));
  const specPaths = trackedSpecPaths(root);
  const errors = validateClassification({
    specPaths,
    manifest,
    readFile: (path) => readFileSync(resolve(root, path), 'utf8'),
  });
  if (errors.length > 0) {
    throw new Error(['E2E classification check failed:', ...errors.map((e) => `- ${e}`)].join('\n'));
  }
  return { specCount: specPaths.length };
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  try {
    const result = runCheck();
    console.log(`E2E classification OK: ${result.specCount} specs`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
