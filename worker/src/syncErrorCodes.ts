// sync error の **依存フリー**な定数・分類・応答テーブル。
//
// このファイルは実行時 import を一切持たない。root の vitest から直接 import して client との
// parity を機械検査するため（`src/lib/syncErrorCodeParity.test.js`）。hono 等の worker 専用
// 依存を**値として** import すると、root の `npm ci` しかしない CI の `lint-test` で module
// 解決に失敗し、**すべての code 変更で lint-test が落ちる**（worker の依存は
// worker/package.json にしかなく、lint-test は worker/node_modules を作らない）。
// 同じ理由で `worker/src/validation.ts` も実行時 import を持たない
// （rootPathValidationParity.test.js が同方式で読む）。
//
// hono に依存する応答ヘルパー・error class は syncErrors.ts 側に置くこと。

// manifest formatVersion に関わる 3 つの意味を分離した定数（#394 C-0。旧版は
// KNOWN_SAFE_FORMAT_VERSION 1 つで (a)(b) 両方を兼ねており、v3 対応でこの値を引き上げると
// checkFormatCapability の無条件許可 early-return が「remote が既に v3」まで無検査で
// 通してしまう罠があった。詳細な経緯は git 履歴の本コメント旧版を参照）。
// 信頼境界（worker ⇄ client）をまたいで値を一致させる必要があるため、SYNC_ERROR_CODES と
// 同じ理由でここに置き、client 側（src/lib/syncErrors.js）は写しを持ち、
// syncErrorCodeParity.test.js が両者の値の一致を機械検査する。

// (a) manifest.version が欠落・非整数な場合に補う既定値。「version フィールドを一度も
// 書かなかった旧 client」に割り当てる値であり、次の 2 箇所にのみ使う: `parseFormatVersion`
// の fallback（worker/src/sync.ts と client 側 src/lib/sync.js の同名関数）、および worker
// init（`POST /sync/init`）が書く bootstrap manifest の placeholder version（「version を
// 書かなかった旧 client と同じ既定値」を宣言し、client が後で pushManifest で現行 version
// へ上げる）。この worker が一度も version フィールドの存在を要求していなかった頃の値
// （＝2）のまま変えてはならない。
export const LEGACY_DEFAULT_FORMAT_VERSION = 2;
// (b) capability 宣言の有無に関わらず無条件に読み書きを許可してよい安全域の上限
// （safety ceiling）。`worker/src/sync.ts` の次の 4 箇所にのみ使う: `checkFormatCapability`
// の書き込み version ガード（`written > ceiling && written > capability`）、同関数の
// 早期 return（`remote ≤ ceiling` かつ `written ≤ ceiling`）、`checkRemoteFormatVersion`
// の `remoteVersion > ceiling` 判定、`PUT /sync/manifest` ハンドラの v2 形状検査の閾値
// （`parseFormatVersion(writtenVersion) <= ceiling`）。**2 から上げてはならない**: 上げると
// 早期 return が「remote が既に v3」の書き込みまで無検査で通してしまい、(c) の現行 version
// と混同してはならない。
export const KNOWN_SAFE_FORMAT_VERSION = 2;
// (c) この client/worker 世代が実際に読み書きできる format version。次の 3 箇所で使う:
// capability header の送信値（`src/lib/workerClient.js`）、client の読み側「remote を
// 読めるか」中止ゲート（`src/lib/sync.js` の `buildRemoteMap` / `syncAll`）、client が
// 書く manifest body の `version`（`src/lib/sync.js` の `pushManifest`）。v3 対応
// （#394 C-1）でこの値だけを 3 に上げた。(a)(b) は変えない。
export const FORMAT_CAPABILITY_VERSION = 3;
// client が capability を宣言する header 名。値と同じ理由でここに定義し、
// syncErrorCodeParity.test.js が client/worker の一致を機械検査する。
export const FORMAT_CAPABILITY_HEADER = 'X-Novel-Ide-Format-Version';

