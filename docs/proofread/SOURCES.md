# 校正ソース別設計・セキュリティ方針

## API キーのセキュリティ方針

### 問題：ブラウザ内 API キー保存のリスク

IndexedDB を含むブラウザストレージは DevTools から平文で読み取れる。
Gemini API Key は課金に直結するため、ブラウザに置いてはならない。
Yahoo Client ID は無料サービスだが、レートリミット悪用のリスクがある。

### 解決策：Cloudflare Worker プロキシ（既存 Worker を拡張）

```
Browser → POST /api/proxy/gemini  (with session cookie)
              ↓
         [requireSession]   ← GitHub 認証済みセッション確認
              ↓
         KV.get(`apikey:${login}:gemini`)  ← 暗号化済みキーを取得
              ↓
         Gemini API endpoint
              ↓
         Browser (結果のみ返却)
```

- ブラウザ側は **ユーザーのテキストデータ** だけを送信し、API キーは一切触らない
- キーは Worker の KV に保存され、Cloudflare 側で暗号化される
- セッション (`requireSession`) で認証済みユーザーのキーのみ使用

### キー登録フロー

1. ユーザーが設定画面で API キーを入力
2. `PUT /api/user-settings/keys/:provider` → Worker が `KV.put("apikey:${login}:gemini", key)` に保存
3. ブラウザ側のキャッシュ（IndexedDB）には **「登録済み」フラグのみ** 保存（実キーは保存しない）

### Yahoo と Gemini の違い

| | Yahoo Client ID | Gemini API Key |
|---|---|---|
| 課金リスク | なし（無料） | あり（従量課金） |
| 推奨保管場所 | Worker KV（推奨）または IndexedDB（許容） | Worker KV 必須 |
| 漏洩時の影響 | レートリミット枯渇（自分のみ） | 意図しない課金 |

Yahoo は直接呼び出しも許容するが、統一性・将来の有料オプション対応のため Worker プロキシを推奨。

---

## Cloudflare Worker 拡張ルート（worker/src/）

### 追加するルート

```ts
// worker/src/apiProxy.ts

// GET /api/user-settings/keys  → 登録済みキーの一覧（フラグのみ）
// PUT /api/user-settings/keys/:provider  → キー登録
// DELETE /api/user-settings/keys/:provider  → キー削除

// POST /api/proxy/yahoo  → Yahoo 校正 API プロキシ
// POST /api/proxy/gemini  → Gemini API プロキシ
// POST /api/proxy/custom/:name  → カスタムプロバイダープロキシ（Phase 9）
```

### worker/src/types.ts への追加

```ts
export type Bindings = {
  SESSIONS: KVNamespace;
  USER_SETTINGS: KVNamespace;   // 追加：ユーザー設定・APIキー保管
  PROOFREAD_RESULTS: KVNamespace;  // 追加：クロスデバイス校正結果
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGIN: string;
};
```

---

## ローカルルールエンジン

**ファイル**: `src/workers/proofreadWorker.js` + `src/lib/proofreadWorkerClient.js`

`diffWorker.js` / `diffWorkerClient.js` と同パターン（requestId + postMessage + Promise）を採用する。

### 組み込みルール

| ruleId | 説明 | severity |
|--------|------|----------|
| `duplicate_punct` | 読点・句点（、。，．）の連続 | warn |
| `long_sentence` | 120字超の文 | info |
| `repeated_char` | 同一文字（ひらがな・カタカナ・漢字）の3連続以上 | warn |
| `double_space` | 全角スペースの重複 | info |
| `mixed_bracket` | 「」と""の混在 | info |
| `missing_period` | セリフ末尾（」）の直前に句読点なし | info |

起動時に IndexedDB `proofread_rules` からユーザー定義ルールをロードし、組み込みルールと合わせて適用する。

---

## Yahoo 校正支援 API

**クライアントファイル**: `src/lib/proofreadSources/yahoo.js`

```js
// Worker プロキシ経由（推奨）
await fetch('/api/proxy/yahoo', {
  method: 'POST',
  body: JSON.stringify({ text: chunk }),
  credentials: 'include',          // セッション Cookie
});

// Yahoo API 仕様（Worker 内で実行）
// エンドポイント: https://jlp.yahooapis.jp/KouseiService/V2/kousei
// リクエスト: JSON-RPC 2.0
// 利用制限: 300 req/min / 100kB/req
// キュー間隔: 最短 250ms（理論値 200ms より余裕を持つ）
// 429 発生時: Worker はそのままクライアントに 429 を返す。
//             ブラウザ側の ProofreadQueue が再試行タイミングを制御する（Worker 実行時間制限を考慮）
```

