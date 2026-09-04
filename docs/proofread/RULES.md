# ルールエンジン・ユーザー定義ルール・textlint

## ユーザー定義ローカルルール

### データ構造

```ts
// IndexedDB ストア: proofread_rules / Git: .novel-rules/proofread-rules.json
interface UserProofreadRule {
  id: string;
  enabled: boolean;
  severity: 'error' | 'warn' | 'info' | 'suggestion';
  type: 'regex' | 'string';
  pattern: string;
  message: string;
  suggestion?: string;      // regex の場合は $1 等の後方参照可
  tags?: string[];          // カテゴリ分類（例: ['表記ゆれ', 'キャラクター名']）
  createdAt: number;
  updatedAt: number;
}
```

### 保存先・同期戦略

ユーザー定義ルールはローカルだけでなく、**GitHub リポジトリに保存**することで
クロスデバイス同期・バージョン管理・チーム共有が可能になる。

```
優先度（高）→ Git リポジトリ（.novel-rules/proofread-rules.json）
優先度（低）→ IndexedDB（オフライン時のローカルキャッシュ）
```

#### Git リポジトリへの保存フロー

```
[設定 UI でルール追加・変更]
        ↓
IndexedDB に即時保存（オフライン対応）
        ↓（GitHub 連携が有効かつオンライン時）
GET /github/{owner}/{repo}/contents/.novel-rules/proofread-rules.json
→ PUT（Base64 エンコードした JSON を commit）
        ↓
他デバイスは次回起動時 or 手動同期でリポジトリから読み込む
```

- `src/lib/github.js` の既存 Contents API ラッパーを使用
- ファイルが存在しない場合は新規作成
- コミットメッセージ: `chore: update proofread rules`（CI が設定されている場合は `[skip ci]` を付与）

#### JSON エクスポート/インポート

- エクスポート: `proofread-rules-YYYYMMDD.json` としてダウンロード
- インポート: ファイル選択 → プレビュー → 既存ルールとマージ or 上書き
- 用途: バックアップ・他ユーザーへのルール配布・プロジェクト間移動

### 管理 UI（`src/components/sidebar/ProofreadRulesMod.jsx`）

- ルール一覧（有効/無効トグル・編集・削除）
- 追加フォーム（パターン種別・重大度・メッセージ・置換候補・タグ）
- 校正結果から「このパターンをルール化」ボタン（逆引き登録）
  - 選択されたテキストの文字列 or 正規表現パターンを自動入力
- JSON エクスポート/インポートボタン
- Git 同期ステータス表示（「リポジトリと同期済み」「未同期の変更 3件」）

---

## textlint 調査・統合検討

### textlint とは

[textlint](https://github.com/textlint/textlint) は JavaScript 製のテキスト校正フレームワーク。
ブラウザでの動作は `@textlint/script-compiler` でルールと設定を Web Worker にバンドルする形で実現する
（[textlint editor](https://efcl.info/2021/05/27/textlint-12-editor/) として 2021年にベータリリース）。

### 日本語向け主要ルール・プリセット

#### `textlint-rule-preset-japanese`（汎用）

一般的な日本語文章向けの基本ルールセット。

| ルール名 | 説明 | 小説での有用性 |
|---------|------|------------|
| `no-mix-dearu-desumasu` | 「だ・である」調と「です・ます」調の混在検出 | ★★★（地の文と会話文で設定が異なる） |
| `no-dropping-the-ra` | ら抜き言葉の検出（「見れる」→「見られる」） | ★★★ |
| `no-doubled-joshi` | 同一文内での助詞の重複（「〜を…を」） | ★★★ |
| `no-doubled-conjunction` | 接続詞の連続使用（「そして、そして」） | ★★ |
| `no-double-negative-ja` | 二重否定の検出 | ★★ |

#### `textlint-rule-preset-ja-technical-writing`（技術文書向け）

JTF スタイルガイド準拠。技術文書向けのため、**小説にはそのまま適用しない**が、
個別ルールを選択的に有効化することで有用なものもある。

| ルール名 | 説明 | 小説での採用可否 |
|---------|------|--------------|
| `sentence-length` | 文の長さ制限（デフォルト: 100字） | ◯（120〜150字に調整） |
| `max-ten` | 読点の最大数（デフォルト: 3） | ◯（4〜5に調整） |
| `no-exclamation-question-mark` | 感嘆符・疑問符の禁止 | ✕（小説には不要） |
| `ja-no-mixed-period` | 句点の統一（「。」か「．」か） | ◯ |
| `no-doubled-conjunctive-particle-ga` | 逆接「〜が、〜が」の連続 | ◯ |

#### `textlint-rule-ja-no-abusage`（誤用チェック）

よくある日本語の誤用パターンをチェック。形態素解析ベース。

例: 「煮詰まる」「確信犯」「役不足」「敷居が高い」の誤用

小説での有用性: ★★（誤用の誤用という場合もある。重大度を `info` に設定推奨）

#### その他の注目ルール

| パッケージ名 | 説明 |
|------------|------|
| `textlint-rule-spellcheck-tech-word` | 技術用語スペルチェック（固有名詞に応用可） |
| `textlint-rule-ja-no-successive-word` | 同じ単語の連続使用（「彼は彼の…」） |
| `textlint-rule-period-in-list-item` | リスト末尾の句点統一 |

### 小説向け推奨設定例（将来参考）

```json
{
  "rules": {
    "no-mix-dearu-desumasu": {
      "preferInBody": "である",
      "preferInList": "である",
      "strict": false
    },
    "no-dropping-the-ra": true,
    "no-doubled-joshi": {
      "min_interval": 1,
      "strict": false,
      "allow": ["も"]
    },
    "sentence-length": {
      "max": 150
    },
    "max-ten": {
      "max": 5
    },
    "ja-no-abusage": {
      "severity": "info"
    }
  }
}
```

### ブラウザ統合の課題

1. **バンドルサイズ**: textlint + ルールセットは大きい（形態素解析 `kuromoji.js` を含む場合 10MB 超）
   - 解決策: ルールを動的インポートし、ユーザーが選択したルールのみをロード
2. **初回ロード時間**: kuromoji の辞書ダウンロードに数秒かかる
   - 解決策: Cache API でキャッシュ。「辞書を準備中...」プログレス表示
3. **`@textlint/script-compiler`** の最終アウトプットはスクリプトファイル → `importScripts()` で Web Worker に注入
   - `diffWorker.js` と同じ Web Worker パターンで扱えるが、ビルドステップが追加される

### 統合方針（Phase 10 以降）

- **独立した追加ソース**として扱う（既存の `local` / `yahoo` / `gemini` と並列）
- ルール選択 UI: `textlint` タブでルールをオン/オフ・パラメータ調整
- 設定（有効ルール・パラメータ）を `.novel-rules/textlint-config.json` で Git 管理
- 形態素解析が不要な軽量ルール（`no-dropping-the-ra` 等）を Phase 10a として先行実装し、
  kuromoji を必要とするルールを Phase 10b として後続実装
