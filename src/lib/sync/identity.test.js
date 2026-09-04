import { describe, it, expect } from 'vitest';
import {
  canonicalSerialize,
  computeCanonicalHash,
  deriveSyncAction,
  isValidCanonicalHash,
} from './identity';

// ── canonicalSerialize / 除外規則 ────────────────────────────────────────────

describe('canonicalSerialize', () => {
  const base = {
    id: 'a',
    name: 'file.md',
    content: '本文',
    github: { owner: 'o', repo: 'r', branch: 'main', path: 'p.md', sha: 'blob-sha' },
  };

  it('id/name/content/github coords が同じなら同じ文字列を返す（決定性）', () => {
    const a = canonicalSerialize({ ...base });
    const b = canonicalSerialize({
      github: { ...base.github },
      content: base.content,
      name: base.name,
      id: base.id,
    });
    expect(a).toBe(b);
  });

  it('id/name/content/github coords のいずれかが変わればハッシュ対象の文字列が変わる', () => {
    const a = canonicalSerialize(base);
    expect(canonicalSerialize({ ...base, id: 'b' })).not.toBe(a);
    expect(canonicalSerialize({ ...base, name: 'other.md' })).not.toBe(a);
    expect(canonicalSerialize({ ...base, content: '別の本文' })).not.toBe(a);
    expect(canonicalSerialize({ ...base, github: { ...base.github, owner: 'other' } })).not.toBe(a);
    expect(canonicalSerialize({ ...base, github: { ...base.github, repo: 'other' } })).not.toBe(a);
    expect(canonicalSerialize({ ...base, github: { ...base.github, branch: 'other' } })).not.toBe(a);
    expect(canonicalSerialize({ ...base, github: { ...base.github, path: 'other.md' } })).not.toBe(a);
  });

  it('github が null/undefined なら null として扱う', () => {
    expect(canonicalSerialize({ ...base, github: null })).toBe(
      canonicalSerialize({ ...base, github: undefined }),
    );
  });

  // 除外規則（issue #610 完了条件4）: transport/`_`始まり・isDirty・updatedAt/createdAt・
  // github.sha・security・device-local を変えても文字列は変わらない。
  it('github.sha を変えても対象文字列は変わらない（derived state を除外）', () => {
    const a = canonicalSerialize(base);
    const b = canonicalSerialize({ ...base, github: { ...base.github, sha: 'different-sha' } });
    expect(a).toBe(b);
  });

  it('isDirty を変えても対象文字列は変わらない', () => {
    const a = canonicalSerialize({ ...base, isDirty: true });
    const b = canonicalSerialize({ ...base, isDirty: false });
    expect(a).toBe(b);
  });

  it('updatedAt / createdAt を変えても対象文字列は変わらない', () => {
    const a = canonicalSerialize({ ...base, updatedAt: 1, createdAt: 1 });
    const b = canonicalSerialize({ ...base, updatedAt: 999999999, createdAt: 999999999 });
    expect(a).toBe(b);
  });

  it('security を変えても対象文字列は変わらない', () => {
    const a = canonicalSerialize({ ...base, security: { decision: 'allow' } });
    const b = canonicalSerialize({ ...base, security: { decision: 'deny' } });
    expect(a).toBe(b);
  });

  it('`_` で始まる transport フィールドを変えても対象文字列は変わらない', () => {
    const a = canonicalSerialize({ ...base, _sha: 'x', _manifestSha: 'x', _branch: 'main' });
    const b = canonicalSerialize({ ...base, _sha: 'y', _manifestSha: 'y', _branch: 'dev' });
    expect(a).toBe(b);
  });

  // parentId は device-local ではなく sync-contract.md §2 の分類 A（canonical）だが、
  // 現行の sync payload（file entity）には載っていないため hash 対象外（#394 で folder が
  // 同期対象になる際に対象へ含める）。allowlist に無いフィールドが自然に除外されることの
  // 固定テストとして、対象外の任意フィールドの一例に使う。
  it('現行 payload に載らないフィールド（例: parentId）を変えても対象文字列は変わらない', () => {
    const a = canonicalSerialize({ ...base, parentId: 'folder-1' });
    const b = canonicalSerialize({ ...base, parentId: 'folder-2' });
    expect(a).toBe(b);
  });
});

// ── computeCanonicalHash ─────────────────────────────────────────────────────

