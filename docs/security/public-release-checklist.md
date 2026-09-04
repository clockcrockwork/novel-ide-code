# public 化前 secret・非公開情報混入チェック手順（#346）

> CI 無料枠の枯渇対策として novel-ide を **public code repo + private control repo** の二層構成へ分離する（親 issue #345）。
> その本実施に入る前に、secret・小説本文・設計カード・AI レビュー本文・非公開 docs が public 側へ混入しないことを保証する**チェック手順の正本**を定める。
>
> - 本ドキュメントは「手順と方針の正本」。実際の public repo 作成・履歴分離は #345、CI 再編は #347 が扱う。
> - public 化は **OSS 化ではない**。外部からの編集・コントリビューションを歓迎する目的ではなく、CI を回すために public にするだけであり、著作権は放棄しない（[6. 最小構成](#6-readme--license--security--contributing-の最小構成)参照）。

---

## 1. public 初期履歴の方針

- public repo は **sanitized tree（新規履歴）** で作成する。private repo の全コミット履歴は public へ持ち込まない。
- 過去履歴は **control repo（現行 private repo）にそのまま温存**する。public 側は「公開時点のスナップショット」を初期コミットとする。
- この方針により、過去コミットに紛れ込んだ可能性のある一時ファイル・レビューログ・誤コミットを履歴ごと公開してしまうリスクを排除する。
- 履歴を持ち込まないため、深い履歴を遡る secret scan（後述の TruffleHog 等）は不要。公開対象は**初期コミットの作業ツリーのみ**を厳密に検査すればよい。

---

## 2. public repo に出す / 出さないファイル

**正本ルール（denylist 方式）**: public ツリー = `git ls-files` の**全 tracked file から、下記「出さない（除外リスト）」を引いたもの**。allowlist 方式（出すものを列挙）は新規ファイルや列挙漏れを silently に取りこぼすため採用しない。判定の正本は**除外リスト側**であり、それ以外の tracked file はすべて public に含める。

```bash
# 出力は「public 対象一覧」（=このリポジトリ全体から除外リストを引いた、public tree に含まれる
# べきファイルの一覧）。build-public-tree.js の manifest（included）と比較するための基準値にする。
# '--full-name' でリポジトリルート相対のパスを出力する（サブディレクトリから実行しても除外フィルタが正しく機能する）
# -i で大文字小文字非依存に判定する（`Docs/Planning/` 等の大小揺れの取りこぼしを防ぐ。
# JS 側の正本 isControlOnlyPath は既定で大小非依存判定のため、この shell 例もそれに揃える）
# -c core.quotePath=false: 既定では非 ASCII を含むパスを `"\346..."` のような 8 進エスケープで
# クォートして出力し、そのまま manifest の生パス文字列と比較すると diff が常に非0件になる
# （JS 側は非 ASCII パスを invalid-path として拒否するため manifest 側には元々出現しないが、
# 出力形式を揃えておくこと自体が diff 比較の前提。ラウンド4敵対的4）
git -c core.quotePath=false ls-files --full-name -- ':/' | grep -viE '^(docs/pr/|docs/pr-analysis/|docs/planning/|docs/agent-memory/records/)' | sort > /tmp/public-expected.txt

# build-public-tree.js が出力した manifest.json（--manifest で指定したパス）の included と比較する。
# 差分が出れば blocking——0件のはずが差分ありなら shell 側のパターン漏れか JS 側の判定漏れの
# いずれかであり、原因を特定してから進める（ラウンド3運用性2）。
jq -r '.included[]' <manifest.json のパス> | sort > /tmp/public-actual.txt
diff /tmp/public-expected.txt /tmp/public-actual.txt; echo "exit=$?"
```

> **`"` を含むパス名の注意（L-3）**: `core.quotePath=false` は非 ASCII のクォートを抑止するが、パス中の `"`（ダブルクォート文字そのもの）は `-c core.quotePath=false` を指定していても C クォートされて出力されるため、上記 `diff` が恒常的に非 0 件になる。JS 側（`isForbiddenSecretPath`・`hasPathSeparatorLookalike` 等）は `"` 単体を invalid-path 扱いにしないため、該当ファイルが tracked されている場合は改名してから本 diff を再実行する。
>
> 上記 `diff` は `exit=0`（差分なし）であることを確認する。**差分がある場合は blocking**——停止して原因（shell 側のパターン漏れ／JS 側 `isControlOnlyPath` や `isAgentMemoryRecordPath` の判定漏れ）を特定する。個々のファイルの食い違いを見る場合の裁定方向: **shell 例がヒットした（除外対象と判定した）のに JS 側（build-public-tree.js の生成結果）が除外していない場合は blocking**——shell 例のパターン漏れと軽く見ず、停止して JS 側（`isControlOnlyPath` の denylist 定義・呼び出し順）の判定を疑う。逆方向（JS 側のみ除外・shell 側は非ヒット）は shell 例のパターン漏れの可能性が高く、JS 側を正本として進めてよい。この shell 例・`diff` は目視確認の補助であり、判定の**正本は JS 側**（`scripts/policy/public-tree-policy.js`）。

### 出さない（control repo のみ・除外リスト＝正本）

| パス | 理由 |
|------|------|
| `docs/pr/` | AI コードレビューの会話ログ（~130 件）。判断過程・内部議論を含む |
| `docs/pr-analysis/` | PR 分析の中間データ（`items.json` 等） |
| `docs/planning/` | 非公開ロードマップ・上位計画（品質/AI運用/public化準備）。実施順・未決事項・AI運用方針など内部判断を含む |
| `docs/agent-memory/records/` | 検索型永続記憶の正本レコード。判断過程・不採用理由・教訓など内部判断を含む。public 側は要約された digest（`agent-memory.js digest --visibility public`。public 側への同期は別作業）でのみ提供する。`docs/agent-memory/README.md` 自体は説明文書のため public に残す |
| `.env*`（`.env` / `.env.local` / `.envrc` 等）, `*.local` | secret。`.gitignore` 済み（[5](#5-env--api-key--local-設定-除外確認) で不在を再確認）。そもそも tracked されない |
| GitHub Issues 本体 | ファイルではないが、非公開の設計判断・脆弱性議論を含むため control 側に留める（GitHub 上の操作） |

> `docs/` 配下は技術ドキュメントが大半で公開して問題ないため、除外は **`docs/pr/`・`docs/pr-analysis/`・`docs/planning/`・`docs/agent-memory/records/` の 4 ディレクトリのみ**。public ツリー生成時にこの 4 ディレクトリが含まれないことを必ず確認する（[8 のチェックリスト](#8-public-化前-最終チェックリスト)）。
>
> **docs/agent-memory/ 配下の追加規則**（同じ denylist 方式内。allowlist は不採用）: **`docs` 直下の `agent-memory` セグメント（＝ `docs/agent-memory/`）配下は `.md` 以外すべて記憶レコード扱い（fail-closed）**（`isAgentMemoryRecordPath`。PR-preflight round6 F-2 で拡張子 allowlist 方式から反転——`docs/agent-memory/tmp/backup.json.bak` のような取りこぼしを塞ぐ）。`docs/agent-memory/records/` 配下は上記 4 ディレクトリの一つとして正常に除外され、それ以外の場所（root 直下・別ディレクトリ配下等）にあれば生成中止（fail-closed）。`.md`（README.md・digest.md 等の説明文書）は本規則の対象外で denylist 既定どおり public 候補になる——将来 digest を `.md` 以外の形式で出力する運用に変える場合は、その形式が本規則で記憶レコードとして拒否されることを前提に、`records/` 配下等の正規の除外パスへ出力する。round6 で追加した「basename が `agent-memory` で始まる非 `.md` は配下外でも記憶レコード扱い」という規則は **round7 N-1（High）で撤回した**——実在する `scripts/agent-memory.js`（記憶 CLI 本体）を誤検出し、`build-public-tree.js` が生成を必ず中止する fail-open な副作用を持っていたため。**既知の残余リスク（意図的に検知しない・作らない運用で担保）**: `docs` 直下以外に置かれた `agent-memory` という名前のディレクトリ（例: `docs/ai/agent-memory/`・root 直下の `agent-memory/`）や `docs/agent-memory-old/` のような類似名ディレクトリは本規則で検知しない。
>
> **パス自体の文字種の方針**: `\`・制御文字（U+0000-U+001F・U+007F）・非 ASCII 文字（コードポイント全域、astral 面を含む）を含む tracked パスは同形グリフ等による判定すり抜けを防ぐため一律 fail-closed にする（`hasPathSeparatorLookalike`。PR-preflight round6 F-1 で判定範囲を BMP 止まりから astral 面まで拡張）。現在の tracked パスに非 ASCII は無く実害はないが、将来非 ASCII なパス名を tracked する場合は本関数の見直しが要る（ラウンド4敵対的2）。

### 出す（public）— 代表例（非網羅）

下表は「除外リスト以外はすべて public」の代表例であり、**網羅リストではない**（正本は上記 denylist）。

| 区分 | 例 |
|------|------|
| アプリ本体 | `src/`, `worker/` |
| テスト | `tests/`, `e2e/`, 各 `__tests__/` |
| ビルド・補助 | `public/`, `scripts/`, `index.html` |
| 設定 | `package.json`, `package-lock.json`, `vite.config.*`, `eslint.config.*`, `vitest.config.*`, `playwright.config.*`, `.prettierrc*`, `knip.*`, `.jscpdrc.json`, `.dependency-cruiser.*`, `tsconfig*.json`, `vercel.json` |
| CI / GitHub | `.github/workflows/`, `.github/dependabot.yml`, `.github/SECURITY.md`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/`, `.github/copilot-instructions.md` |
| secret scan 設定 | `.gitleaks.toml`, `.gitignore` |
| MCP 設定 | `.mcp.json`（playwright のみ。token を含まないことを [5](#5-env--api-key--local-設定-除外確認) で確認） |
| エージェント定義 | `.agents/`（`CLAUDE.md` 等から参照）, `.claude/`（`settings.local.json` は `.gitignore` 済で対象外） |
| ドキュメント | `README.md`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `docs/`（除外リストを除く） |
| 新規追加（要 TODO） | `LICENSE`, `CONTRIBUTING.md`（[6](#6-readme--license--security--contributing-の最小構成)） |

---

## 3. secret scan 手順（Gitleaks / TruffleHog 不採用）

### 通常スキャン

```bash
npm run security:secrets   # gitleaks git . --redact
```

`.gitleaks.toml` は `[extend] useDefault = true` で gitleaks 標準ルールを継承し、`docs/` `tests/` `e2e/` `src/__tests__/` `README.md` `CLAUDE.md` を allowlist している（フィクスチャ・サンプルのダミー値の誤検出抑止）。

### public 化前 strict pass（allowlist を外す）

allowlist は通常運用の誤検出抑止用であり、`docs/` 等に**実トークンを誤って貼り付けた場合も見逃す**。public 化の最終ゲートでは allowlist を無効化した strict pass を実行する。

```bash
# 標準ルールのみ・プロジェクト allowlist なしで作業ツリー全体を走査
# 一時 config は subshell + trap EXIT で確実に削除（GNU/BSD どちらの mktemp でも動くようフォールバック）
# サブディレクトリから実行しても常にリポジトリルート全体をスキャンするため cd でルートに移動
# --no-git は .gitignore を解釈しないため、[allowlist.paths] で除外する:
#   - node_modules/dist/dist-ssr/coverage: ビルド成果物・巨大ディレクトリ（性能・誤検出対策）
#   - \.env[^/]*$: gitignore の '.env*' と同等（.env / .envrc / .env.local / .env.production.local 等）
#     .env.example も除外対象になるが、.env.example は tracked ファイルであり通常スキャン（npm run security:secrets）
#     でカバーされるため、strict pass での除外は許容する（RE2 は否定先読み非対応で .env.example だけを除外できない）
#   - worker/\.dev\.vars[^/]*$: gitignore の '.dev.vars*' と同等（.dev.vars / .dev.vars.production 等）
#   - [^/]*\.local(/|$): gitignore の '*.local' ルール（*.local ファイル末尾・*.local ディレクトリ配下）に対応
#     .*\.local$ は *.local ディレクトリ配下のファイルを取りこぼす点に注意
#   - \.claude/settings\.local\.json: gitignore 個別指定のローカル設定（.local が中間のため上記パターン外）
# paths はすべて正規表現。TOML literal string（シングルクォート）を使うことでバックスラッシュのエスケープが不要
(
  cd "$(git rev-parse --show-toplevel)" || exit 1
  if ! command -v gitleaks >/dev/null 2>&1; then
    echo "エラー: gitleaks コマンドが見つかりません。事前にインストールしてください。" >&2
    exit 1
  fi
  strict_cfg="$(mktemp "${TMPDIR:-/tmp}/gitleaks.XXXXXX" 2>/dev/null || mktemp)"
  [ -z "$strict_cfg" ] && { echo "エラー: 一時ファイルの作成に失敗しました。" >&2; exit 1; }
  trap 'rm -f "$strict_cfg"' EXIT
  cat << 'EOF' > "$strict_cfg"
[extend]
useDefault = true

[allowlist]
paths = [
  '(^|/)node_modules/',
  '(^|/)dist/',
  '(^|/)dist-ssr/',
  '(^|/)coverage/',
  '(^|/)\.env[^/]*$',
  '(^|/)worker/\.dev\.vars[^/]*$',
  '(^|/)[^/]*\.local(/|$)',
  '(^|/)\.claude/settings\.local\.json$'
]
EOF
  gitleaks detect --no-git --no-banner --redact -c "$strict_cfg" --source .
)
```

- `gitleaks detect --no-git` で**作業ツリー**を走査する（[1](#1-public-初期履歴の方針) のとおり初期コミットの作業ツリーのみが対象）。
- 検出 0 を確認する。`docs/` 内のサンプルが引っかかった場合は、実トークンでないことを目視確認のうえ public 化時に文面を修正する。
- テスト内の合成フィクスチャ（secret 拒否検証用のダミー値等）が誤検出された場合は、静的リテラルで置かず公式サンプル値（例: AWS の `AKIAIOSFODNN7EXAMPLE`）または実行時連結（例: `'ghp_' + 'x'.repeat(36)` 相当。検出対象の検証正規表現に合致する長さは維持する）で組む。inline allow コメント・allowlist paths の追加はしない（strict pass が「project allowlist を持たない」という直前の方針そのものを崩すため）。
- **自動化済み**: strict pass の実行ログに `gitleaks version` を出力する（`run-strict-secret-scan.js`。取得失敗・timeout は「不明」）。`AKIAIOSFODNN7EXAMPLE` 等の公式サンプル値が非検出になるのは本チェックリストの project allowlist ではなく、**gitleaks 本体が既定で持つ上流 allowlist**（`useDefault = true` で継承）依存である（実測: 8.21.2）。
- **人間判断（未自動化）**: ログの `gitleaks version` が前回実行と異なる場合、上流 allowlist の内容が変わり非検出前提が崩れている可能性があるため、release note を確認するか実際に検出 0 が続くかを都度確認する。

### TruffleHog は採用しない

- public は sanitized 新規履歴（[1](#1-public-初期履歴の方針)）であり、深い git 履歴を遡る検出器の主目的（過去コミットに埋まった secret の発掘）は不要。
- 検査対象は初期コミットの作業ツリーに限定でき、Gitleaks の strict pass で十分カバーできる。
- 二重メンテのコストに見合わないため**不採用**とする。将来 public 側で履歴が積み上がり、過去コミット混入の懸念が再燃した場合に再検討する。

---

## 4. 本文・設計カード・非公開 docs 混入確認手順

Gitleaks は**secret パターン専用**で、小説本文・設計カードのような自然文は検出しない。本節は別建ての手順。

### 4-1. 構造不変条件（最優先・真のゲート）

混入防止の**一次的な保証は検出 grep ではなく構造**にある。

- **novel-ide は IDE（アプリケーション）であって、創作物の保管庫ではない。** 本文・設計カード・スタイルリファレンス等の実作品は、IDE が編集対象とする**別の Git 文書リポジトリ**に住む（[CLAUDE.md](../../CLAUDE.md)「Project Vision」）。この repo に実作品が入る正当な経路は **テストフィクスチャのみ**。
- 現行リポジトリのテストフィクスチャは**すべて合成テキスト**（lorem-ipsum 系・ダミー）であり、実作品本文・実設計カードは含まれない（調査時点で確認済み）。
- 今後フィクスチャ・サンプルを追加する際は、**実作品の本文・プロット・キャラクター設定を入れない**ことを運用ルールとする。フィクスチャ追加 PR では合成テキストであることをレビューで確認する。

> 以下 4-2 / 4-3 の grep は**この不変条件の破れを機械的に拾うための補助検出**であり、grep 単独で安全を保証するものではない。「散文がコード/設定/フィクスチャ等の想定外の場所に紛れ込んでいないか」を、**語彙ではなく構造**で見つけることを狙う。

### 4-2. 除外ディレクトリの確認

public ツリーに `docs/pr/`・`docs/pr-analysis/`・`docs/planning/`・`docs/agent-memory/records/` が含まれていないことを確認する。

```bash
# positive control（先に実行）: :(icase,top) パススペックが実際に一致することの確認。
# git バージョン・実装差でマジックワードが無効化されていても「0件＝pass」に見えてしまうため、
# 既知に非空となるはずのクエリで先にヒットを確認する（ラウンド3敵対的 A-13）。
# **大文字 `DOCS` で問い合わせる**（小文字 `docs` だと icase が無効化されていても実ディレクトリ名と
# 素の文字列一致でヒットしてしまい、icase 自体が効いているかを検証できない。ラウンド4敵対的5）。
git ls-files -- ':(icase,top)DOCS' | head -1

# public ツリー（または公開対象に絞ったチェックアウト）で実行し、出力が空・exit=0 であること
# ':/dir' でリポジトリルート起点のパスを指定（サブディレクトリから実行しても正しく機能する）
# :(icase,top) パススペックマジックで大文字小文字非依存に判定する（JS 側の正本 isControlOnlyPath と揃える）。
# 判定の正本は JS 側（isControlOnlyPath。大文字小文字非依存）。この shell 例は目視確認の補助。
git ls-files -- ':(icase,top)docs/pr' ':(icase,top)docs/pr-analysis' ':(icase,top)docs/planning' ':(icase,top)docs/agent-memory/records'; echo "exit=$?"
```

### 4-3. 本文混入の探索（2 層・最終的に目視判断）

機械判定は困難なため、構造ベース（主）とキーワード（補助）の 2 層で疑わしい混入を洗い出し、最終的に目視で判断する。

> **なぜ語彙ベースを主にしないか**: 「第◯章 / プロット」のような**語彙ベースの検出は原理的に網羅できない**（作品ごとに語彙が違い、実本文にはメタ語彙が出てこない）。
> **なぜ「かな連続長」も主にしないか**: 当 repo は UI 文言・コードコメントがすべて日本語（[CLAUDE.md](../../CLAUDE.md)「UI テキストは日本語」）であり、コメント自体が長い和文連続なので、純粋な連続長では本文と分離できず大量に誤ヒットする（実測で `src/` 等から数十行）。
> そのため**主検出は「日本語原稿の書式構造」＝段落字下げの全角スペース（U+3000）**に置く。コード・UI 文言は段落を全角スペースで字下げしないため、本文・設計カードと構造的に分離できる（実測で誤ヒット 0・実本文フィクスチャのみ検出）。

#### Layer 1: 構造ベース（主）— 原稿の段落字下げ（全角スペース）を検出

```bash
# Layer 1a: 実ファイル行頭の全角スペース字下げ（.md / .txt の原稿段落）。
# Layer 1b: ソースの文字列リテラルに埋め込まれた段落（"\n　…" の形）。
# どちらも (*UTF) で PCRE を UTF モードに強制する（POSIX ロケールでは \x{} が 8bit 扱いになり失敗するため必須）。
# 全角スペース直後の文字クラスは [^\x{3000}\x00-\x7F]（全角スペース・ASCII 以外の任意 Unicode）を使う。
#   かな漢字のみでは全角括弧「」（）や記号で始まる行（例: 　「こんにちは」）を取りこぼす。
# 除外はリポジトリルート起点で効かせるため :(exclude,top) を使う。icase も付け大文字小文字非依存にする
#   （JS 側の正本 isControlOnlyPath と揃える。Layer2 と非対称だった旧版を修正。ラウンド3敵対的 A-14）。
#   注意: ':(exclude):/path' 形式は除外として機能しない（サイレントに無視される）。必ず top 付きにする。
git grep -nIP '(*UTF)^\s*\x{3000}[^\x{3000}\x00-\x7F]' \
  -- ':/' ':(exclude,top,icase)docs/pr' ':(exclude,top,icase)docs/pr-analysis' ':(exclude,top,icase)docs/planning' ':(exclude,top,icase)docs/agent-memory/records'

git grep -nIP '(*UTF)\\n\x{3000}[^\x{3000}\x00-\x7F]' \
  -- ':/' ':(exclude,top,icase)docs/pr' ':(exclude,top,icase)docs/pr-analysis' ':(exclude,top,icase)docs/planning' ':(exclude,top,icase)docs/agent-memory/records'
```

- ヒットしたファイルが、アプリ同梱の初期サンプル（`src/context/AppContext.jsx` の新規ファイル初期本文）・合成テストフィクスチャなのか、**実作品の貼り付け**なのかを目視で確認する。前者は許容、後者は public ツリーから除く。
- `git grep -P` は PCRE 有効ビルドの git が必要（本チェックは public 化前の手動ゲートのため前提として許容）。
- **限界**: 全角スペース字下げを使わない原稿（横書き非字下げ・台詞のみ・英文等）は Layer 1 をすり抜ける。これは Layer 2（キーワード）と 4-1 の構造不変条件で補完する。

#### Layer 2: キーワード（補助・非網羅）— スメルテスト

構造で拾い切れない取りこぼしを補うための**参考情報**。ヒットの有無で pass/fail を判定しない。語彙はプロジェクトに応じて随時追加する。

```bash
# 原稿・設計に現れがちな語の例（非網羅。control 専用 docs/pr・docs/pr-analysis・docs/planning・
# docs/agent-memory/records の4ディレクトリのみ除外して全体を対象）
# -E で拡張正規表現を有効にし、+ を使って「第章」（章番号なし）の誤ヒットを防ぐ
# 除外パススペックに icase を付け、大文字小文字非依存にする（JS 側の正本 isControlOnlyPath と揃える）。
git grep -EnI \
  -e '第[一二三四五六七八九十]+章' -e 'プロット' -e 'キャラクター設定' \
  -e 'あらすじ' -e 'シノプシス' -e '登場人物' -e '世界観' -e '設定資料' \
  -e '下書き' -e 'エピソード' -e 'シーン' \
  -- ':/' \
  ':(exclude,top,icase)docs/pr' ':(exclude,top,icase)docs/pr-analysis' ':(exclude,top,icase)docs/planning' ':(exclude,top,icase)docs/agent-memory/records'
```

いずれの層も、ヒットが UI 文言・テスト用ダミーなのか実作品由来なのかを最終的に目視で確認する。

---

## 5. .env / API key / local 設定 除外確認

```bash
(
  # 必ずリポジトリのルートで実行する（サブディレクトリから実行すると git ls-files がサブツリーのみを対象にし漏れが生じる）
  # サブシェルで囲むことで cd が呼び出し元のシェルの cwd を変更せず、cd 失敗時も後続コマンドが誤ディレクトリで走らない
  cd "$(git rev-parse --show-toplevel)" || exit 1

  # 追跡対象に env / local / secret 設定が混入していないこと
  # .env.example のみ追跡許可。basename 完全一致で除外し、.env.example.backup 等は見逃さない
  # .env[^/]*: .gitignore の '.env*' ルールと同等。.envprod / .env2 等の異名 secret も検知
  #   （偽陽性として .environment / .envelope が出ても手動確認で済む。false negative より safe）
  # [^/]*\.local(/|$): gitignore の '*.local' ルールと同等。末尾 .local ファイル・.local ディレクトリ配下を検知
  #   \.local(/|\.|$) は helper.local.test.js 等の「中間に .local. を含む」ファイルに偽陽性を出すため不使用
  # \.claude/settings\.local\.json: gitignore 個別指定。上記 [^/]*\.local(/|$) では *.local.json は末尾非一致で漏れる
  # .dev.vars: Cloudflare 環境別 secret（.dev.vars.staging / .dev.vars-local 等）も検知（末尾制限なし）
  # ヒット時は NG を出して exit 1。grep は選択行ありで exit 0・no match で exit 1 を返すため
  # set -e 環境で正常系が abort しないよう || true で no match を許容し、変数の空/非空で判定する
  found_secrets=$(git ls-files | grep -E '(^|/)\.env[^/]*|[^/]*\.local(/|$)|(^|/)\.claude/settings\.local\.json|(^|/)\.dev\.vars' | grep -vE '(^|/)\.env\.example$' || true)
  if [ -n "$found_secrets" ]; then
    echo "NG: 追跡対象に secret/local が混入しています:" >&2
    echo "$found_secrets" >&2
    exit 1
  fi
  echo "OK: 追跡対象に env/local/dev.vars なし"

  # secret 系ファイルが各々 ignore されること（1 つでも未 ignore なら NG を出力し exit 1）
  # 複数パス一括の check-ignore は一部マッチで exit 0 になるため、パスごとに個別判定する
  has_ng=0
  for f in .env .env.local .env.production .envrc test.local worker/.dev.vars worker/.dev.vars.production .claude/settings.local.json; do
    if ! git check-ignore -q "$f"; then
      echo "NG: $f が ignore されていません"
      has_ng=1
    fi
  done
  if [ "$has_ng" -ne 0 ]; then
    echo "エラー: ignore 設定に不備があります。" >&2
    exit 1
  fi
  echo "OK: 全 secret パスが ignore 済み"
)
```

- `.gitignore` に `.env*`（`.env` / `.env.local` / `.envrc` 等）/ `*.local` が登録され、**実際に ignore される**ことを `git check-ignore` で確認する（`.env.example` のみ `!.env.example` で追跡可）。
- `worker/.dev.vars` および環境別 secret（`worker/.dev.vars.staging` / `.production` 等。`GITHUB_CLIENT_SECRET` 等の OAuth シークレットを置く。`worker/.gitignore` の `.dev.vars*` で ignore 済み）が **tracked されていない**ことを `git ls-files` / `git check-ignore` で確認する。過去の追跡や `git add -f` での混入を public 化前ゲートで検出するため。詳細は [docs/ENVIRONMENT.md](../ENVIRONMENT.md)。
- `.mcp.json` を開き、**token・API キーを含まない**ことを確認する（現状は playwright の起動設定のみ）。
- `worker/` の `wrangler` 設定・KV バインディングに**実シークレットが直書きされていない**ことを確認する（シークレットは Cloudflare 側に保持し、リポジトリにはプレースホルダのみ）。

---

## 6. README / LICENSE / SECURITY / CONTRIBUTING の最小構成

| ファイル | 現状 | 対応 |
|----------|------|------|
| `README.md` | あり | public 向けに記述を確認（内部運用前提の記述があれば調整） |
| `.github/SECURITY.md` | あり | **訂正済み**。過去の「未対応脆弱性」表（#49/#50/#51）は実際には修正済み（2026-05-15 close、コード・テストあり）だったため、未対応として公開しないよう修正した |
| `LICENSE` | **未作成** | 下記方針で public 化前に追加（TODO） |
| `CONTRIBUTING.md` | **未作成** | 下記方針で public 化前に追加（TODO） |

### LICENSE（TODO・生成方針）

- **OSS ライセンス（MIT / Apache-2.0 等）は採用しない。** public 化の目的は CI 利用であり、再配布・改変・再利用を許諾する意図はない。
- **プロプライエタリ / source-available（全権利留保・"All Rights Reserved"）** の文面を生成する。ソースは閲覧可能だが、複製・改変・再配布・派生物作成・商用利用を許諾しない旨を明記する。
- 著作権表示（`Copyright (c) <year> <owner>. All rights reserved.`）を含める。

### CONTRIBUTING.md（TODO・生成方針）

- このリポジトリが **public なのは CI 都合のみ**であり、外部からのコントリビューション（PR / issue）を受け付けない旨を明記する。
- 外部 PR / issue は予告なくクローズされ得ること、フォーク・再配布は LICENSE で許諾されないことを記載する。

> `LICENSE` / `CONTRIBUTING.md` の実ファイル作成は #345 実施フェーズ（または本 issue 完了後の別タスク）で行う。本ドキュメントは生成方針の確定までを担う。

---

## 7. コミット済みファイルの Git 履歴からの除去（secret 混入時）

§1〜§6 は「public へ出す前に混入を見つける」手順で、**既にコミットしてしまった secret を履歴から消す手順ではない**。後者が必要になるのは、secret を含むファイルを commit（さらに push）してしまい、作業ツリーから消すだけでは `git log -p` で読めてしまう場合である。

**履歴書き換え（7-1 / 7-2）は人間が実施する。** force-push を伴い、保護ブランチの設定変更・共同作業者の再 clone を要求するため、エージェントが単独で完結できる操作ではない。7-3 の `purge`（作業ツリーの整合回復）は人間の endorse を得たエージェントが実行してよい（`docs/planning/agent-memory-design.md` §6.0 の legitimacy 表）。

> **実行順**: **どのケースでも 7-0（露出 secret の失効）が最初**。7-3 は PR レビュー・マージを経由してよい手順で数時間〜数日かかりうるため、失効を後回しにするとその間トークンが有効なまま露出範囲が広がる。7-0 のあと、agent-memory レコードが対象なら **7-3（作業ツリーの整合回復とコミット・push）→ 7-1 → 7-2** の順。7-1 を先に走らせると、force-push 後にもう一度リンク修復コミットを push することになる。レコード以外のファイルが対象なら 7-0 → 7-1 → 7-2。

### 7-0. 前提: 露出した secret は必ず失効させる

**履歴書き換えより先に、露出したトークン・鍵をローテーション（失効＋再発行）する。** push 済みなら、fork・CI ログ・GitHub のイベント API・第三者のクローンに残っている可能性があり、履歴を書き換えても「もう読まれていない」ことは保証できない。履歴除去は**再露出を止める措置であって、漏洩を無かったことにする措置ではない**。

### 7-1. 対象ファイルを履歴から除去する

`git filter-repo`（推奨。GitHub も公式に推奨）を使う:

```bash
# 事前に必ずバックアップ（filter-repo は履歴を不可逆に書き換える）
git clone --mirror <repo-url> ../repo-backup.git

# 書き換えの実行場所は 7-2 の mirror clone（repo-rewrite.git）**のみ**。通常 clone の
# 作業リポジトリでは実行しない — checkout していないリモート専用ブランチが更新されず、
# push 後もサーバーに secret を含む旧コミットが残るため（7-2 参照）。
# 本節（7-1）はコマンドの意味と注意点の説明で、実行フローの正本は 7-2 のブロック。

# 対象パスを全履歴から除去する（複数指定可）
# --prune-empty=never: 7-3 の purge コミットが「対象パスの削除だけ」の場合、除去後に空コミット
# となり既定では履歴から落ちる。監査 trailer（Memory-Purge: / Memory-Endorsement:）ごと消える
git filter-repo --force --invert-paths --prune-empty=never \
  --path docs/agent-memory/records/mem-YYYYMMDD-xxxxxx.json

# ファイル全体ではなく特定の文字列だけを潰す場合（ファイル自体は残す）
#   置換ルールを書いたファイルを用意して --replace-text に渡す
#   例: literal:ghp_xxxxxxxx==>REDACTED
git filter-repo --replace-text ../redactions.txt
```

`git filter-repo` が入っていない環境では `filter-branch` で代替できるが、**`--tag-name-filter cat` を必ず付ける**:

```bash
# --tag-name-filter cat が無いと tag ref は書き換わらず、古いコミット（secret を含む）を指したまま残る。
# その状態で次節の `--tags` を force-push すると secret が再公開される。
# --prune-empty は付けない。7-3 の purge を「対象レコードの削除だけ」のコミットにしている場合、
# そのパスを除去するとコミットが空になり、--prune-empty が Memory-Purge: / Memory-Endorsement:
# の監査 trailer ごと履歴から落としてしまう（filter-repo も既定で空コミットを落とすため
# --prune-empty=never を指定する）。
git filter-branch --index-filter 'git rm --cached --ignore-unmatch <path>' \
  --tag-name-filter cat -- --all

# filter-branch は元の ref を refs/original/ に退避するため、削除しないと secret が残る
git for-each-ref --format='delete %(refname)' refs/original | git update-ref --stdin
git reflog expire --expire=now --all && git gc --prune=now --aggressive
```

それでも `filter-branch` は遅く取り残しが起きやすいため、**可能なら `pip install git-filter-repo` で `filter-repo` を使う**（`filter-repo` は tag の書き換えと `refs/original` の後始末を既定で行う）。

### 7-2. 書き換え後の後始末

- `git remote add origin <repo-url>`（filter-repo が消しているため。7-1 参照）
- **書き換えは mirror clone で行い、`git push --mirror` で全 ref を更新する**:

  ```bash
  # 通常の clone で作業し `git push --force --all` すると、checkout していない
  # リモート専用ブランチは push されず、サーバー上に secret を含む旧コミットが残り続ける
  # （--all は「ローカルブランチ全部」であって「全 ref」ではない）
  git clone --mirror <repo-url> repo-rewrite.git && cd repo-rewrite.git
  # mirror clone なので --force 不要。--prune-empty=never は下記「監査コミットを消さない」参照
  git filter-repo --invert-paths --path <path> --prune-empty=never
  # filter-repo は実行後に origin remote を削除する（誤 push 防止）。push 前に必ず再追加する
  git remote add origin <repo-url>
  git push --mirror origin
  ```

  通常の clone で作業してしまった場合は、**全リモートブランチを明示的に checkout してから**書き換えるか、mirror clone でやり直す。保護ブランチは一時的に force-push を許可する必要がある。remote-tracking ref も書き換わるため `--force-with-lease` はこの状況では機能しない — **だからこそバックアップ mirror を先に取る**
- **共同作業者・エージェントセッションは全員 clone をやり直す**（古い履歴を持ったまま push すると secret が復活する）
- 開いている PR は base の履歴が変わるため、作り直しが要ることが多い
- GitHub 側のキャッシュに残った blob の削除は GitHub サポートへの依頼が要る場合がある（fork がある場合は特に）

### 7-3. agent-memory レコードの場合の追加手順

記憶レコード（`docs/agent-memory/records/*.json`）が対象のときは、**作業ツリー側のリンク整合も回復する**（`docs/planning/agent-memory-design.md` §4 の削除例外 (1)・§6 `purge`）。ファイルを消すだけだと `supersedes 先が存在しない` / `逆リンク宙ぶらりん` が `validate` の error として残り、CI が恒久的にブロックされる。

```bash
# 1. 作業ツリーからの削除とリンク修復（--retire-orphans は対象が他レコードの置換先である場合のみ必要）
node scripts/agent-memory.js purge <id> --reason "<混入した secret の種別>" --endorsed-by <人間> \
  [--retire-orphans]

# 2. 整合確認（errors 0 になること）
node scripts/agent-memory.js validate

# 3. この状態をコミットする（この時点ではまだ履歴に secret が残っている）
#    コミットメッセージには purge が出力した Memory-Purge: / Memory-Endorsement: trailer を貼る
#    Memory-Purge: の trailer には --reason の値が含まれる
#    （git log --format='%(trailers:key=Memory-Purge,valueonly)' で削除理由まで引ける。
#      git log --grep は本文行にもマッチするため存在確認には使わない）
# 4. この purge コミットを <repo-url> の対象ブランチへ push（または通常の PR レビュー・マージ）で
#    反映してから 7-1 → 7-2 へ進む。7-2 の `git clone --mirror <repo-url>` はリモートの状態を
#    取得するため、purge コミットが <repo-url> に無いまま mirror clone すると、そのコミットが
#    行ったリンク修復と Memory-Purge: / Memory-Endorsement: trailer を含まない履歴から書き換えが
#    始まり、force-push 後の corpus に dangling link が残る
```

`purge` は**作業ツリーしか触らない**（CLI は Git を実行しない）。7-1 を省略すると secret は履歴に残り続ける。逆に 7-1 だけを行うと作業ツリーのリンクが壊れたままになる。**両方が必要**。

---

## 8. public 化前 最終チェックリスト

#345 実施時にそのまま使えるよう、上記を集約する。

- [ ] 初期履歴は sanitized tree（新規履歴）で作成し、private 履歴を持ち込んでいない（[1](#1-public-初期履歴の方針)）
- [ ] public ツリーを denylist 方式（全 tracked − 除外リスト）で確定し、`docs/pr/` `docs/pr-analysis/` `docs/planning/` `docs/agent-memory/records/` が含まれない（[2](#2-public-repo-に出す--出さないファイル) / [4-2](#4-2-除外ディレクトリの確認)）
- [ ] `npm run security:secrets` が検出 0（[3](#3-secret-scan-手順gitleaks--trufflehog-不採用)）
- [ ] strict pass（allowlist なし）が検出 0、または検出箇所が実トークンでないことを確認済み（[3](#3-secret-scan-手順gitleaks--trufflehog-不採用)）
- [ ] フィクスチャ・docs に実作品本文・設計カードが混入していない（[4](#4-本文設計カード非公開-docs-混入確認手順)）
- [ ] 生成 tree で `npm ci && npm run check`（lint / check:thresholds / test）が green（push 前ゲート。`docs/planning/repo-split-execution.md` §4 step 5.5。ラウンド3運用性4/仕様S22）
- [ ] `.gitignore` で `.env*` / `*.local` が ignore され（`git check-ignore` で確認）、追跡対象に env/local/`worker/.dev.vars` が無く、`.mcp.json` ・wrangler 設定に実シークレットが無い（[5](#5-env--api-key--local-設定-除外確認)）
- [ ] `README.md` / `.github/SECURITY.md` が public 向けに正確（[6](#6-readme--license--security--contributing-の最小構成)）
- [ ] `LICENSE`（プロプライエタリ / 全権利留保）を追加済み（[6](#6-readme--license--security--contributing-の最小構成)）
- [ ] `CONTRIBUTING.md`（コントリビューション不可・CI 都合の public）を追加済み（[6](#6-readme--license--security--contributing-の最小構成)）
- [ ] 過去に secret をコミットした事実があれば、失効（ローテーション）と履歴からの除去が完了している（[7](#7-コミット済みファイルの-git-履歴からの除去secret-混入時)）

---

## 関連

- [docs/MVP_PLAN.md](../MVP_PLAN.md) / 親 issue #345（public/private 二層分離の本実施）、#347（CI 再編）
- [docs/SUPPLY_CHAIN.md](../SUPPLY_CHAIN.md) — public repo 化前の GitHub Actions hardening 方針
- [docs/security/github-boundary.md](github-boundary.md) — GitHub 連携の権限・リポジトリ境界
- [.github/SECURITY.md](../../.github/SECURITY.md) — セキュリティポリシー・責任ある開示フロー