// client が分岐に使う stable な machine-readable code。**HTTP status 単体を契約にしない**
// （同じ status に複数の意味が乗りうるため。404 の repo 不在 / content 不在が典型）。
// 値は client の分岐条件そのものなので、既存 code の文字列を変えない（追加のみ）。
export const SYNC_ERROR_CODES = {
  conflict: 'sync_conflict',
  unprocessable: 'sync_unprocessable',
  forbidden: 'sync_forbidden',
  repoMissing: 'sync_repo_missing',
  manifestMissing: 'sync_manifest_missing',
  contentMissing: 'sync_content_missing',
  // repo はあり manifest は無いが entity は存在する = snapshot index だけを失った状態。
  // 「まだ何も無い」ではないので init（全件 push）へ倒してはいけない。
  workspaceInconsistent: 'sync_workspace_inconsistent',
  // remote の JSON が壊れている。client の送信内容が不正な場合の 400 と区別する。
  remoteCorrupt: 'sync_remote_corrupt',
  upstream: 'sync_upstream_error',
  server: 'sync_server_error',
  // remote manifest の formatVersion が、この client/worker が capability を宣言していない
  // 水準を超えている（#609 A-2）。GitHub upstream の status には由来しない、client 側の
  // capability 宣言（X-Novel-Ide-Format-Version）と remote の宣言を突き合わせた結果の分類。
  protocolUpgradeRequired: 'sync_protocol_upgrade_required',
  // entity write が読んだ manifest 世代から進んでいた（worker が書き込み直前に読み直した
  // manifest.sha が client の `_manifestSha` と不一致）。GitHub upstream の 409 ではなく
  // worker 自身が検出する（#609 A-2）。
  manifestStale: 'sync_manifest_stale',
  // manifest entry が持つ blob sha と entity write の `_sha` が不一致。「snapshot が指す実体」
  // 以外への上書きを防ぐ（#609 A-2）。
  entityStale: 'sync_entity_stale',
  // manifest に entry の無い id への write（create-only）で、entity が既に実在した
  // （または create-only 違反で GitHub 422 になった）。他端末が作った entity の可能性がある
  // ため無条件では上書きしない（#609 A-2）。
  entityOrphan: 'sync_entity_orphan',
  // entity write が `_manifestSha` を送っていない（旧 bundle 等、この契約を知らない client）。
  // 426 を返す点は protocolUpgradeRequired と同じだが、原因（manifest ref 未送信）を区別する
  // ため別 code にする（#609 A-2）。
  manifestRefRequired: 'sync_manifest_ref_required',
} as const;

export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[keyof typeof SYNC_ERROR_CODES];

export type SyncErrorCategory =
  | 'conflict'
  | 'unprocessable'
  | 'forbidden'
  | 'not_found'
  | 'corrupt'
  | 'upstream'
  | 'server'
  | 'protocol_upgrade_required';

// 401 はここへ来ない。ghFetch が revokeSessionIfTokenInvalid で先に HTTPException(401) を
// 投げ、KV セッション破棄と再ログイン導線（#288）を単一の入口に保っているため。
export function categorizeUpstreamStatus(status: number): SyncErrorCategory {
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'unprocessable';
  // 429（rate limit）は「待てば直る」側。server(500) に潰すと即時再試行を促してしまう。
  // 初回同期は全ファイル分の contents 往復を行うため、最も踏みやすい失敗のひとつ。
  if (status === 429) return 'upstream';
  if (status >= 500) return 'upstream';
  return 'server';
}

// remote に置かれた JSON が壊れている（decode / parse に失敗した）。client のリクエスト本文が
// 不正な場合の 400 と混ざると、利用者にも運用にも「どちら側が壊れているか」が伝わらない。
export class RemoteContentCorruptError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`remote content at ${path} is not valid JSON`);
    this.name = 'RemoteContentCorruptError';
    this.path = path;
  }
}

export class GitHubUpstreamError extends Error {
  readonly upstreamStatus: number;
  readonly category: SyncErrorCategory;
  readonly operation: string;

  constructor(upstreamStatus: number, operation: string) {
    super(`GitHub ${operation} failed with ${upstreamStatus}`);
    this.name = 'GitHubUpstreamError';
    this.upstreamStatus = upstreamStatus;
    this.category = categorizeUpstreamStatus(upstreamStatus);
    this.operation = operation;
  }
}

