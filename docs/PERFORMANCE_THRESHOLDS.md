# パフォーマンス閾値一覧

コードベース内のパフォーマンス・品質に影響するハードコード値を集約する。
新しい閾値を追加・変更する際はこのファイルを更新すること。

> **関連レビュー項目**: `docs/REVIEW_GUIDELINES.md § パフォーマンス閾値（マジックナンバー）`

---

## diff エンジン (`src/lib/diffCore.js`)

| 値 | 用途 | 根拠 |
|----|------|------|
| `maxEditDistance = 5000` | Myers diff の最大編集距離。超過時は coarseFallback に切り替え | 実測で 5000 編集距離を超える diff は ほぼ全文書差し替えに等しく Myers の意味がない |
| `maxTimeMs = 64` | Myers diff の実行時間上限 (ms)。超過時は coarseFallback に切り替え | 64ms ≈ 4フレーム (60fps)。Worker 内で実行するため多少余裕を取っている。16ms (1フレーム) より緩い |
| `snakeSteps & 127` | `now()` を 128 ステップに 1 回だけ呼ぶためのビットマスク | `performance.now()` の呼び出しコスト削減。128 は 2 の累乗で AND 演算が安価 |
| `LOOKAHEAD = 24` | coarseFallback の先読みウィンドウ幅 (行数) | 経験値。24 行を超える連続挿入/削除は全置換として扱う。大きくすると O(n) の定数が増える |

**相互依存**: `maxTimeMs` は `diffWorkerClient.js` の `workerTimeoutMs` より十分小さくなければならない。
現状: 64ms (Myers) ≪ 30,000ms (Worker タイムアウト)。

---

## diff Worker クライアント (`src/lib/diffWorkerClient.js`)

| 値 | 用途 | 根拠 |
|----|------|------|
| `workerTimeoutMs = 30000` | Worker 応答待機の上限 (30秒)。超過時は Worker を破棄してフォールバック | ユーザーが気づく前に応答する上限として 30 秒を設定。通常は diffCore の 64ms 制限内に収まる |

---

## 執筆ルール拡張 (`src/lib/tiptap/WritingRulesExtension.js`)

| 値 | 用途 | 根拠 |
|----|------|------|
| `requestIdleCallback timeout: 1500` | ブラウザがアイドルにならない場合の強制実行タイムアウト (ms) | 旧値 500ms では高速連打中（issue #138）に rIC が強制実行されて longtask が発生していた。1500ms は「入力が止まるまでルール適用を遅らせる」意図。通常の入力停止後はアイドル時間内に実行される |
| `setTimeout fallback: 200` | `requestIdleCallback` 非対応ブラウザでの代替遅延 (ms) | アイドル機構がないブラウザ向けの妥協値。小さすぎると入力中に重い、大きすぎると遅延が目立つ |
| 範囲バッファ `± 500` doc positions | diff から計算した変更範囲の前後に加えるパディング | 500 positions ≒ 段落数行分のマージン。変更位置に隣接するブロックも捕捉するための余裕 |

**注意**: ここでの「500」は行番号閾値 (`EditorBox.jsx`) の「2000行」とは無関係。混同しないこと。

---

## IDB 書き込み debounce (`src/context/AppContext.jsx`)

| 値 | 用途 | 根拠 |
|----|------|------|
| `idbDebounceMs = 500` | ファイル内容変更の IDB 書き込みを遅延させる時間 (ms) | キーストロークごとの IDB 連打（issue #138）を解消する最小値。500ms は「入力停止後に確実に保存できる」基準として設定。ページ離脱時（beforeunload / pagehide / visibilitychange）は即時 flush してデータロストを防ぐ |

---

## localStorage キャッシュ debounce (`src/lib/lsCache.js`)

| 値 | 用途 | 根拠 |
|----|------|------|
| `DEBOUNCE_MS = 300` | Zustand persist ミドルウェアが使う localStorage 書き込みの debounce 時間 (ms) | UI 設定の変更（テーマ切替など）はキーストロークより低頻度。300ms は IDB debounce (500ms) より短く、UI 設定の反映遅延を体感させない最小値 |

---

## エディタ (`src/components/editor/EditorBox.jsx`)