describe('computeCanonicalHash', () => {
  const file = { id: 'a', name: 'a.md', content: 'hello', github: null };

  it('同じ入力からは同じ hash を返す', async () => {
    const h1 = await computeCanonicalHash(file);
    const h2 = await computeCanonicalHash({ ...file });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('content が異なれば hash も異なる', async () => {
    const h1 = await computeCanonicalHash(file);
    const h2 = await computeCanonicalHash({ ...file, content: 'world' });
    expect(h1).not.toBe(h2);
  });

  it('crypto.subtle が使えない環境では throw する（fail-closed）', async () => {
    const original = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
      await expect(computeCanonicalHash(file)).rejects.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});

// ── deriveSyncAction ──────────────────────────────────────────────────────────

describe('deriveSyncAction', () => {
  it('remoteHash が無ければ push（entry なし。create-only）', () => {
    expect(deriveSyncAction({ localHash: 'L', remoteHash: undefined, adoptedHash: undefined })).toEqual({
      action: 'push',
    });
    expect(deriveSyncAction({ localHash: 'L', remoteHash: null, adoptedHash: 'A' })).toEqual({
      action: 'push',
    });
  });

  it('L === R かつ A === R なら skip（adopt 不要）', () => {
    expect(deriveSyncAction({ localHash: 'X', remoteHash: 'X', adoptedHash: 'X' })).toEqual({
      action: 'skip',
    });
  });

  it('L === R だが A が古い/無いなら skip + adopt（転送なしで採用）', () => {
    expect(deriveSyncAction({ localHash: 'X', remoteHash: 'X', adoptedHash: undefined })).toEqual({
      action: 'skip',
      adopt: 'X',
    });
    expect(deriveSyncAction({ localHash: 'X', remoteHash: 'X', adoptedHash: 'OLD' })).toEqual({
      action: 'skip',
      adopt: 'X',
    });
  });

  it('L !== R かつ L === A なら pull（remote だけ変わった）', () => {
    expect(deriveSyncAction({ localHash: 'A', remoteHash: 'R', adoptedHash: 'A' })).toEqual({
      action: 'pull',
    });
  });

  it('L !== R かつ R === A なら push（local だけ変わった）', () => {
    expect(deriveSyncAction({ localHash: 'L', remoteHash: 'A', adoptedHash: 'A' })).toEqual({
      action: 'push',
    });
  });

  it('L !== R かつ A が無い（v4 移行直後）なら conflict（方向不明。isDirty を信じない）', () => {
    expect(deriveSyncAction({ localHash: 'L', remoteHash: 'R', adoptedHash: undefined })).toEqual({
      action: 'conflict',
    });
  });

  it('L !== R かつ A が L・R いずれとも異なる（双方変更）なら conflict', () => {
    expect(deriveSyncAction({ localHash: 'L', remoteHash: 'R', adoptedHash: 'OLD' })).toEqual({
      action: 'conflict',
    });
  });

  it('L !== R かつ L === A === R は起こらない前提だが、L===A を pull として扱う（優先順位の固定）', () => {
    // L===A と R===A が同時に成り立つのは L===R のときだけ（分岐1で処理済み）なので、
    // ここに到達する時点で L===A と R===A は排他。優先順位のドリフトを防ぐための固定テスト。
    expect(deriveSyncAction({ localHash: 'A', remoteHash: 'R', adoptedHash: 'A' }).action).toBe('pull');
  });
});

// ── isValidCanonicalHash（#610 round2 F2） ────────────────────────────────────

describe('isValidCanonicalHash', () => {
  it('64 桁の小文字 hex 文字列は妥当とみなす', () => {
    expect(isValidCanonicalHash('a'.repeat(64))).toBe(true);
    expect(isValidCanonicalHash('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it.each([
    ['壊れた短い値', '0'],
    ['長さ不足', 'a'.repeat(63)],
    ['長さ超過', 'a'.repeat(65)],
    ['大文字 hex', 'A'.repeat(64)],
    ['16 進以外の文字を含む', 'g'.repeat(64)],
    ['非文字列（数値）', 0],
    ['非文字列（null）', null],
    ['非文字列（undefined）', undefined],
  ])('%s は妥当と判定しない（欠落扱い）', (_label, value) => {
    expect(isValidCanonicalHash(value)).toBe(false);
  });
});