// client へ返す status / code / 文言。GitHub の message は転送しない（上流文言の
// そのままの露出を避け、client の分岐条件を stable code に限定するため）。
// category 集合の client parity を機械検査するため export する（syncErrorCodeParity.test.js）。
export const CATEGORY_RESPONSE: Record<
  SyncErrorCategory,
  { status: 403 | 404 | 409 | 422 | 426 | 500 | 502; code: SyncErrorCode; error: string }
> = {
  conflict: {
    status: 409,
    code: SYNC_ERROR_CODES.conflict,
    error: '他の端末の変更と競合したため同期できませんでした',
  },
  unprocessable: {
    status: 422,
    code: SYNC_ERROR_CODES.unprocessable,
    error: '同期データが GitHub に受け付けられませんでした',
  },
  forbidden: {
    status: 403,
    // GitHub の 403 は権限不足だけでなく secondary rate limit でも返る。片方に断定すると
    // 「待てば直る」状況で連携解除・再ログインへ誘導してしまう。
    code: SYNC_ERROR_CODES.forbidden,
    error: 'GitHub の権限が不足しているか、アクセス制限に達しています',
  },
  not_found: {
    status: 404,
    code: SYNC_ERROR_CODES.contentMissing,
    error: '同期先が見つかりませんでした',
  },
  corrupt: {
    status: 502,
    code: SYNC_ERROR_CODES.remoteCorrupt,
    error: '同期リポジトリのデータが壊れています',
  },
  upstream: {
    status: 502,
    code: SYNC_ERROR_CODES.upstream,
    error: 'GitHub 側でエラーが発生しました',
  },
  server: {
    status: 500,
    code: SYNC_ERROR_CODES.server,
    error: 'サーバーエラーが発生しました',
  },
  // 426 Upgrade Required。契約の本体は数値ではなく code（#609 issue 本文）。
  protocol_upgrade_required: {
    status: 426,
    code: SYNC_ERROR_CODES.protocolUpgradeRequired,
    error: 'このアプリのバージョンでは同期データを安全に書き込めません。アプリを更新してください',
  },
};

// 「repo が無い」と「manifest が無い」は client の init 突入判定に使うため、同じ 404 でも
// 別 code で返す。区別できないと、一時的な取得失敗まで初回同期へ倒れる（#608）。
// ここに置くのは「細分した不在」だけ。細分しない不在は not_found category
// （CATEGORY_RESPONSE 経由）で表現する。別名エントリを足すと、同じ応答が 2 つのテーブルから
// 引けるようになり、片側だけ書き換えて経路依存の差が出る。
export const MISSING_RESPONSE = {
  repo: { code: SYNC_ERROR_CODES.repoMissing, error: '同期リポジトリがまだありません' },
  manifest: { code: SYNC_ERROR_CODES.manifestMissing, error: '同期 manifest がまだありません' },
  workspaceInconsistent: {
    code: SYNC_ERROR_CODES.workspaceInconsistent,
    error: '同期 manifest が失われています（同期データは残っています）',
  },
} as const;

// entity write が worker 自身の検出（GitHub upstream の応答ではなく、manifest との突き合わせ）
// で拒否する 409。CATEGORY_RESPONSE は category ごとに 1 code しか持たないため、conflict
// カテゴリ内で code を区別する必要があるここだけ専用テーブルにする（MISSING_RESPONSE と同型）。
export const CONFLICT_RESPONSE = {
  manifestStale: {
    code: SYNC_ERROR_CODES.manifestStale,
    error: '同期 manifest が他の端末により更新されています。再読み込みしてください',
  },
  entityStale: {
    code: SYNC_ERROR_CODES.entityStale,
    error: '他の端末の変更と競合したため同期できませんでした',
  },
  entityOrphan: {
    code: SYNC_ERROR_CODES.entityOrphan,
    error: '他の端末が作成したデータと競合したため同期できませんでした',
  },
} as const;

// entity write が `_manifestSha` を送っていない（旧 bundle）。426 の応答本文は
// CATEGORY_RESPONSE.protocol_upgrade_required と揃えるが code だけ区別する。
export const PROTOCOL_UPGRADE_RESPONSE = {
  manifestRefRequired: {
    code: SYNC_ERROR_CODES.manifestRefRequired,
    error: CATEGORY_RESPONSE.protocol_upgrade_required.error,
  },
} as const;
