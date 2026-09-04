// 同期対象 file entity の同一性（canonical hash）と、そこから導く同期アクション（#610）。
// 正本: docs/data-model/sync-contract.md「同期完了判定」「hash の入力範囲」。
//
// 対象フィールドは現行 sync payload の canonical 部分のみ:
//   id / name / content / github:{owner,repo,branch,path}
// 除外（意図的。テストで固定する）:
//   - `_` 始まりの transport フィールド（_sha 等）
//   - isDirty（device-local な bookkeeping。sync-contract.md §2 の対象外分類 A2/D）
//   - updatedAt / createdAt（時計は同期判定の一次情報にしない。issue #610 完了条件3）
//   - github.sha（GitHub blob sha は derived state。canonical ではない）
//   - security（pull 時にローカルで付与する検証結果。device-local）
// 対象外フィールドは picking 元の allowlist に含めないことで自然に除外する（新しいフィールドが
// file オブジェクトへ増えても、ここで明示的に選ばない限り hash に影響しない）。

// #394 C-1 round2 (S1): sync.js の githubCoordsOnly（push/carryOver 用）と同義。ここを正として
// export し、sync.js から再利用する。挙動差: 非文字列フィールドを null に倒す（安全側）。
export function pickGithubCoords(github) {
  if (!github || typeof github !== 'object' || Array.isArray(github)) return null;
  const { owner, repo, branch, path } = github;
  return {
    owner: typeof owner === 'string' ? owner : null,
    repo: typeof repo === 'string' ? repo : null,
    branch: typeof branch === 'string' ? branch : null,
    path: typeof path === 'string' ? path : null,
  };
}

// key 順を固定した canonical 表現（決定的）。オブジェクトリテラルの列挙順は仕様上
// 挿入順のため、この関数を経由する限り呼び出し元のプロパティ順に依存せず同じ文字列になる。
export function canonicalSerialize(file) {
  return JSON.stringify({
    id: typeof file?.id === 'string' ? file.id : null,
    name: typeof file?.name === 'string' ? file.name : null,
    content: typeof file?.content === 'string' ? file.content : '',
    github: pickGithubCoords(file?.github),
  });
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const CANONICAL_HASH_PATTERN = /^[0-9a-f]{64}$/;

// remote entry の `hash` フィールドが SHA-256 の 64 桁小文字 hex として妥当かを検証する
// （#610 round2 F2）。`"0"` 等の壊れた値・改変された manifest の値を「hash あり」として
// 誤って信用しないよう、形式が一致しない値は「欠落」と同じに扱う（呼び出し側の legacy
// 補完経路へ倒す）。
export function isValidCanonicalHash(value) {
  return typeof value === 'string' && CANONICAL_HASH_PATTERN.test(value);
}

// canonical hash（SHA-256 の hex 文字列）。crypto.subtle が使えない環境・digest が例外を
// 投げた場合は throw する（呼び出し側が fail-closed で「この file は判定不能」として扱う。
// sync-contract.md「hash 計算失敗」）。
export async function computeCanonicalHash(file) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('crypto.subtle is unavailable; cannot compute canonical hash');
  }
  const data = new TextEncoder().encode(canonicalSerialize(file));
  const digest = await subtle.digest('SHA-256', data);
  return toHex(digest);
}

// 同期アクションの導出（純粋・同期）。入力は事前計算済みの hash のみ — updatedAt は一切
// 見ない（issue #610 完了条件3）。sync.js（entity write）と badge（useSyncPending）が
// この関数を共有する（完了条件7）。
//   L: localHash（このデバイスが今持っている内容の canonical hash）
//   R: remoteHash（manifest entry.hash。entry が無ければ undefined/null）
//   A: adoptedHash（syncState。このデバイスが最後に remote と一致を確認した hash）
// 戻り値: { action: 'push'|'pull'|'skip'|'conflict', adopt?: string }
//   adopt は「転送なしで A を書き換えてよい hash」。skip で A が古い（R と不一致）ときだけ返す。
export function deriveSyncAction({ localHash, remoteHash, adoptedHash }) {
  if (remoteHash === undefined || remoteHash === null) return { action: 'push' };
  if (localHash === remoteHash) {
    return adoptedHash === remoteHash ? { action: 'skip' } : { action: 'skip', adopt: remoteHash };
  }
  if (localHash === adoptedHash) return { action: 'pull' };
  if (remoteHash === adoptedHash) return { action: 'push' };
  return { action: 'conflict' };
}
