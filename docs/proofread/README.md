# 校正機能 設計概要（issue #95）

> **MVP 段階での扱いは [docs/MVP_PLAN.md](../MVP_PLAN.md) が正。** 本ドキュメント群は実装詳細（API・ルール・永続化）であり、Phase 番号は実装順であって MVP 段階ではない（[#242](https://github.com/clockcrockwork/novel-ide/issues/242)）。
> - **MVP Alpha**：校正なし・辞書生成なし・外部 API なし（スタイルルールチェックは Alpha 対象）
> - **MVP Beta**：作品から辞書生成・ユーザー辞書管理・辞書 Git 同期・ローカル校正・結果表示
> - **MVP Gamma**：外部 API 校正（Yahoo/Gemini）・API キー管理・送信前確認・送信範囲制御・結果正規化
> - **MVP Delta 以降**：LLM 校正・文脈校正・設計カード照合・矛盾検知
>
> 「スタイルルール」と「校正」の用語定義は [docs/design/writing-check-policy.md](../design/writing-check-policy.md) を参照。

詳細は各ドキュメントを参照：

| ドキュメント | 内容 |
|------------|------|
| [SOURCES.md](SOURCES.md) | 校正ソース別 API 設計・セキュリティ方針 |
| [RULES.md](RULES.md) | ルールエンジン・ユーザー定義ルール・textlint |
| [STORAGE.md](STORAGE.md) | 永続化・クロスデバイス同期戦略 |

---

## アーキテクチャ

```
[WriteMode テキスト変更]
        ↓ debounce (2s) / 手動トリガー
[ProofreadQueue（非同期キュー、src/lib/proofreadQueue.js）]
    ├─ チャンク分割（ソース別サイズ: ローカル/Yahoo 500字・LLM 2000字）
    ├─ LocalRulesWorker（Web Worker、src/workers/proofreadWorker.js）
    │     ↑ オフライン動作・即時
    ├─ POST /api/proxy/yahoo（Cloudflare Worker プロキシ）
    │     ↑ ユーザーの Yahoo Client ID は Worker KV に保管
    └─ POST /api/proxy/gemini（Cloudflare Worker プロキシ）
          ↑ ユーザーの Gemini API Key は Worker KV に保管
        ↓ チャンクごとにストリーミング
[ProofreadStore（Zustand、src/stores/proofreadStore.js）]
    └─ 全結果確定後 → Cloudflare KV（クロスデバイス）+ IndexedDB（オフラインキャッシュ）
        ↓ TipTap Editor へ setMeta
┌──────────────────────────────────┐
│ ProofreadExtension               │  エディタ内背景色ハイライト
│（src/lib/tiptap/ProofreadExtension.js）│
└──────────────────────────────────┘
        ↓
┌──────────────────────────────────┐
│ ProofreadMod（サイドバー）       │  件数バッジ・一覧・ジャンプ・置換・無視
└──────────────────────────────────┘
```

---

## データ構造（共通）

```ts
interface ProofreadIssue {
  id: string;                                         // nanoid
  fileId: string;
  from: number;                                       // ProseMirror position
  to: number;
  severity: 'error' | 'warn' | 'info' | 'suggestion';
  ruleId: string;
  message: string;
  suggestion?: string;
  source: 'local' | 'yahoo' | 'gemini' | string;    // カスタムソース対応
  ignored?: boolean;                                  // 「無視」フラグ
  anchorText?: string;                                // 指摘箇所の前後テキスト（±20字）。読込時の re-anchor に使用
  chunkIndex?: number;
}

// IndexedDB + KV 保存単位
interface ProofreadRecord {
  fileId: string;
  docHash: string;           // 保存時点のドキュメント内容ハッシュ（re-anchor 用）
  issues: ProofreadIssue[];
  runAt: number;
  sources: string[];
}
```

---

## フェーズ計画

| Phase | 内容 |
|-------|------|
| 1 | proofreadWorker + proofreadWorkerClient（diffWorker パターン流用） |
| 2 | ProofreadStore（Zustand）+ ProofreadExtension（背景色ハイライト） |
| 3 | ProofreadMod 刷新（ジャンプ・置換・ソース別タブ・VirtualList） |
| 4 | IndexedDB 永続化（`proofread_results` ストア） |
| 5 | チャンク非同期キュー + 外部 API 向け確認 UI・残量表示 |
| 6 | Cloudflare Worker プロキシ（Yahoo・Gemini）+ KV キー管理 UI |
| 7 | Cloudflare KV による校正結果のクロスデバイス同期 |
| 8 | ユーザー定義ローカルルール管理 UI（Git 連携含む） |
| 9 | カスタム API プロバイダー設定（OpenAI 互換エンドポイント等） |
| 10a | textlint 統合（kuromoji 不要の軽量ルール先行） |
| 10b | textlint 統合（形態素解析ルール・kuromoji） |

---

## 非同期処理中のドキュメント変更への対処

外部 API はチャンク送信から結果受信まで数秒かかる。その間にユーザーが編集すると、
返ってきた `from/to` が現在のドキュメント座標と一致しなくなる。

**実装方針**：

```js
// Phase 5（ProofreadQueue 実装時）
// チャンクごとに個別の Mapping + 送信時スナップショットを管理（並行リクエスト対応）
// Plugin 状態: Map<requestId, { mapping, snapshotDoc, chunkStartPos }>
const pendingMappings = new Map();

// 1. チャンク送信時（送信時点の doc と chunkStartPos をスナップショットとして保持）
const requestId = nanoid();
pendingMappings.set(requestId, {
  mapping: new Mapping(),
  snapshotDoc: state.doc,          // charOffsetToPos の基準ドキュメント
  chunkStartPos,                   // チャンク開始 ProseMirror position
});

// ※ 以降、API 結果を受信するまでの全トランザクションで下記を実行（Plugin の appendTransaction 等で）:
//    for (const entry of pendingMappings.values()) entry.mapping.appendMapping(tr.mapping);

// 2. API レスポンス受信後
const { mapping, snapshotDoc, chunkStartPos: snapStart } = pendingMappings.get(requestId);
pendingMappings.delete(requestId);

// charOffsetToPos はスナップショット時点の snapshotDoc を使う。
// 送信後に doc が変化しても変換の基準は変わらない（Mapping が変化を吸収する）。
const from = mapping.map(charOffsetToPos(snapshotDoc, snapStart, issue.from_char));
const to   = mapping.map(charOffsetToPos(snapshotDoc, snapStart, issue.to_char));
```

- `state.tr.mapping` は直前の1トランザクション分しか保持しないため、非同期処理中に複数の編集が発生するケースをカバーできない
- 並行チャンク送信時は各リクエスト ID をキーとした `Map<requestId, Mapping>` で個別に追跡する（全チャンクで同じ Mapping を共有しない）
- `from_char`（チャンクテキスト内文字オフセット）は ProseMirror position と単純加算できない。段落ノード等の重みを考慮した `charOffsetToPos(snapshotDoc, startPos, charOffset)` 変換ユーティリティを Phase 5 で実装する（`snapshotDoc` は送信時のスナップショット）
- 座標変換後に `from === to`（挿入点に縮退）になった issue は `ignored` フラグを立てて非表示にする
- **クリーンアップ**: ネットワークエラーやタイムアウト時に `pendingMappings` のエントリを解放しないとメモリリークになる。`catch` ブロックで `pendingMappings.delete(requestId)` を必ず実行し、送信から一定時間（例: 60s）経過したエントリも `setTimeout` で強制削除する

---

## 未決事項

1. **チャンク座標変換の精度（Phase 5 実装時）**: `from_char`（チャンクテキスト内文字オフセット）から ProseMirror position への変換は `charOffsetToPos` ユーティリティで行う。段落ノードの重み（開始・終了で各 1 position）を考慮し、段落をまたぐチャンクでは結合テキストと各ノードの対応表を保持する必要がある
2. **永続化座標の re-anchor（Phase 4/7 実装時）**: `ProofreadRecord` に `docHash` と各 issue の `anchorText`（前後 ±20 字）を保存する。別デバイスで読み込んだ際にドキュメントハッシュが不一致なら `anchorText` でテキスト検索し、現在の座標に再マッピングする
3. **Gemini 無料枠枯渇の UX**: 250 RPD 到達時に翌日まで待機案内 or 有料枠ガイドを表示
4. **モバイル対応（#53 連携）**: ハイライトのタッチターゲット確保
5. **textlint と既存ルールエンジンの統合度**: 独立した追加ソースとして扱うか Phase 10 完了後に判断
