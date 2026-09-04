// 同期失敗の意味を worker → client で失わずに扱うための分類（#608 A-1）。
//
// 以前は worker が GitHub の status を `throw new Error('GitHub ' + status)` へ潰し、
// route の catch が一律 500 を返していたため、client からは SHA 競合（409）・検証エラー
// （422）・上流障害（5xx）がすべて「サーバーエラー」に見えていた。競合と障害が区別できないと、
// 復旧の判断（再同期すべきか、待つべきか、初回同期扱いにしてよいか）が付かない。
//
// parity: worker/src/syncErrors.ts と対（code 集合を syncErrorCodeParity.test.js が機械検査）。

// manifest formatVersion に関わる 3 つの意味を分離した定数（#394 C-0）。worker 側の
// worker/src/syncErrorCodes.ts の定義を正とする写し。信頼境界をまたぐ定数のため、
// 値の一致は syncErrorCodeParity.test.js が機械検査する（SYNC_ERROR_CODES と同じ機構）。

// (a) manifest.version が欠落・非整数な場合に補う既定値（旧 client 扱い）。
// parseFormatVersion の fallback、および worker init の bootstrap manifest placeholder に使う。
export const LEGACY_DEFAULT_FORMAT_VERSION = 2; // not-a-threshold（protocol version。性能調整値ではない）
// (b) capability 宣言不問で無条件に読み書きを許可してよい安全域の上限（safety ceiling）。
// worker 側の checkFormatCapability（書き込みガード・早期 return）・checkRemoteFormatVersion・
// PUT /sync/manifest の v2 形状検査閾値の 4 箇所にのみ使う（worker/src/syncErrorCodes.ts 参照）。
// 2 から上げてはならない（上げると v3 への無検査書き込みを通す）。
export const KNOWN_SAFE_FORMAT_VERSION = 2; // not-a-threshold（protocol version。性能調整値ではない）
// (c) この client 世代が実際に読み書きできる format version。capability header 送信値、
// client の読み側中止ゲート（buildRemoteMap/syncAll）、pushManifest が書く manifest body の
// version に使う。v3 対応（#394 C-1）でこの値だけを 3 に上げた。
export const FORMAT_CAPABILITY_VERSION = 3; // not-a-threshold（protocol version。性能調整値ではない）
// この client が capability を宣言する header 名。値と同じ理由でここに定義し、
// syncErrorCodeParity.test.js が client/worker の一致を機械検査する。
export const FORMAT_CAPABILITY_HEADER = 'X-Novel-Ide-Format-Version';

// worker が返す machine-readable code。**HTTP status 単体を分岐条件にしない**
// （同じ status に複数の意味が乗る。404 の repo 不在 / content 不在が典型）。
export const SYNC_ERROR_CODES = Object.freeze({
  conflict: 'sync_conflict',
  unprocessable: 'sync_unprocessable',
  forbidden: 'sync_forbidden',
  repoMissing: 'sync_repo_missing',
  manifestMissing: 'sync_manifest_missing',
  contentMissing: 'sync_content_missing',
  workspaceInconsistent: 'sync_workspace_inconsistent',
  remoteCorrupt: 'sync_remote_corrupt',
  upstream: 'sync_upstream_error',
  server: 'sync_server_error',
  // remote manifest の formatVersion が、この client の capability 宣言を超えている（#609 A-2）。
  protocolUpgradeRequired: 'sync_protocol_upgrade_required',
  // entity write が読んだ manifest 世代から進んでいた（worker 自身の検出。#609 A-2）。
  manifestStale: 'sync_manifest_stale',
  // manifest entry の blob sha と entity write の _sha が不一致（#609 A-2）。
  entityStale: 'sync_entity_stale',
  // manifest に entry の無い id への write で、entity が既に実在した（#609 A-2）。
  entityOrphan: 'sync_entity_orphan',
  // entity write が _manifestSha を送っていない旧 bundle（#609 A-2）。
  manifestRefRequired: 'sync_manifest_ref_required',
});

