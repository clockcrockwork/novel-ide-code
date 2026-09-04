# Artifacts Gate（bundled local action）

PR 本文の完了主張 artifact（完了条件・想定ケース・既存実装調査・証拠表・レビューループ記録・
関連 issue 参照）の**機械的下限**を検査する composite action（#428）。

検査ロジックそのものは `scripts/agent/check-artifacts.js`（+ `mdast-body.js` / `classify-changes.js`）を
**単一ソース**とし、この action はそれを bundle して実行するだけ。証拠の真偽判定は行わない
（cross-model の evidence-check が担う。`docs/agent-workflows/evidence-check.md`）。

## なぜ bundle するのか

`check-artifacts.js` は Markdown 構造解析に mdast / micromark（GFM 拡張）依存を持つ（#403）。
以前は軽量ゲートである `artifacts-gate.yml` が **PR 本文の `edited` を含む毎 run** で
`setup-node` → `npm install -g npm@11` → `npm ci` を実行しており、ゲート本体に対して起動コストが
大きかった。依存を `dist/index.js` に束ね、ネイティブ JavaScript action（`using: node20`）として
配布することで、runner が `dist/index.js` を直接 Node 実行するだけになり、Node/npm セットアップと
依存インストールが不要になる。

トレードオフ（bundle 方式の既知の弱点）:

- **更新漏れ**: `dist` は生成物のため、source を変えて再ビルドを忘れると古い bundle が動く。
  → CI（`.github/workflows/ci.yml` の `bundle-check` ジョブ）が再ビルド差分を検出し fail-loud にする。
- **レビュー不能化**: `dist/index.js` は約 360KB の生成コードで人手レビューに向かない。
  → レビュー対象は `src/` と `scripts/agent/*.js`（source）とし、`dist` は drift check で source との
    一致のみ保証する。
- **サプライチェーン**: 束ねた依存は `package-lock.json` にピン留めされたバージョンから生成される。
  ncc・mdast 系のバージョンは Dependabot が lock を更新 → bundle-check が再ビルドを要求する流れで追従する。

## 入力契約（inputs）

JavaScript action の inputs は GitHub が `INPUT_<NAME 大文字・空白→_・ハイフン保持>` 環境変数として
渡す。`src/index.js` がそれを既存の検査本体が読む env にマッピングする。

| input | 必須 | GitHub が渡す env | マップ先 env | 意味 |
|---|---|---|---|---|
| `changed-files` | ✅ required | `INPUT_CHANGED-FILES` | `CHANGED_FILES` | `base...HEAD` の変更ファイル一覧（改行区切り。空白はファイル名の一部として扱う。0件なら空文字列）。分類（code/docs/dep）に使う。 |
| `pr-body` | 任意（`default: ''`） | `INPUT_PR-BODY` | `PR_BODY` | 検査対象の PR 本文。`pull_request.edited` を含め最新本文を渡すこと。 |

**`changed-files` はなぜ required か**: JavaScript action の `INPUT_<NAME>` 環境変数は、`default`
未設定の optional input でも「呼び出し側が指定しなかった」場合に**空文字列で設定される**
（`undefined` にはならない。[actions/runner#924](https://github.com/actions/runner/issues/924) で
現行仕様として報告されている）。そのため「未指定なら git 差分へフォールバック」を
`INPUT_CHANGED-FILES` の有無で判定する実装は機能しない（常に「存在する」と判定され、
フォールバック分岐が到達不能コードになる。過去のレビュー往復で実際に踏んだ）。required にすることで
「未指定」ケース自体を呼び出し側の責務として構造的に排除している。git 差分への自動フォールバックは
`scripts/agent/check-artifacts.js` を本 action を経由せず直接実行する CLI 単体利用のための機能として
別途維持しており、本 action では使わない。

PR 本文はシェルへ展開されず env で渡るため script injection の心配がない。呼び出し例は
`.github/workflows/artifacts-gate.yml`（`uses: ./.github/actions/artifacts-gate` + `with:`）を参照。

## dist の更新方法

source（`scripts/agent/check-artifacts.js` / `mdast-body.js` / `classify-changes.js` / この action の
`src/index.js`）を変更したら、bundle を再生成してコミットする:

```bash
npm run build:artifacts-gate      # ncc で dist/index.js を再生成
git add .github/actions/artifacts-gate/dist
```

## dist と source の一致検証

```bash
npm run check:artifacts-gate-bundle   # 再ビルドして git diff が出たら失敗（ローカル検査）
```

CI では `ci.yml` の `bundle-check` ジョブが同じ検査を行う（`changes` ジョブの `bundle` 出力＝
`scripts/agent/classify-changes.js` の `BUNDLE_SOURCE_PATTERNS`〔action・上記 source・
`package.json` / `package-lock.json` / `ci.yml`〕に該当する変更があるときだけ実行）。
`dist` が source と一致しなければ fail し、`required-gate` 経由でマージがブロックされる。
CI は push では起動しないため、この検査が走るのは明示起動時のみ。source を触った時点で
ローカルの `npm run check:artifacts-gate-bundle` を通しておくこと（[docs/ai/rules/ci-run.md](../../../docs/ai/rules/ci-run.md)）。

> 注意: `dist/index.js` を手で編集しないこと。編集は source 側で行い、必ず再ビルドすること。
