# Structured review finding runtime（consumer 実装。issue #647）

> **Ground truth:** 共通語彙・スキーマの正本は `agent-commons`
> [`core/contracts/review-finding-contract.js`](https://github.com/clockcrockwork/agent-commons/blob/main/core/contracts/review-finding-contract.js)
> （consumer 側 projected: `scripts/agent/review-finding-contract.js`）。**scope_relation / severity /
> evidence / verification verdict / Actionable base rule の語彙をこのファイルへ複製しない** —
> 常に import して使う。本書は consumer（novel-ide）側 runtime の使い方・artifact 形状・
> finding_id semantics・aggregation 規則・既存 metrics/PR record への接続経路の正本。
> **Entry gate:** 観点別レビューが所見を出す段階で、その所見を後段（metrics / retrospective /
> `finding_id` での参照）から追跡したい場合に使う。所見の集約自体を必須化するものではない
> （#647 は artifact runtime の導入であり、reviewer 起動義務や Tier を変更しない）。
> **Required artifacts:** `structured-findings.json` / `structured-findings-aggregate.json`
> （snapshot ディレクトリ内。恒久 artifact ではなく `review-plan.json` 等と同じ disposable
> execution cache）。
> **Verification gate:** `node --test tests/reviewFindings.test.js tests/reviewFindingsNormalize.test.js tests/reviewFindingsAggregate.test.js`
> （`npm run test:node` に含まれる）。

## 位置づけ

`docs/planning/review-system-phase5-plan.md` §7（Finding contract）・§8（Finding clustering）の
consumer 側実装。現行の観点別レビュー（[review-angles/README.md](review-angles/README.md)）が
起動する系統・Tier・authority routing は一切変更しない — 本 runtime は「reviewer が出した所見を
machine-readable な形へ変換・検証・集約する」層だけを追加する。

```
reviewer free-form 出力（変更なし）
  ↓ （orchestrator が所見を JSON 配列へ書き出す。reviewer が将来 JSON を直接出せるなら同じ入口を使ってよい）
raw findings JSON（一時ファイル）
  ↓ ingest（schema validation + normalization + finding_id 付与）
structured-findings.json          … snapshot ディレクトリ内。ingest 呼び出しごとに追記
  ↓ aggregate（決定的 exact-duplicate merge + candidate grouping + Actionable 評価）
structured-findings-aggregate.json … 同ディレクトリ。aggregate 実行のたびに全体再計算・上書き（冪等）
  ↓ report / metrics
人間可読サマリ / review-metrics.js record 用の数値
  ↓ （#647 の範囲外）
model / human adjudication → docs/pr/PR-{番号}.md「内部レビュー所見の裁定」（finding_id を任意で1行併記できる）
```

**重要な境界**: aggregation（本 runtime の責務）と semantic duplicate adjudication（人間・将来の
#648 verifier の責務）は分離している。本 runtime は summary の意味的類似度判定・embedding・LLM
呼び出しを一切行わない。

## モジュール構成

| ファイル | 責務 | 副作用 |
|---|---|---|
| [`scripts/agent/review-finding-contract.js`](../../scripts/agent/review-finding-contract.js) | 共通語彙・スキーマ（agent-commons projected。手編集禁止） | なし（データのみ） |
| `scripts/agent/review-findings-normalize.js` | 1件の raw finding の schema validation・正規化・`isActionable` 判定 | なし（純粋関数） |
| `scripts/agent/review-findings-aggregate.js` | records 配列からの決定的 aggregation（exact-duplicate / candidate grouping / counts） | なし（純粋関数） |
| `scripts/agent/review-findings.js` | CLI（`ingest` / `aggregate` / `report` / `metrics`）。snapshot ディレクトリの読み書き | あり（fs） |

役割分離のみが目的で、ファイル数自体を成果指標にしない（1ファイルに統合しても本質は変わらない）。

## CLI

```bash
# 1回の reviewer 起動（1 angle）の所見を ingest する。--input は raw finding の JSON 配列ファイル
node scripts/agent/review-findings.js ingest \
  --snapshot <snapshot-id> \
  --angle adversarial --anchor-class attack-surface \
  --input /path/to/raw-findings.json

# 決定的 aggregation を（再）計算する。ingest 済みの structured-findings.json から毎回全体再計算する
node scripts/agent/review-findings.js aggregate --snapshot <snapshot-id>

# 人間可読サマリ
node scripts/agent/review-findings.js report --snapshot <snapshot-id>

# review-metrics.js record にそのまま渡せる数値を出す（round全体）
node scripts/agent/review-findings.js metrics --snapshot <snapshot-id>

# 観点ごとの内訳（dogfood 指標）が必要な場合は --angle を追加する
node scripts/agent/review-findings.js metrics --snapshot <snapshot-id> --angle adversarial
```

`--snapshot` は省略可（省略時は最新 snapshot。`review-plan.js` の `record-run` と同じ規約）。
**ただし同じレビュー周回内で `ingest` → `aggregate` / `report` / `metrics` を続けて呼ぶ場合は、
`ingest` の戻り値（`snapshotId`）を必ず `--snapshot` として明示的に指定し、省略しないこと。**
レビュー周回中は `npm run review:snapshot` で新しい snapshot が作られることが頻繁にあり、
`ingest` 実行後にそれが起きると、省略形で呼んだ後続の `aggregate` / `report` / `metrics` は
ingest と異なる（多くの場合空の）snapshot を最新として対象にしてしまう。この場合、blocker
所見があっても「actionable 0件」として exit 0 で報告され、所見が消えたように見える
（review-adversarial A2: 実行検証済み）。`latest snapshot` フォールバック自体（`review-plan.js`
等が共有する既存規約）は変更しない — 呼び出し側が対象 snapshot を省略しない運用で回避する。

flag は `--` で始まる生トークン単位で検証する（`parseArgs` の出力キーだけを見るのではない）。
`--` 以外の文字（en dash・em dash・全角ハイフン等の非ASCIIダッシュ）で始まるトークンや、
`--` を伴わない位置引数はコマンド全体を拒否する（黙って無視されたり、意図しない最新 snapshot
へフォールバックしたりしない）。

`ingest` に渡した finding が1件以上あるにもかかわらず、正規化された finding が0件（全件
invalid）の場合、`ingest` は非ゼロ終了する（`--angle` / `--anchor-class` の指定漏れ・誤りを
orchestrator が exit code だけで見逃さないため）。`rawFindings` が空配列の場合は0件であること
自体が正当なケースのため、引き続き exit 0 のままとする。一部が normalized・一部が invalid の
混在バッチでは、この非ゼロ終了は適用されない（部分的な invalid がバッチ全体を失敗させない、
という既存の設計を変えない）。

### raw finding（`--input` に渡す JSON 配列の要素）

```json
{
  "file": "src/foo.js",
  "line": 42,
  "summary": "...",
  "failure_scenario": "...",
  "scope_relation": "introduced",
  "severity": "med",
  "evidence": "strong",
  "provenance": { "angle": "adversarial", "anchor_class": "attack-surface" },
  "angle_fields": { "...": "...(系統固有分類。任意)" }
}
```

`provenance` を省略した場合、`ingest` の `--angle` / `--anchor-class` が既定値として使われる
（1回の ingest 呼び出し = 1 reviewer 起動の典型ケースでは省略してよい）。個々の finding が独自の
`provenance` を持つ場合はそちらが優先される（複数 angle の所見を1回の ingest にまとめて渡す場合に
使う）。

`provenance.angle`（finding 個別の値。省略時は CLI の `--angle` 既定値が使われる）は
`scripts/agent/review-angle-tokens.js` の `ANGLE_TOKENS` / `CONDITIONAL_ANGLE_TOKENS` に登録された
既知の canonical angle ID でなければならない。finding 個別の `provenance.angle` が未知の場合、
その finding だけが `invalid` record になる（`anchor_class` は自由文字列のまま — 共通契約が
要求するのは非空文字列のみ）。CLI の `--angle` 自体（省略しなかった場合）も同じ語彙で検証される
——バッチ内の全 finding が既に有効な明示 `provenance.angle` を持ち `--angle` がどの finding にも
実際には適用されない場合であっても、`--angle` が未知であれば要素の処理に入る前にバッチ全体を
fail-loud する（typo った既定値がそのまま `ingestBatch.angle`〔監査メタデータ〕へ記録されるのを
防ぐため）。`--angle` を省略した場合（全 finding が自前の `provenance.angle` を持つことを前提に
した呼び出し）はこの検証の対象外で、finding 個別の検証だけが働く。

`file` はリポジトリルート相当の `cwd`（呼び出し側の cwd）配下を指す絶対パスであれば、
リポジトリルート相対パスへ正規化される（`./`・冗長な区切り等も normalize される）。cwd 配下で
ない絶対パス（別リポジトリ・システムファイル等）はそのまま保持される。これにより、reviewer
ごとの path 表記の違い（絶対 vs 相対）だけで exact-duplicate / same-location grouping から
漏れることを防ぐ。

`angle_fields` は自由形だが machine 側の受理上限がある: 直列化後サイズ `MAX_SERIALIZED_CHARS`
（20000文字）・ネスト深さ `MAX_ANGLE_FIELDS_DEPTH`（20階層）。上限を超えるとその finding は
`invalid` record になり、`raw` には angle_fields のうち上限を超えてネストする部分木だけが
プレースホルダへ置き換わった状態で残る（file/line/summary 等の浅いフィールドは保持される）。

## finding_id semantics — 絶対に守ること

- `finding_id`（例: `f-0001`）は **`structured-findings.json` 1ファイル内だけで一意な opaque
  join key**。ingest 順の連番で採番する。
- **cross-run semantic identity ではない。** 同じ内容の finding でも、投入順が違えば別の ID になる。
  `hash(summary+file+line)` のような内容由来の ID には**しない**（agent-commons 契約の
  `finding_id` フィールド doc コメントが明記する禁止事項と同じ）。
- 用途は finding ↔ aggregate ↔（将来の）verification ↔ metrics の対応付けだけ。リポジトリ全体で
  「同じバグ」を横断追跡する永続キーとして使わない。

## Aggregation 規則（決定的。semantic dedup ではない）

- **Exact duplicate**: `file` / `line` / `summary`（trim後）/ `failure_scenario`（trim後）/
  `scope_relation` が**すべて完全一致**する normalized finding だけを1つの canonical finding へ
  束ねる（`provenance` は比較対象に含めない — 複数 reviewer が同一所見を出したケースを検出する
  ため）。`severity` / `evidence` は同じ問題に対する reviewer ごとの評価であり、reviewer 間で
  正当に異なりうるため identity には含めない —— ただし canonical finding の `finding.severity` /
  `finding.evidence` は、severity と evidence を member ごとに独立に最大化して組み合わせることは
  **しない**（どの reviewer も下していない評価が合成されうるため。review-spec F1: 実行検証済み）。
  actionable な member があればその中で、無ければ全 member 中で `severity`（`SEVERITY_RANK` の
  既存順序で判定）が最も強いものを選び、その member 自身の `(severity, evidence)` の組をそのまま
  採用する。severity が同値の場合は `evidence`（`EVIDENCE_LEVELS` の既存順序 = verified > strong
  > weak）が強い方を、それも同値なら `finding_id` が数値として小さい方を選ぶ（配列の入力順序に
  依存しない決定的な選定。review-spec 所見2(d): 実行検証済み）。どの member の評価を採用したかは
  canonical finding の `assessmentSourceFindingId` に記録される（**canonical finding 自身の
  `finding_id`〔identity 代表〕とは限らない** — `structured-findings.json` の該当 record を引く
  ときは `finding_id` ではなく `assessmentSourceFindingId` を使うこと。review-spec 所見2）。
  canonical finding は `sources[]` に元の全 `finding_id` を保持する（provenance を失わない）。
- **Candidate grouping**（confirmed duplicate ではない）: `same-location`（同一 file かつ同一 line）
  と `same-summary`（summary 完全一致。file/line 不問）の2種類のみ。いずれも文字列完全一致のみで
  判定し、意味的類似度・embedding は使わない。candidate group は member の finding_id を束ねる
  だけで、merge・reject は一切行わない。**`groupId`（例: `g-0001`）は `finding_id` と同様に
  run 間で安定ではない** — `aggregate` を再実行するたびに、その時点の candidate group 集合を
  `(reason, 最小 member finding_id)` で並べ直してから採番し直すため、新しい finding の ingest で
  グループ構成が変わると既存 `groupId` が指す内容がずれうる。`finding_id` の非安定性の注記と対
  称に扱うこと（PR 本文・裁定記録で `groupId` を恒久参照キーとして引用しない）。
- **cluster が保持する情報**: 各 canonical finding は `sources[]`（元の全 `finding_id`）に加え、
  `reportedBy`（報告した angle の重複排除済み一覧）・`actionableReporters`（そのうち、自分自身の
  評価が独立に actionable だった angle だけの重複排除済み一覧。cluster 全体の actionable 判定
  〔1件でも actionable な member があれば true〕とは別に、観点ごとの metrics 帰属を「その観点
  自身が actionable と評価したか」で正しく区別するためのフィールド。review-spec 所見1）・
  `anchorClasses`（同じく anchor_class の一覧）・`assessmentSourceFindingId`（`finding.severity`/
  `finding.evidence` の採用元 member の `finding_id`。上記の通り canonical finding 自身の
  `finding_id` とは異なりうる。review-spec 所見2）・`agreement`（クラスタ内の全 member の
  severity と evidence がそれぞれ1種類しかない場合のみ `true`。severity/evidence は identity に
  含まれないため、一致しない member が混在しうる）を持つ。これは
  `docs/planning/review-system-phase5-plan.md` §8 が cluster に求める最低限の保持項目
  （canonical finding / reported_by / anchor_classes / agreement-disagreement の有無 /
  strongest evidence / severity）に対応する — strongest evidence・severity は
  `finding.evidence` / `finding.severity`（上記の通り、実在する member の組のままロールアップ済み）
  がそのまま該当するため別フィールドとしては複製しない。
- **`counts.validMedPlus` は観点（reviewer）単位で重複排除し、かつその観点自身の評価が
  actionable だった場合だけを数える**: cluster 全体の actionable 判定を使うと、非actionable な
  評価しか出していない観点にまで計上されてしまうため、`actionableReporters.length`
  （その観点自身が独立に actionable と評価した件数。重複排除済み）を canonical finding ごとに
  合計する（review-spec 所見1: 実行検証済み）。**`counts.duplicateClusterParticipation`（後述）は
  引き続き `reportedBy.length`（観点の重複排除件数。actionable かどうかは問わない）を数える** —
  こちらは収束（複数観点が同じ問題に到達した事実）の追跡が目的であり、actionable 判定を経由
  しない。同一観点が同じ内容を複数回 ingest（再実行・operational error）しても、`reportedBy` /
  `actionableReporters` のどちらもその観点1人分としてしか計上されない。
- **やらないこと**: summary の意味的類似度判定・embedding similarity・semantic duplicate の
  final decision・severity/scope_relation/evidence の書き換え・finding の採否判定。これらは
  人間または将来の #648 verifier sidecar の責務。

## Malformed / partial input

`ingest` は入力配列の要素ごとに独立して検証する。1件が invalid でも他の valid な要素は
`normalized` として記録され、invalid な要素も `status: "invalid"` + `errors[]` として
**silent drop されずに** `structured-findings.json` に残る（`records.length` は常に入力配列長と
一致する）。トップレベルの構造異常（JSON parse 失敗・配列でない）だけは CLI レベルで fail-loud
にする（何も ingest しない）。

## Metrics 統合（移行パス）

`review-metrics.js` の `record` サブコマンドは既存どおり手動 CLI flag（`--valid-med-plus` 等）を
受け取る設計を維持し、本 PR では変更しない。`review-findings.js metrics` が
`structured-findings-aggregate.json` の `counts` から次を導出し、`review-metrics.js record` へ
そのまま渡せる flag 文字列を出力する:

- `validMedPlus` = 全 canonical finding それぞれについて `actionableReporters.length`
  （その観点自身が独立に actionable と評価した、報告観点の重複排除件数）を合計した値。
  cluster 全体の actionable 判定ではなく観点自身の評価で数えるため、非actionable な評価しか
  出していない観点は計上されない（review-spec 所見1: 実行検証済み）。複数 reviewer が独立に
  actionable と評価した場合はその観点の数だけ数えるが、同一観点が同じ finding を複数回
  ingest（再実行・operational error）しても、その観点1人分としてしか数えない
- `uniqueValidMedPlus` = Actionable な canonical finding 数（exact-duplicate 解消後）
- `duplicateClusterParticipation` = `reportedBy.length` が2以上（2つ以上の異なる観点が独立に
  到達した cluster）の canonical finding について、その `reportedBy.length` を合計した値
  （actionable かどうかは問わない。`validMedPlus` と異なり、こちらは収束の追跡が目的のため
  reportedBy ベースのまま変更しない）

`--angle <観点>` を指定すると、上記3値の代わりに観点別の値になる: `validMedPlus` /
`uniqueValidMedPlus` は **その観点自身が `actionableReporters` に含まれる canonical finding
だけ**（その観点自身が独立に actionable と評価した件数）、`duplicateClusterParticipation` は
引き続き **その観点が `reportedBy` に含まれる canonical finding だけ**を対象にした値になる
（`validMedPlus` と `uniqueValidMedPlus` は常に同じ値になる — 観点をまたいだ重複排除が無い
以上、観点内で「重複」という概念自体が発生しないため）。

Actionable の判定は agent-commons の `ACTIONABLE_BASE_RULE` / `SEVERITY_RANK` をそのまま使う
（`scope_relation ∈ {introduced,worsened,newly_exposed} ∧ severity ≥ med ∧ evidence ∈
{verified,strong}`）。

**重要な注意（運用上必ず守ること。review-spec レビューで指摘）**:

1. **この3値は deterministic Actionable base rule のみに基づく「裁定前」の数値**であり、
   人間・model による semantic adjudication（false positive 判定等）を反映しない。
   `review-metrics.js` の `validMedPlus` / `uniqueValidMedPlus` は元来「orchestrator が既に
   持っている値」を手入力する設計で、その値が「裁定後の確定値」なのか「機械的な Actionable 判定
   そのまま」なのかは呼び出し側の運用次第だった。本 runtime が出す値は**後者**（裁定前）である
   ことを明記する。ある finding を後で false positive と裁定した場合、その finding は
   `validMedPlus`/`uniqueValidMedPlus` からも除外してから `record` へ渡す（`--false-positives`
   と二重計上しない）。この reconciliation は orchestrator の責務であり、本 runtime は行わない。
2. **新しい `record` 呼び出しを作らない。** `review-metrics.js record` は「1 呼び出し = 1
   起動」の JSONL 台帳であり、`summarize()` は invocation 行を単純加算する設計のため、実際には
   起きていない「起動」を表す行を新たに作ると台帳が汚染される。観点ごとの内訳（dogfood 指標
   として reviewer ごとの unique valid Med+ を追跡する。`docs/planning/review-system-phase5-plan.md`
   §15.5/§19）が必要な場合は、`metrics --angle <観点>` の出力を、**その観点の起動が実際に行う
   既存の `record` 呼び出しへ** `--valid-med-plus` / `--duplicate-cluster-participation` **だけ**
   追加で渡すこと。**`--unique-valid-med-plus` は渡さない** —— 「unique」は round 全体でしか
   意味を持たない非加算的な値であり、観点ごとに `record` へ渡して `summarize()` に単純加算させると、
   複数観点が同じ finding に収束した分だけ実際の round 全体の unique 数より大きくなる
   （review-spec F2: 実行検証済み。収束1件を含む3件の finding で round 値 `actionable=3` の
   ところ、観点別合計は `4` になる）。round 全体の正確な unique valid Med+（`counts.actionable`）
   は、`review-metrics.jsonl` の集計からではなく、常に `review-findings.js report` または
   `structured-findings-aggregate.json` から直接読み取ること。
3. **round 全体の正確な収束数を知りたい場合は、`review-metrics.jsonl` 側の集計
   （`summarize()`）に頼らず、`review-findings.js report`（または
   `structured-findings-aggregate.json` 自体の `counts.validMedPlus` /
   `counts.duplicateClusterParticipation`）を直接参照すること。** 各観点の実起動行へ
   `metrics --angle` の値を過不足なく1回ずつ付与している限り `summarize()` の合計は round
   全体の値と一致するが、これに加えて（旧来の運用のように）`--angle` を省略した round サマリ行を
   別途 `record` してしまうと、収束した finding が観点ごとの行と round サマリ行の両方で二重に
   計上される。aggregate 成果物を直接参照すれば、この種の二重計上を気にせず round 全体の正確な
   値を得られる。

## Aggregation-miss の追跡

`structured-findings.json`（ingest ログ。全 raw 入力が finding_id 付きで残る）→
`structured-findings-aggregate.json`（`canonicalFindings[].sources` / `candidateGroups[].members` /
`invalid[]`）の対応関係により、任意の finding_id が「どの canonical finding へ吸収されたか」
「どの candidate group に属するか」「invalid として弾かれたか」を後から機械的に確認できる。
`records.length`（ingest 件数）と、aggregate 内で参照される finding_id の総数（`invalid` の件数
＋ 全 `canonicalFindings[].sources` の延べ数 ＋ `unrecognized` の件数）は常に一致する。

`status` が `normalized` / `invalid` のいずれでもない record（`structured-findings.json` が
本 runtime 以外の手段で書き換えられた場合等の想定外入力）は `unrecognized[]` へ分離して残す
（`counts.unrecognized`）。正規化系の集計（`canonical` / `actionable` 等）からは除外するが、
`invalid` と同様に silent には消えない。`report` の人間可読出力にも `counts.unrecognized` を
表示し、1件以上ある場合は警告行を追加する — machine が検出・保持している値が、人間向け表示
だけで見えなくなり「正常な空結果」と誤読されることを防ぐため。

## 並行実行・破損時の挙動

- **同一 snapshot への `ingest` は排他制御される。** `ingest` は開始時に
  `structured-findings.json.lock` を排他新規作成（OS レベルでアトミック）し、取得プロセスの
  `pid`・取得時刻を JSON として書き込んだうえで、処理完了後に削除する。**削除前に自分（実行中の
  プロセスの pid）が取得したロックであることを確認し、一致しない場合は削除しない**（人間が
  誤って残留と判断し手動削除した後に別プロセスが取得したロックを、無条件 unlink で消してしまうと
  排他制御が再び壊れるため）。同一 snapshot へ別の `ingest` が実行中の場合は、ロックファイルの
  存在とその中身（pid・取得時刻。読めない/壊れている場合はその旨）を示す明確なエラーで
  fail-loud する（無音のデータ消失はしない）。異常終了でロックファイルが残った場合は手動削除が
  必要だが、まずエラーメッセージが示す pid が実際に実行中か（例: `ps -p <pid>`）を確認し、
  異常終了による残留だと判断できてから削除すること（実行中のロックを誤って削除すると排他制御
  そのものを再び壊す）。**ロックの中身から pid が判明しない場合（空・壊れている・pid 未記載）、
  エラーメッセージは実行不可能な `ps -p` の案内をせず、他に ingest プロセスが実行中でないことを
  別の方法で確認するよう促す。** それでも複数 reviewer の ingest は逐次実行を基本とする
  （同時実行自体は「失敗して再実行を促す」形で安全に扱えるが、狙って並行実行する運用は
  想定していない）。
- **`report` / `metrics` は aggregate の鮮度を検査する。** `aggregate` は集計時点の
  `structured-findings.json` の records 内容から決定的なハッシュ（SHA-256）を計算し、
  `structured-findings-aggregate.json` の `sourceHash` として保存する。`report` / `metrics` は
  現在の `structured-findings.json` から同じ方法でハッシュを計算し直し、`sourceHash` と比較する。
  `ingest` により件数が増えた場合はもちろん、**件数を変えずに内容だけが変わった場合（例: 壊れた
  artifact を削除して同数の finding を re-ingest する）も含めて**不一致を検出し、古い集計を
  黙って使わず fail-loud する（先に `aggregate` を再実行するよう促す。件数だけを比較する実装では
  このケースを検出できない — review-adversarial A1: 実行検証済み）。`structured-findings.json` が
  存在するのに `records` フィールド自体が壊れている場合（例: 手動破損で `{}` になった）は、
  `?? []` への黙った fallback によるハッシュ比較（破損後の空配列ハッシュが、一度も ingest して
  いない正当な空集計由来の `sourceHash` と偶然一致してしまう狭いケースがある）には頼らず、
  `records` が配列でないこと自体を検出して fail-loud する。
- **`report` / `metrics` は aggregate の `schemaVersion` も検証する。** canonical finding の形状
  （例: round8 で追加した `actionableReporters` / `assessmentSourceFindingId`）が変わっても、
  `sourceHash` による鮮度チェックは ingest 内容の変化しか検知しないため、以前のコード版が生成した
  成果物をすり抜けさせてしまう。`schemaVersion` が現在のコードの値と一致しない場合（値違い・
  フィールド欠落のどちらも含む）、`report` / `metrics` は生の例外ではなく `aggregate` の再実行を
  促すエラーで fail-loud する（review-adversarial A9-1: 実行検証済み）。
- **`aggregate` は「ingest ログが無い」ことを常に正当な空集計とはみなさない。**
  `structured-findings.json` が存在しない状態で `structured-findings-aggregate.json` が
  `totalIngested > 0` を記録している場合（ingest ログが削除された疑いがある状態）、`aggregate`
  は黙って空集計で上書きせず、ガイド付きエラーで fail-loud する（review-operability round6
  Finding#1: 実行検証済み。壊れた ingest ログを削除する復旧手順 → report の鮮度検出 → 案内どおり
  aggregate 再実行、という連鎖で過去の集計結果を不可逆に失う経路があった）。意図した操作
  （本当に集計をリセットしたい）である場合は、先に古い `structured-findings-aggregate.json` も
  削除してからやり直す。
- **`structured-findings.json` / `structured-findings-aggregate.json` の書き込みはアトミックである。**
  一時ファイルへ書き込んでから同一ディレクトリ内で `rename` する（OS レベルでアトミック）ため、
  ロックを取得しない読み手（`aggregate` / `report` / `metrics`）が truncate 直後〜書き込み完了前の
  不完全な内容（torn read）を観測することは構造的に無い——常に「書き込み前の完全な内容」か
  「書き込み後の完全な内容」のいずれかだけを観測する。
- **artifact 自体が壊れている場合**（JSON 構文エラー・`records` が配列でない等）も、後続の
  `ingest` / `aggregate` / `report` / `metrics` は生の例外ではなく復旧手順を示すエラーで
  fail-loud する。

## PR record / retrospective との接続

`docs/pr/PR-{番号}.md`「内部レビュー所見の裁定」の既存 bullet 形式（表形式にしない規約。
`scripts/analyze-pr-history.js` の regex parser を意図的に回避するため）は変更しない。任意で
各 bullet に `finding_id: f-0007` を1行追記することで、#648 verifier sidecar や
retrospective 分析が同じ finding を参照できるようにしてよい。**historical な PR record の一括
書き換えは行わない**（本 PR 以降の新規記録から任意で使えるようにするだけ）。

## Non-goals（別スコープ）

- finding 単位の independent verification sidecar（`confirmed` / `refuted_evidence` /
  `unresolved_concern`。issue #648 で実装済み。正本:
  [review-finding-verification-runtime.md](review-finding-verification-runtime.md)）
- reviewer agent（`.claude/agents/review-*.md`）の出力契約を JSON 必須へ変更すること
- `review-plan.js` / `shadow-routing.js` / `review-angle-tokens.js` / `review-exec-config.js` /
  `check-artifacts.js` の authority routing・Tier・Artifacts Gate・review budget の再設計

## 関連

- [docs/planning/review-system-phase5-plan.md](../planning/review-system-phase5-plan.md) §7・§8 — 設計判断・移行方針の正本
- [review-angles/finding-criteria.md](review-angles/finding-criteria.md) — 所見の計上基準（scope_relation / severity / evidence / Actionable の人間向け説明。本書はその machine 実装）
- [docs/ai/rules/docs-maintenance.md](../ai/rules/docs-maintenance.md)「agent-commons の projected file」— `review-finding-contract.js` を手編集しない理由