// code → { category, status }。status は worker がその code を返すときの HTTP status。
// **code は status と整合するときだけ信頼する**（下記 categorizeSyncFailure 参照）。
const CODE_CATEGORY = new Map([
  [SYNC_ERROR_CODES.conflict, { category: 'conflict', status: 409 }],
  [SYNC_ERROR_CODES.unprocessable, { category: 'unprocessable', status: 422 }],
  [SYNC_ERROR_CODES.forbidden, { category: 'forbidden', status: 403 }],
  [SYNC_ERROR_CODES.repoMissing, { category: 'not_found', status: 404 }],
  [SYNC_ERROR_CODES.manifestMissing, { category: 'not_found', status: 404 }],
  [SYNC_ERROR_CODES.contentMissing, { category: 'not_found', status: 404 }],
  [SYNC_ERROR_CODES.workspaceInconsistent, { category: 'workspace_inconsistent', status: 404 }],
  [SYNC_ERROR_CODES.remoteCorrupt, { category: 'corrupt', status: 502 }],
  [SYNC_ERROR_CODES.upstream, { category: 'upstream', status: 502 }],
  [SYNC_ERROR_CODES.server, { category: 'server', status: 500 }],
  [
    SYNC_ERROR_CODES.protocolUpgradeRequired,
    { category: 'protocol_upgrade_required', status: 426 },
  ],
  [SYNC_ERROR_CODES.manifestStale, { category: 'conflict', status: 409 }],
  [SYNC_ERROR_CODES.entityStale, { category: 'conflict', status: 409 }],
  [SYNC_ERROR_CODES.entityOrphan, { category: 'conflict', status: 409 }],
  [
    SYNC_ERROR_CODES.manifestRefRequired,
    { category: 'protocol_upgrade_required', status: 426 },
  ],
]);

// UI に出す文言はこの catalog **だけ**を源にする。worker の応答本文（`error`）を表示へ
// 転用しない: sync route 以外のミドルウェア応答（`unauthorized` / `session expired` /
// `csrf token invalid` 等の内部英語文字列）も同じ fetch 経路を通るため、本文をそのまま
// 載せると日本語 UI にそれらが露出する。
//
// worker 側にも category 別の `error` 文言があるが、あちらは **応答本文をそのまま描画する
// 消費者**（DevicesMod の削除失敗表示）向けの事実文であり、こちらは行動指示を含む UI 文言。
// 役割が違うので両方あってよい。ただし category 集合がずれると片側だけ文言が無い状態に
// なるため、集合の一致は syncErrorCodeParity.test.js が機械検査する。
// category 集合の worker parity を機械検査するため export する（syncErrorCodeParity.test.js）。
export const CATEGORY_MESSAGE = Object.freeze({
  conflict: '他の端末の変更と競合しました。再読み込みしてから同期してください',
  unprocessable: '同期データが受け付けられませんでした',
  // 403 は権限不足だけでなく secondary rate limit でも返る。権限不足に断定すると、
  // 待てば直る状況で連携解除・再ログインへ誘導してしまう。
  forbidden:
    'GitHub の権限が不足しているか、アクセス制限に達しています。時間をおいて再試行してください',
  auth: 'GitHub の再ログインが必要です',
  not_found: '同期先が見つかりませんでした',
  workspace_inconsistent:
    '同期 manifest が失われています。全件を上書きしないため同期を中止しました',
  corrupt: '同期リポジトリのデータが壊れています',
  // GitHub 側の障害と worker 自身のレートリミット（429）の両方がここに来るため、
  // 原因を GitHub に帰属させる文言にしない。
  upstream: '同期が一時的に受け付けられませんでした。時間をおいて再試行してください',
  server: '同期サーバーでエラーが発生しました',
  network: '通信に失敗しました',
  // remote が新しい formatVersion を宣言しており、この client では安全に書き込めない（#609 A-2）。
  // 再試行では直らないため、上流障害（upstream）とは別の文言で更新を案内する。
  protocol_upgrade_required:
    'このアプリのバージョンでは同期データを安全に書き込めません。アプリを更新してください',
  // worker の body size 上限（2MB）超過。再試行では直らないので、障害ではなく
  // 入力サイズの問題として案内する。
  too_large: '本文が大きすぎて同期できませんでした。ファイルを分割してください',
  // client 側の整合性ガードが同期を止めた場合。worker 由来の server と混ぜると
  // 「worker の障害」として報告され、最も重要な事実（client が止めた）が失われる。
  internal: '安全のため同期を中止しました（整合性チェック）',
});

// 表示に採る category の優先順。利用者が次の行動を決められるもの（競合・権限・再ログイン）を
// 上位に置く。複数ファイルの push が別々の理由で失敗したときの代表選出に使う。
// CATEGORY_MESSAGE の全キーを網羅すること（syncErrorCodeParity.test.js が機械検査する）。
// 欠けても pickPrimaryCategory の末尾フォールバックで動いてしまい、表面化しない。
export const CATEGORY_PRIORITY = [
  'workspace_inconsistent',
  'protocol_upgrade_required',
  'corrupt',
  'conflict',
  'auth',
  'forbidden',
  'unprocessable',
  'too_large',
  'not_found',
  'internal',
  'upstream',
  'server',
  'network',
];