Client ID の取得先: [Yahoo! Developer Network](https://developer.yahoo.co.jp/)（無料）

---

## Gemini API

**クライアントファイル**: `src/lib/proofreadSources/gemini.js`

```js
// Worker プロキシ経由（必須）
await fetch('/api/proxy/gemini', {
  method: 'POST',
  body: JSON.stringify({ text: chunk }),  // プロンプトは Worker が KV から取得
  credentials: 'include',
});

// Gemini API 仕様（Worker 内で実行）
// モデル: gemini-2.5-flash
// 構造化出力: responseMimeType: "application/json" + responseSchema（型安全性のため必須）
// 無料枠: 10 RPM / 250 RPD（2026年現在）
// キュー間隔: 最短 6,000ms（10 RPM = 6秒/リクエスト。Yahoo の 250ms とは別個に管理）
// チャンクサイズ: 2,000字（LLM のコンテキスト効率を優先し Yahoo の 500字より大きく設定）
// 429 発生時: Worker はそのままクライアントに 429 を返し、ProofreadQueue が指数バックオフで再試行
```

API Key の取得先: [Google AI Studio](https://aistudio.google.com/)（無料）

### デフォルトプロンプト（設定から確認・編集可能）

```
以下の日本語テキストを校正してください。
誤字脱字・表記ゆれ・不自然な表現を検出し、次の JSON 配列で返してください。
問題がない場合は [] を返してください。

[{
  "from_char": <0始まりの開始文字位置>,
  "to_char": <終了文字位置（exclusive）>,
  "severity": "error" | "warn" | "info" | "suggestion",
  "message": "<説明>",
  "suggestion": "<修正候補（任意）>"
}]

テキスト:
{{TEXT}}
```

プロンプトは Worker KV の `prompt:{login}:gemini` キーに保存し、
設定モーダルの「校正」タブで確認・編集・リセット可能。
Worker は `/api/proxy/gemini` リクエスト処理時に KV から読み取る（ブラウザ送信不要）。

### responseSchema 定義（Worker 内で使用）

`responseMimeType: "application/json"` だけでは出力型の保証が弱いため、
`responseSchema` を併用して `ProofreadIssue[]` と一致するスキーマを指定する：

```js
const responseSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      from_char:  { type: 'integer' },
      to_char:    { type: 'integer' },
      severity:   { type: 'string', enum: ['error', 'warn', 'info', 'suggestion'] },
      message:    { type: 'string' },
      suggestion: { type: 'string' },
    },
    required: ['from_char', 'to_char', 'severity', 'message'],
  },
};
```

---

## カスタム API プロバイダー（Phase 9）

ユーザーが任意の OpenAI 互換エンドポイントを追加できるよう拡張する。

```ts
interface CustomProofreadProvider {
  name: string;           // 表示名（例: "ローカル LLM"）
  endpoint: string;       // OpenAI 互換エンドポイント URL
  authType: 'bearer' | 'api-key' | 'none';
  model: string;          // 使用するモデル名
  promptTemplate: string; // {{TEXT}} プレースホルダーを含むプロンプト
  enabled: boolean;
}
```

- 設定を Worker KV の `custom_providers:${login}` に保存
- Worker が `/api/proxy/custom/:name` でプロキシ実行
- 対象: Ollama（ローカル LLM）・Groq・OpenAI・Azure OpenAI 等

### SSRF 対策（Worker 側の必須バリデーション）

ユーザーが任意の URL を指定できるため、Worker プロキシが悪意あるエンドポイントへのリクエストを中継する SSRF リスクがある。実装時は以下を Worker 側で必ず検証する：

- `https://` スキームのみ許可（`http://` は拒否）
- プライベート IP アドレス・ループバック・特殊用途アドレスへのアクセスを禁止
  - IPv4: `127.0.0.0/8`（ループバック）、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`（プライベート）
  - IPv4: `169.254.0.0/16`（Link-Local 全体）、`100.64.0.0/10`（Shared Address Space / CGNAT）
  - IPv6: `::1`（ループバック）、`fc00::/7`（Unique Local）、`fe80::/10`（Link-Local）
  - IPv6: `::ffff:0:0/96`（IPv4 射影アドレス。IPv4 プライベートレンジへのフィルタリング回避に悪用される可能性あり）
- ホスト名のブロックリスト照合: `localhost`、`metadata.google.internal`（GCP）、`169.254.169.254`（AWS / クラウドメタデータ）等の内部向けホスト名を拒否
- DNS リバインディング対策: `hostname` の静的チェックに加え、可能であれば fetch 後のレスポンス送信元 IP も検証する（Cloudflare Worker の実装制約に応じて判断）
- URL パースは `new URL(endpoint)` で行い、`hostname` を検査する

---

## 実施タイミング・消費コントロール

| ソース | デフォルト挙動 | 設定変更 |
|--------|--------------|--------|
| ローカルルール | debounce 2s 自動実行 | 自動 on/off・間隔調整 |
| Yahoo | 手動トリガーのみ | 設定で自動実行 + 事前確認に変更可 |
| Gemini | 手動トリガーのみ | 設定で自動実行 + 事前確認に変更可 |
| カスタム | 手動トリガーのみ | 同上 |

### 実施前確認ダイアログ

設定 `proofread_confirm_before_external: boolean`（デフォルト: `true`）:

```
Yahoo 校正 API を実行します
送信: 約3チャンク（1,240文字）
消費: 3回 / 残り 297回（今分）
[実行する]  [キャンセル]
```

Gemini の場合は残 RPM / 本日の残 RPD も表示する。
クォータ到達時はソースボタンを無効化してエラーメッセージを表示。

---

## エディタ内デコレーション

波線はレイアウト崩れの懸念があるため、**背景色ハイライト方式**を採用する。
`AnnotationExtension.js` と同パターン（ProseMirrorPlugin + DecorationSet）で実装する。
校正専用4色は手動マーカーの選択肢と独立させる。

```js
// src/lib/tiptap/ProofreadExtension.js
export const PROOFREAD_COLORS = {
  error:      'oklch(.55 .18 25 / 0.35)',
  warn:       'oklch(.72 .14 75 / 0.35)',
  info:       'oklch(.70 .10 220 / 0.35)',
  suggestion: 'oklch(.70 .12 155 / 0.35)',
};
// 実装時の注意: ライト/ダーク両テーマで、テキスト色とこれらの背景色が
// エディタ背景色と合成された実効背景色とのコントラスト比が WCAG AA（4.5:1）を
// 満たすことを確認する。アルファ値 0.35 は薄いため、特にライトテーマで要注意。

Decoration.inline(from, to, {
  class: 'pf-hl',
  style: `background:${PROOFREAD_COLORS[issue.severity]}`,
  'data-pf-id': issue.id,
});
```

クリック時に `data-pf-id` を読み取り、サイドバーの該当 issue をスクロール。
