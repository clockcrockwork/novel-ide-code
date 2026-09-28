# Finding 単位 verifier sidecar（consumer 実装。issue #648）

> **Ground truth:** 共通 verdict 語彙・schema の正本は `agent-commons`
> [`core/contracts/review-finding-contract.js`](https://github.com/clockcrockwork/agent-commons/blob/main/core/contracts/review-finding-contract.js)
> の `REVIEW_VERIFICATION_SCHEMA` / `VERIFICATION_VERDICTS`（consumer 側 projected:
> `scripts/agent/review-finding-contract.js`）。**verdict enum・common schema をこのファイルへ
> 複製しない** — 常に import して使う。本書は consumer（novel-ide）側の artifact 形状・binding・
> 実行フロー・metrics・duplicate policy・human adjudication 比較経路の正本。
> **Entry gate:** #647 の structured-findings.json に normalized finding が ingest 済みで、
> その finding_id を独立に再検証したい場合に使う。verifier 実行自体を必須化するものではない
> （#648 は observational / advisory な sidecar の導入であり、reviewer 起動義務・Tier・
> Actionable 判定・review budget を変更しない）。
> **Required artifacts:** `structured-findings-verifications.json`（snapshot ディレクトリ内。
> `structured-findings.json` と同じく disposable execution cache）。
> **Verification gate:** `node --test tests/reviewFindingVerificationNormalize.test.js tests/reviewFindingVerifier.test.js`
> （`npm run test:node` に含まれる）。

## 位置づけ

`docs/agent-workflows/review-findings-runtime.md`（#647）が確立した
`finder → structured finding → deterministic aggregation` の**後段**に、finder 自身の
`evidence` 自己申告（`verified`/`strong`/`weak`）だけに依存しない、finding 単位の独立検証を
追加する。

```
structured-findings.json（#647。source of truth）
  ↓ target resolution（finding_id の一意解決 + 鮮度ハッシュ取得）
verifier prompt payload（finding_id・file・line・summary・failure_scenario・scope_relation・
                          severity・evidence・provenance・findingDigest）
  ↓ verifier 実行（bounded。model/effort/maxTurns は consumer 側 config）
raw verifier response（信頼しない — schema validation 前は authoritative ではない）
  ↓ record（schema validation + finding_id 一致検証 + 鮮度再検証）
structured-findings-verifications.json … snapshot ディレクトリ内。append-only ingest log
  ↓ report / metrics（最新 accepted attempt の決定的選択）
人間可読サマリ / confirmed・refuted_evidence・unresolved_concern の件数・率
  ↓ （任意）人間裁定との比較
record-human によるagreement/disagreementの最小限比較
```

**重要な境界**: verifier は新しい review angle ではない（`ANGLE_TOKENS` /
`CONDITIONAL_ANGLE_TOKENS` / `selectedAngles` / `effectiveAngles` / `TIER_ANGLES` のいずれにも
登録しない）。verifier の verdict は Actionable 判定・merge blocker にならず、finder の
`severity` / `scope_relation` / `evidence` を書き換えない。`Actionable + refuted_evidence` の
組み合わせも、実行時 authority としては finding をそのまま残す（false positive **候補**の
metrics として記録するのみ）。

## モジュール構成

| ファイル | 責務 | 副作用 |
|---|---|---|
| [`scripts/agent/review-finding-verification-normalize.js`](../../scripts/agent/review-finding-verification-normalize.js) | 生 verification 結果の schema 検証・正規化（純粋関数） | なし |
| [`scripts/agent/review-finding-verifier.js`](../../scripts/agent/review-finding-verifier.js) | 対象解決・鮮度検証・CLI・書き込み（append-only）・report/metrics・人間裁定比較 | あり（fs） |

`review-findings.js` から `resolveSnapshot` / `readJsonOrThrow` / `readJsonIfExists` /
`writeJson` / `assertArtifactBinding` / `acquireIngestLock` / `releaseIngestLock` /
`sanitizeForDisplay` / `isFiniteNumber` を re-export してもらい、パーサ・アトミック writer・
snapshot 解決・artifact binding のロジックを複製しない（#647 と同じ規約を共有する）。
`hashFindingsContent`（#647 の array-wide ハッシュ）は再利用しない — 鮮度検証は finding 単位の
digest（後述）で行うため。

## CLI

```bash
# 対象解決 + verifier へ渡す prompt payload の生成（findingDigest を必ず控えておく）
node scripts/agent/review-finding-verifier.js target \
  --snapshot <snapshot-id> --finding-id f-0001

# verifier の raw JSON 出力を記録する（--finding-digest は上の target 出力の値をそのまま渡す）
node scripts/agent/review-finding-verifier.js record \
  --snapshot <snapshot-id> --finding-id f-0001 \
  --finding-digest <findingDigest> --input /path/to/raw-verdict.json

# verifier 起動そのものが失敗した場合（model 失敗・timeout/maxTurns・tool failure 等）
node scripts/agent/review-finding-verifier.js record \
  --snapshot <snapshot-id> --finding-id f-0001 --finding-digest <findingDigest> \
  --execution-error timeout --detail "maxTurns に到達"

# 人間裁定の記録（最小限。任意）
node scripts/agent/review-finding-verifier.js record-human \
  --snapshot <snapshot-id> --finding-id f-0001 --adjudication valid

# 人間可読サマリ / metrics
node scripts/agent/review-finding-verifier.js report --snapshot <snapshot-id>
node scripts/agent/review-finding-verifier.js metrics --snapshot <snapshot-id> [--angle <観点>]
```

npm script: `npm run review:verify-finding -- <subcommand> [options]`。

`review:findings`（#647）とは別コマンドにした理由: 対象解決（finding_id 単位）・鮮度検証
（findingDigest の往復）・verifier 実行結果の受け取りという異なる入出力形状を持ち、`ingest`
（バッチの raw finding 配列）とは自然な単位が異なるため（issue #648「CLI / user-facing flow」）。

## finding_id 解決（target resolution）

verifier は #647 の `structured-findings.json` を source of truth とする（aggregate の
representative finding を検証対象の identity として使わない — issue #648「Verifier input」。
aggregate は候補選定・表示にのみ使ってよい）。`resolveVerificationTarget` は以下を満たす場合
のみ finding を返し、それ以外は fail-loud する（silent orphan を作らない）:

- 対象 snapshot の `structured-findings.json` が存在し、`schemaVersion` / `contractVersion` /
  `snapshotId` が現在のコード・snapshot と一致する（#647 の `assertArtifactBinding` を再利用）
- `finding_id` に一致する record が**ちょうど1件**存在する（0件=未知、2件以上=手編集・破損に
  よる重複。#647 既知 Low residual への対処）
- その record の `status` が `normalized`（`invalid` / `unrecognized` レコードは検証対象にしない）

戻り値には `findingDigest`（この finding_id **1件分**の内容だけから計算した鮮度ハッシュ）を
含む。`target` サブコマンドの呼び出し元はこの値を控え、`record` 呼び出し時に**そのまま渡し
返す**契約になっている。

### なぜ array-wide の sourceHash ではなく finding 単位の digest なのか

実装当初は #647 の `hashFindingsContent`（`structured-findings.json` の records 全体から計算
するハッシュ。aggregate の鮮度チェックが使うのと同じ関数）をそのまま再利用していたが、独立
レビューでこれが実運用に合わない設計だと判明した: 反復的なレビュー運用では、ある finding を
verify した**後**に別の（無関係な）finding が追加 ingest されることが普通に起こる。
array-wide のハッシュで鮮度を見ると、この無関係な追加のたびに**すべての**進行中 verification
が偽陽性で stale 扱いになってしまう。

individual finding の内容は ingest 後不変（#647: append-only、finding は書き換えられない）
なので、finding_id 単位の digest（`findingContentDigest(finding)`）は通常運用では**決して
変化しない**。実際に変化しうるのは、手編集・破損した artifact を削除して**同じ finding_id へ
別内容を再 ingest した**場合（#647 既知 Low residual）だけであり、これはまさに検出したい
劣化ケースそのものである。finding 単位の digest はこの本来の危険だけを捉え、無害な同時進行の
追加を誤検出しない。

## 鮮度（staleness）— write 時と read 時の両方で検証する

`record` は渡された `--finding-digest` を、record 時点で再計算した**現在のこの finding_id の**
digest と比較する。一致しなければ `outcome: 'rejected'` として記録し、決して verdict として
受理しない（issue #648「Artifact freshness / binding」）。これにより、次のいずれのケースも
「stale な verification」として拒否される（write 時点）:

- `target` 実行後、この finding_id 自身の内容が変わった（破損復旧による同一 finding_id への
  別内容の再 ingest 等）
- 別 snapshot 由来の verdict（対象 finding_id が存在しないか、内容が一致しない）を誤って
  record しようとした

**write 時の検証だけでは不十分である**（独立レビューで指摘・実装検証済み）。`recordVerification`
が accepted と判定した時点では鮮度が正しくても、その**後**に同じ finding_id の内容が変われば
（同上のケース）、write 時点の判定はもはや current ではなくなる。`report` / `metrics` は
`attempts[]` を読むだけでは「過去のある時点で鮮度検証を通過した」という事実しか分からないため、
`partitionByFreshness` が読み取り時点でも同じ digest 比較を行い、現在の finding 内容と一致
しない selected 結果を `stale[]` へ分離する。`buildVerificationMetrics` は stale な結果を
confirmed/refuted/unresolved のいずれにも計上せず、`staleSelected` という独立の件数として
可視化する（silent には消さない。#647 の `counts.unrecognized` と同じ思想）。`formatVerificationReport`
も stale な finding_id を警告行として明示する。

## verdict 語彙と outcome 語彙の違い

**common** `REVIEW_VERIFICATION_SCHEMA` の `verdict` は `confirmed` / `refuted_evidence` /
`unresolved_concern` の3値のみ（agent-commons 正本。novel-ide では拡張しない）。

**consumer envelope** の `outcome`（`review-finding-verifier.js` が record 時に決める分類）は
これとは別の語彙で、「schema-valid な verdict に到達したか」を表す:

| outcome | 意味 | verdict を持つか |
|---|---|---|
| `accepted` | schema 検証・finding_id 一致・鮮度検証すべて通過 | 持つ（`confirmed`/`refuted_evidence`/`unresolved_concern`のいずれか） |
| `rejected` | schema 不正・finding_id 不一致・鮮度不一致のいずれか | 持たない |
| `execution_error` | verifier 起動・実行そのものが失敗（`executionStatus` で内訳を持つ） | 持たない |

**critical safety invariant**: `rejected` / `execution_error` のいずれも、`finding` の
`refuted` / `dismissed` / `non-actionable` への自動変換には**絶対に**ならない。
`buildVerificationMetrics` の `confirmed` / `refutedEvidence` / `unresolvedConcern` は
`outcome: 'accepted'` の attempt からしか計上されない。

`executionStatus` は閉じた語彙（`EXECUTION_ERROR_STATUSES`）: `model_failure` /
`malformed_json` / `empty_output` / `partial_output` / `timeout` / `tool_failure` /
`unknown`。未知の文字列は `unknown` へ丸める（review-findings.js の `isKnownAngle` と同じ
「未検証の入力をそのまま無検証で記録しない」思想）。

## Duplicate verifier result のポリシー

`record` は append-only ログ（#647 の `ingest` と同じ思想）: 同一 `finding_id` への複数回の
`record` 呼び出しはすべて `attempts[]` に残り、既存 attempt を上書きしない。

集約（`deriveVerificationView`）は「その finding_id の `outcome: 'accepted'` な attempt の
うち `seq` が最大のもの」を **selected** として決定的に採用する（**多数決はしない**。issue
#648「Duplicate verifier results」の "explicit latest selected" 方針）。selected 以外の
accepted attempt・すべての rejected/execution_error attempt は監査用にそのまま残るが、
metrics/report の集計対象は selected のみ。

## Metrics

`review-finding-verifier.js metrics --snapshot <id> [--angle <観点>]` が返す最小限の指標
（issue #648「Metrics」）:

- `verifiedTotal` / `confirmed` / `refutedEvidence` / `unresolvedConcern`（件数・率。read 時鮮度
  再検証〔`partitionByFreshness`〕を通過した selected 結果のみが対象）
- `rejectedTotal` / `executionErrorTotal`
- `staleSelected`（read 時点で鮮度不一致と判定され、上記件数から除外された selected 結果の件数。
  0件以上あれば再検証を促す。silent には消さない）
- `actionableRefutedEvidence`（Actionable な finder finding → verifier `refuted_evidence` の
  件数。**これ自体を「確定 false positive」とは宣言しない** — 人間裁定との比較が揃って
  初めて強いシグナルになる。issue #648「False positive measurement」）
- `--angle` 指定時: 対象 finding の `provenance.angle`（`structured-findings.json` から
  finding_id で突き合わせる）で絞り込んだ同じ内訳
- `humanComparison`: `record-human` で記録された人間裁定と selected verdict が両方揃っている
  finding_id についてのみ agreement/disagreement を数える（次節）

## 人間裁定との比較（最小限）

リポジトリ内を調査した結果、機械可読な既存の人間裁定ソースは無い
（`docs/pr/PR-{番号}.md`「内部レビュー所見の裁定」は意図的に非表形式のプレーンな箇条書きで
あり、`scripts/analyze-pr-history.js` の regex parser を回避する設計 — #647 のドキュメントに
明記されている。`finding_id` を1行併記する運用はあるが、構造化パースは想定されていない）。

新しい lifecycle / state machine を作らず、`record-human --snapshot <id> --finding-id <id>
--adjudication valid|false_positive|uncertain` という最小限の比較入力だけを追加する。
finding artifact・verifier の `attempts[]` のどちらも書き換えず、同じ verification artifact
内の独立した `humanAdjudications[]` 配列に追記するだけ。`metrics` は両方揃った finding_id
だけで agreement/disagreement を数える（`confirmed`↔`valid`・`refuted_evidence`↔
`false_positive` は agreement、`confirmed`↔`false_positive`・`refuted_evidence`↔`valid` は
disagreement、それ以外〔`unresolved_concern` を含む〕は中立として数えない）。

大規模な比較が必要になった場合（例: PR record を構造化データへ移行する）は、別途 issue で
評価する（issue #648 の human-return condition: 「Verifier-vs-human comparison が大きな
新しい lifecycle / state machine を要求する」場合はスコープ外）。

## 実行設定（model / effort / maxTurns）

verifier の起動そのもの（LLM 呼び出し）は本モジュールの責務外 — `review-finding-verifier.js`
は `target` で prompt payload を出力し、`record` で結果を受け取るだけの決定的な CLI で、
モデル呼び出しは呼び出し側（orchestrator / 将来の `.claude/agents/` wrapper）が行う。

`scripts/agent/review-exec-config.js` の `ANGLE_EXEC_BASELINE` と同じ表形式で、将来
verifier 専用の起動 wrapper を追加する場合は `NON_ANGLE_EXEC_BASELINE` と同じ扱い（観点
レビュアーの必須集合〔`ALL_ANGLE_KEYS`〕には加えない）にする。初回導入時の dogfood
（本 PR）では、bounded な単一 finding 単位の再検証という性質上、観点レビュアーの中位設定
（`model: sonnet, effort: medium`）を出発点として妥当と判断した — 高コストモデルを既定に
せず、consumer 側で override 可能な位置づけとする（issue #648「Model/effort decision」）。
実運用の model/effort/maxTurns 決定は、本 PR の dogfood 結果を入力として別途 Phase 5 の
実行工程会議判断へ持ち越す。

## Non-goals（このモジュールが行わないこと）

- 広範囲の新規 finding 探索（verifier は該当 finding 単独の再検証のみ）
- severity / scope_relation / finder の `evidence` の書き換え
- 意味的重複判定・finding の採否判定（#647 の aggregation と同じ境界を維持する）
- `refuted_evidence` → 自動削除・自動降格、`unresolved_concern` → `refuted` 扱い、
  verification 欠落 → `refuted` 扱いのいずれも実装しない（critical safety invariant）
- `ANGLE_TOKENS` / `TIER_ANGLES` / review budget / Artifacts Gate 必須 reviewer 集合の変更
- 最終独立レビュー・security review の代替
- unresolved_concern からの自動再起動・自動 escalation（bounded one-pass のみ）

## 関連

- [review-findings-runtime.md](review-findings-runtime.md) — #647: source of truth の finding artifact・aggregation 規則の正本
- [docs/planning/review-system-phase5-plan.md](../planning/review-system-phase5-plan.md) §7 — 実装状況の注記
- [docs/ai/rules/docs-maintenance.md](../ai/rules/docs-maintenance.md)「agent-commons の projected file」— `review-finding-contract.js` を手編集しない理由