// **code は status と整合するときだけ信頼する。**
//
// code を status と突き合わせずに信頼すると、応答本文だけを書き換えられる中間層
// （SW・書き換え型プロキシ・worker の regression）が、HTTP 500 に `sync_conflict` を
// 載せるだけで表示と復旧指示を反転させられる（「再同期すれば直る」と誤誘導できる）。
// JSON の重複キー（後勝ち）で既存 code を上書きする追記だけの改変も同じ経路。
// 整合しない組み合わせは code を捨て、status だけで分類する（安全側への劣化）。
//
// status フォールバックを残すのは、旧 worker や本文を落とす経路で code が得られない
// ときでも 409 / 422 を取り違えないため。
export function categorizeSyncFailure(status, code) {
  const byCode = CODE_CATEGORY.get(code);
  if (byCode && byCode.status === status) return byCode.category;
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'unprocessable';
  if (status === 426) return 'protocol_upgrade_required';
  // worker 自身のレートリミット（/sync/* は code を持たない 429 を返す）。server に落とすと
  // 「待てば直る」状況で即時再試行を促す。初回同期は 1 ファイルあたり 2 リクエストを使うため
  // 最も踏みやすい失敗のひとつ。
  if (status === 429) return 'upstream';
  if (status >= 502 && status <= 504) return 'upstream';
  // worker が返す 400（Invalid JSON / invalid id / invalid name / branch / rootPath）は
  // client が送った内容の拒否であって worker の障害ではない。
  if (status === 400) return 'internal';
  // 413 は body size 上限超過（middleware の bodySize。code を持たない）。server に落とすと
  // 「サーバー障害」と表示され、再試行しても直らない入力を障害と誤認させる。
  if (status === 413) return 'too_large';
  return 'server';
}

export function syncFailureMessage(category) {
  return CATEGORY_MESSAGE[category] ?? CATEGORY_MESSAGE.server;
}

export function pickPrimaryCategory(categories) {
  for (const candidate of CATEGORY_PRIORITY) {
    if (categories.includes(candidate)) return candidate;
  }
  return categories.length > 0 ? categories[0] : null;
}

export class SyncRequestError extends Error {
  constructor(category, { status = null, code = null, operation = null } = {}) {
    super(syncFailureMessage(category));
    this.name = 'SyncRequestError';
    this.category = category;
    this.status = status;
    this.code = code;
    this.operation = operation;
  }
}

// 失敗レスポンスを typed error にする。本文からは **code だけ**を読む。本文が JSON でない・
// 空でも分類できるよう、読み取り失敗は status へのフォールバックに落とす。
// 文言は CATEGORY_MESSAGE から引く（本文の `error` を表示へ転用しない理由は同 catalog のコメント）。
export async function readSyncFailure(response, operation = null) {
  const body = await response.json().catch(() => ({}));
  const code = typeof body?.code === 'string' ? body.code : null;
  const category = categorizeSyncFailure(response.status, code);
  return new SyncRequestError(category, { status: response.status, code, operation });
}

// 失敗を握り潰す/表示へ落とす箇所から呼ぶ診断ログ。worker 側の
// console.error('sync upstream error', operation, status) と対になる。
// 生成点（readSyncFailure）ではなく消費点で呼ぶ: manifest の 404 は init へ進む正常分岐でも
// 生成されるため、生成点でログすると通常の初回同期が失敗として記録される。
export function logSyncFailure(e) {
  if (e instanceof SyncRequestError) {
    console.warn('sync failed', e.operation, e.category, e.status, e.code);
    return;
  }
  console.warn('sync failed', e?.message);
}

// init の create-only 前提が崩れたことを表す失敗。**部分失敗として飲み込んではならない**:
// 飲み込んで manifest を確定させると、その id を含まない snapshot が成立し、次回同期では
// manifest に無い＝push と判定されて、expectAbsent を持たない通常経路が別端末の entity の
// SHA を取得して本文を上書きする（#608）。category は元の失敗のものを保つ。
export class SyncAbortError extends SyncRequestError {
  constructor(category, options) {
    super(category, options);
    this.name = 'SyncAbortError';
  }
}

// typed でない例外の category。**TypeError を network の判定条件にしない**: TypeError は
// fetch の拒否だけでなく、成功応答の形状不正（HTTP 200 で null が返る等）や実装上の
// プロパティアクセス失敗でも出るため、一律 network にすると恒久的な破損が「通信障害」として
// 集計・表示され誰も気づけない。fetch の拒否は workerClient の境界で
// SyncRequestError('network') に型付け済みで、ここには typed error として来る。
export function categorizeThrown(e) {
  if (e instanceof SyncRequestError) return e.category;
  return 'internal';
}