| 値 | 用途 | 根拠 |
|----|------|------|
| `count > 2000` (行数) | この行数超で行番号ガターの DOM 生成を省略 | 2000行 ≈ 40字/行 × 2000 = 80,000字。#37 の問題は 50,000字 なので 1,250行相当。余裕を見て 2000行を上限とした |
| `LARGE_DOC_SERIALIZE_THRESHOLD = 50000` | `editor.state.doc.content.size`（ProseMirror position 単位）がこの値を超えると serialize を leading+trailing throttle に切り替える | 5万 positions ≒ 数万文字。平均的な小説の 1 章相当（20〜30KB）が目安。この規模を超えるとキーストローク毎の serialize が体感 INP 遅延に繋がることを実測で確認 |
| `SERIALIZE_THROTTLE_MS = 64` | 大ドキュメント serialize の throttle 間隔 (ms)。leading+trailing 方式で窓の先頭と末尾で必ず 1 回実行 | 64ms ≈ 4フレーム (60fps)。diffCore の `maxTimeMs = 64` と同値で揃えることで直感的な整合性を維持。16ms（1フレーム）より緩めることで連続入力中の serialize 回数を削減しつつ、窓の先頭 leading serialize で `filesRef` を即時更新し stale 同期を防ぐ |

**相互依存**: `SERIALIZE_THROTTLE_MS` は IDB debounce (`idbDebounceMs = 500`) より十分小さくなければならない。
現状: 64ms (throttle) ≪ 500ms (IDB debounce)。

**関連 issue**: #37

---

## 仮想化 (`src/components/common/VirtualList.jsx`)

| 値 | 用途 | 根拠 |
|----|------|------|
| `overscan = 3` | 可視範囲外に事前レンダリングするアイテム数 | virtua のデフォルト。スクロール時の白飛びを防ぐ最小限の先読み数 |
| `HEADING_VIRTUALIZE_THRESHOLD = 50`（`HeadingJumpMod.jsx`） | 見出しジャンプリストをこの件数超で VirtualList（高さ制限スクロール）に切替。以下は素の map でインライン表示 | サイドバーモジュールは内容に応じて伸長する（高さ非固定）ため、常時仮想化すると見出し数が少ない通常ケースで固定高スクロール箱ができ UX が劣化する。50 件までは DOM 直描画が十分軽く、超えたら仮想化に倒す。長編の章/シーン見出しが数十〜数百件になるケースを救う |

---

## Worker rate limit / body size (`worker/src/rateLimit.ts`, `worker/src/sync.ts`, `worker/src/github-proxy.ts`)

| 値 | 用途 | 根拠 |
|----|------|------|
| `limit: 10, windowMs: 60_000` | auth エンドポイント（`/auth/github/start`・`/auth/github/callback`）IP rate limit | OAuth リクエストは通常 1 回 / 操作。10回/分はブルートフォースを防ぎながら正常操作を妨げない最小値 |
| `limit: 60, windowMs: 60_000` | `/auth/refresh`・`/auth/logout` IP rate limit | 純 IP ベース。KV lookup なしで DoS リスクを排除。NAT 配下の複数ユーザーを考慮して 60回/分に設定 |
| `limit: 600, windowMs: 60_000` | `/sync/*` セッション rate limit | バルク初期同期のリクエスト数は 2N+4（manifest GET + init POST + N×GET + N×PUT + manifest PUT + devices PUT）。200 ファイルで 404 リクエストとなり 600 の上限内に収まる |
| `limit: 60, windowMs: 60_000` | `/github/*` セッション rate limit | GitHub API のデフォルト rate limit (5000回/h) の約 1/80。Worker 経由の乱用を防ぐ上限として設定 |
| `bodySize: 2 * 1024 * 1024` (2 MB) | `/sync/*` write エンドポイントのリクエストボディ上限 | アプリ側 `FILE_CONTENT_MAX = 5_000_000` chars との整合性確保。日本語 UTF-8 は 3 bytes/char のため 2MB ≈ 666K 字を許容。512KB (≈ 170K 字) では大きなファイルが 413 で同期不能になることを受け引き上げ |
| `bodySize: 5 * 1024 * 1024` (5 MB) | `/github/*` write エンドポイントのリクエストボディ上限 | GitHub Contents API の制限（100 MB）より大幅に小さく、誤送信・DoS を防ぐ実用的な上限 |

---

## pull / remote データ検証 (`src/lib/security/validatePulledContent.js`)

| 値 | 用途 | 根拠 |
|----|------|------|
| `OVERSIZE_WARN_CHARS = 1_000_000` | pull した本文がこの文字数を超えると警告（拒否ではなく toast）。`FILE_CONTENT_MAX = 5_000_000` 超で拒否 | GitHub contents API の 1MB 上限に整合。直接 pull は API 側で 1MB に制限されるが、sync 経路（worker 経由）は API 上限がないためクライアント側の警告境界として設定。日本語 1 文字 ≈ 3 bytes のため 100 万字 ≈ 3MB 相当 |
| `BINARY_SAMPLE_LIMIT = 65536` | バイナリ判定で走査する先頭 code unit 数の上限 | 巨大入力での O(n) 全走査による DoS を避けるための境界。先頭 64K でバイナリ特徴（null byte・制御文字比率）は十分に検出できる。`detectBinary` はエディタ起動境界で content 変化ごとに呼ばれるため、走査範囲を固定して毎キーストロークのコストを一定に保つ |

**相互依存**: `FILE_CONTENT_MAX`（拒否）> `OVERSIZE_WARN_CHARS`（警告）の順序を保つこと。pull 時に 1 回だけ走査して `file.security` に保存し、preview / エディタ / export は再走査せずメタデータを参照する（#285）。

---

## モバイル viewport (`src/hooks/useViewportFooter.js`)

| 値 | 用途 | 根拠 |
|----|------|------|
| `KEYBOARD_THRESHOLD = 120` | `keyboard-open` CSS クラスを付与するキーボード高さの最小値 (px)。`off > KEYBOARD_THRESHOLD` で判定 | iPhone 15 の画面高は 844px。ソフトウェアキーボードは通常 300px 超。120px は「誤検知しない最小マージン」として設定。アドレスバーの収縮（約 50px）やフローティング入力補助（約 45px）ではトリガーされない |

---

## スタイルルールチェック (`src/lib/styleRules/rules/style.js`)

| 値 | 用途 | 根拠 |
|----|------|------|
| `LONG_SENTENCE_THRESHOLD = 120` | 1 段落（改行区切り）がこの文字数を超えると suggestion を出す（`style/long-sentence`） | 日本語の一段落の目安は 200 字以内といわれるが、小説文体では 60〜80 字が多い。120 字を境界として読みにくさが顕在化する経験的な上限値。デフォルト OFF ルールのため、ユーザーが ON にしない限り動作しない |

---

## agent-memory CLI (`scripts/agent-memory.js`)

| 値 | 用途 | 根拠 |
|----|------|------|
| `MAX_RECORD_BYTES = 1 MiB` | 記憶レコード 1 ファイルの受理上限。超過は fail-loud（読込拒否） | 1 記憶は数 KB 想定。巨大ファイルは OOM/DoS 防止で拒否する（信頼境界外入力） |
| `MAX_DOC_SCAN_BYTES = 1 MiB` | `revise` の旧 id 参照走査（docs/ 配下）で読み込むファイルの上限。超過は note を出して skip（非ブロッキング） | 走査は best-effort の警告用途で、巨大ファイル（実測: `docs/pr-analysis/detailed-items.json` 1.4MB）の全読みはコストに見合わない。skip は stderr の note で可視化される。`MAX_RECORD_BYTES` とは用途が異なる独立の閾値（レコード受理上限を変えても走査範囲が黙って変わらないよう分離） |

---

## チェック観点

新しい閾値を追加・変更するとき、以下を確認する。

- [ ] **重複・矛盾がないか**: 同じ概念を複数箇所で別の値で制御していないか
  - 例: WritingRules のバッファ 500 positions と、ガター閾値 2000行 は別の次元の値であり矛盾しない
  - 例（矛盾の例）: `maxTimeMs = 64` が `workerTimeoutMs` を超えると Worker が先にタイムアウトして Myers が完走できない
- [ ] **根拠があるか**: 計測結果・フレームレート計算・既知の問題番号などで説明できるか
- [ ] **このファイルを更新したか**: 新しい閾値を追加したら必ずここに記載する
