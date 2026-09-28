# レビュー振り返り（escaped finding 起因の根本原因分析）

> **Ground truth:** `docs/pr/PR-{番号}.md`（対応履歴・内部レビュー所見の裁定・最終独立レビューの実施記録・トリアージ結果）/ PR 本文の `## セカンドオピニオン記録`（high-risk second opinion のPR固有 instance evidence。対応発生時は `docs/pr/PR-{番号}.md` にも記録される）/ [second-opinion-review.md](second-opinion-review.md)（high-risk second opinion の gate 定義・Required artifacts の正本。**PR固有の実施記録ではない**）/ PRコメント・差分 / `docs/planning/pr-history-schema-design.md` §3（統制語彙）/ 各内部ゲートの成果物（完了条件チェックリスト・想定ケース表・既存実装調査表・レビューループ記録・テスト・lint/CI ログ）/ 検出漏れ分類（miss taxonomy）の routing-miss 判定用に、ephemeral な `.git/agent-review/` 配下の成果物（存在する場合のみ。[review-angles/README.md](review-angles/README.md)「共通成果物（snapshot）」参照）
> **Entry gate:** 観点別レビュー・`/security-review` が収束（新規所見ゼロ。[review-pr.md](review-pr.md) ステップ7）し、**最終独立レビューはその実施が必要な場合に実施済みである**（要否・実施は [review-pr.md](review-pr.md) ステップ7「唯一の例外」／[review-angles/README.md](review-angles/README.md) 手順8の正本に従う。現行 actual contract では毎回 required のため挙動は変わらない）の後に実行する。対象選別（外部レビューまたは既存の独立 review gate〔最終独立レビュー・high-risk second opinion 等〕で確認された正当な新規 escaped finding か）を終えるまで原因分析に進まない。分析は実装・修正コンテキストを持たないサブエージェントで行う
> **Required artifacts:** `docs/pr/PR-{番号}.md` の `## レビュー振り返り` セクション（所見ごとの 発生原因／本来の捕捉工程／通過理由／根拠／再発防止／検出漏れ分類。対象が0件なら記録不要）
> **Verification gate:** 発生原因・捕捉工程・再発防止が `docs/planning/pr-history-schema-design.md` §3.3／§3.6／§3.5 の統制語彙内であること、検出漏れ分類が本ファイルが定める4値（`routing-miss`／`detection-miss`／`aggregation-miss`／`machine-miss`）または `不明（欠けている証跡: …）` のいずれかであること、根拠パスが実在すること → [docs/ai/rules/verification-gates.md](../ai/rules/verification-gates.md)
> **Anti-skip:** [docs/ai/README.md](../ai/README.md)「anti-skip rule」を参照。「外部指摘や独立 review gate（最終独立レビュー・high-risk second opinion 等）の所見が軽微だった」を理由に対象選別自体を省略しない（実施のうえ対象0件なら記録は不要）
> **Cost note:** 記録がないと、同型の見落としが同じ内部ゲートを再び素通りし、回帰テスト1件で閉じた学習が他実装へ還元されず、外部レビュー依存とレビューコストが固定化する
<!-- agent-commons:generated source=workflow-review-retrospective version=1.0.0 — 手編集しない。正本は agent-commons/core と docs/agent-workflows/overlays -->

引数: PR番号（省略時は現在のブランチのPR）。

外部レビュー（GitHub 上のレビューコメント。別モデル・別セッションを含む）または既存の独立 review gate（最終独立レビュー〔[review-pr.md](review-pr.md) ステップ7「コード品質・セキュリティ確認」／[review-angles/README.md](review-angles/README.md) 手順8〕・high-risk second opinion〔[second-opinion-review.md](second-opinion-review.md)〕等）で確認された、内部の観点別レビュー・machine gate から escape した正当な新規指摘について、**(1) なぜ問題が発生したか（発生原因）**、**(2) なぜ内部工程で捕捉できなかったか（内部検出漏れ原因）**、**(3) 内部レビュー機構のどの層で見逃したか（検出漏れ分類 / miss taxonomy）**を分析し、`docs/pr/PR-{番号}.md` に学習可能な形で記録する。(3) は (1)(2) を置き換える分類ではなく、両方を残したまま追加する軸である（手順4）。「何を直したか」の記録は対応履歴（[review-pr.md](review-pr.md) ステップ8）、「何へ昇格したか」の判断はレビューループの昇格判断（[pre-commit-review.md](pre-commit-review.md) ステップ6）がすでに担っており、本ワークフローはそれらを**再掲せず参照**したうえで、原因と検出漏れの分析だけを追加する。

## 実行タイミングと実施者

- **タイミング**: [review-pr.md](review-pr.md) ステップ7.5。観点別レビュー・`/security-review` が収束（新規所見ゼロ）し、**最終独立レビューはその実施が必要な場合に実施済み**（要否は [review-pr.md](review-pr.md) ステップ7「唯一の例外」／[review-angles/README.md](review-angles/README.md) 手順8に従う）になった後、ステップ8（PRログ更新）の前。レビュー対応の途中では実行しない（分析対象＝そのラウンドの確定したトリアージ結果と、実施済みの場合は最終独立レビューの所見）。
- **入力の受け渡し**: 当該ラウンドの確定済みトリアージ表・最終独立レビューの所見・PR 本文の `## セカンドオピニオン記録` はこの時点ではまだ `docs/pr/PR-{番号}.md` に書かれていない（書くのはステップ8）。サブエージェントは PR 本文を自動では取得できないため、メインセッションがサブエージェント起動時に**当該ラウンドのトリアージ表（外部レビュー分）と、実施済みの場合は最終独立レビューの所見・PR 本文の `## セカンドオピニオン記録`（あれば）を入力として渡す**（例: 起動プロンプトにトリアージ表・最終独立レビューの所見・セカンドオピニオン記録のテキストを貼り付ける、または `/review-retrospective {PR番号}` 実行時にコンテキストとして添える）。過去ラウンドの対応履歴・各内部ゲートの成果物はサブエージェントがファイルから読む。
- **実施者**: 実装・修正コンテキストを持たないサブエージェント（`.claude/agents/review-retrospective.md`）。実装者と同じコンテキストで分析すると盲点が相関するため（[subagent-roles.md](subagent-roles.md) 原則3と同じ理由）、成果物・diff・記録のみから分析する。サブエージェントは分析結果を返答で返し、`docs/pr/PR-{番号}.md` への転記はメインセッション（review-pr 実施者）が行う（既存 review-* の「検出のみ・修正しない」契約と同型）。

## 手順

### 1. 対象選別

そのラウンドのトリアージ結果（起動時に渡された当該ラウンドのトリアージ表。書式は対応履歴の表と同一）から、以下の**すべて**を満たす指摘を対象とする：

| 条件 | 判定基準 |
|------|---------|
| 由来（escape 経路） | 次の (a)(b)(c) **いずれかを満たす**。**(a) external first-found**: 当該 valid defect が GitHub 上のレビューコメントとして届いた指摘（外部レビュアー: Codex / Gemini / Copilot / 人間・別モデル・別セッション）により**初めて**発見された。**(b) aggregation rediscovery（`aggregation-miss` 候補）**: 同じ valid defect について内部所見（`## 内部レビュー所見の裁定` に記録された finding）が既に存在したが、dedup／[review-angles/finding-criteria.md](review-angles/finding-criteria.md) の計上基準／裁定／集約で誤って drop・non-Actionable 化されており、その後 external reviewer が独立に同じ defect を再発見し GitHub 上のレビューコメントとして届いた。**(c) independent first-found**: 通常の観点別レビュー・`/security-review` が対象 defect を Actionable として捕捉していない状態で、**既存の独立 review gate**（[review-pr.md](review-pr.md) ステップ7／[review-angles/README.md](review-angles/README.md) 手順8の最終独立レビュー〔修正コンテキストを持たないレビュアーによる fresh・全体再探索の1回〕、または [second-opinion-review.md](second-opinion-review.md) が定める high-risk second opinion 等。normal angle／conditional angle／sidecar のいずれでもない既存の外部/独立ゲート全般を指し、特定の provider・実装手段には固定しない）が**初めて**発見した valid Med+ の escaped finding。単に「通常の観点別レビュアーが既に Actionable と裁定しており、対応履歴・内部レビュー所見の裁定上まだ修正されていない」だけのケースは (b)(c) いずれにも含めない（詳細な判定は手順4）。分析対象の入力は、(a)(b) は `## 対応履歴` の表に記録される指摘（当該ラウンド分は起動時に渡されたトリアージ表）に限り、(c) は最終独立レビューの実施記録（`docs/pr/PR-{番号}.md` の `## 内部レビュー所見の裁定` または最終独立レビュー実施記録行。[review-pr.md](review-pr.md) ステップ7 注記）または PR 本文の `## セカンドオピニオン記録`（対応発生時は `docs/pr/PR-{番号}.md` の記録も併せて確認する）に限る。**[second-opinion-review.md](second-opinion-review.md) は high-risk second opinion の gate 定義・Required artifacts の正本であり、それ自体は当該 PR での実施証跡ではない**——(b)(c) の裏付けとして参照する場合を除き、通常の観点別レビュー・`/security-review` の内部所見は「内部で捕捉できなかった理由」を判定するための**参照側**として使う |
| 正当な新規指摘 | 判断が ✅（または前提失効による ✅ への再分類）である |
| 影響がある | バグ・回帰・データ破壊・セキュリティ・性能・重大なUX不整合につながる |
| 学習価値がある | 同種の再発可能性がある、または内部工程で捕捉できた可能性がある |

以下は**対象外**（分析しない。宣言行に1文で集約する）：

- reviewer misread（誤読・誤指摘）
- 既存指摘の言い換え・重複
- 命名や好みに近い軽微な指摘
- 通常の観点別レビュー・`/security-review`（Tier に従って起動された系統。**最終独立レビュー・high-risk second opinion 等の独立 review gate は含まない**）ですでに発見・Actionable と裁定済みで、上記(b)（`aggregation-miss` 候補）にも(c)（`independent first-found`）にも該当しないもの（例: 対応履歴・内部レビュー所見の裁定の通常フローで対応待ちなだけのもの。(b)(c) に該当する場合は対象——手順4参照）
- 事前検出の現実性が低く、再発防止へ還元する価値が小さいもの

対象が0件の場合、記録は不要（`docs/pr/PR-{番号}.md` への `## レビュー振り返り` セクション追加自体を省略してよい）。

### 2. 発生原因の分析

対象所見ごとに、問題そのものがなぜ生じたかを `docs/planning/pr-history-schema-design.md` **§3.3 `root_causes`** の統制語彙から選ぶ（例: `external-boundary-validation`, `position-mapping-bug`, `async-stale-state`, `test-oracle-weakness`）。補足は1文。次の2ケースを区別する（手順3の 通過理由 と対称に扱う）：

- **原因は証跡から特定できるが、厳密に一致する統制語がない**: 最も近い語＋補足で表現し、語彙追加の必要性を所見として返答に残す（**語彙を新設しない**。追加ガバナンスは別途判断する）。
- **原因が証跡から特定できない**: 推測で最も近い語を選ばず、`不明（欠けている証跡: …）` と記録する（`root_causes` を強制分類しない。誤分類のまま `confidence: curated` 相当で横断集計されるのを防ぐ。未確定時デフォルト `[]`・手順3の 不明 扱いと揃える）。

### 3. 内部検出漏れの分析

本来どの工程で捕捉できたか（**§3.6 `implementation_phase_catchable`**: `planning` / `implementation-self-review` / `pre-commit-review` / `ci` / `pr-review-only` / `not-worth-preventing` / `unknown`）を1つ選び、**なぜ実際にその工程を通過したか（通過理由）**を該当工程の成果物・証跡に基づき1〜3文で書く。

通過理由では次の2クラスを必ず区別する：

- **工程が実施されていなかった**（例: 想定ケース表にそのケース自体がなかった／codebase-recon の調査範囲外だった）
- **工程は実施されたが通過した**（例: 想定ケースにはあったが実装・テストへ反映されなかった／テストはあったが入力クラス・assertion が不足した／lint の判定境界が届かなかった／review angle の Tier 判定で系統が起動されなかった／機械ゲートが fail-open だった）

証跡が足りず確定できない場合は、推測で埋めずに `不明（欠けている証跡: …）` と記録する。「テスト不足」のような抽象語だけで終わらせず、どの入力・境界・assertion が不足したかを可能な範囲で具体化する。

### 4. 検出漏れ分類（miss taxonomy）の分析

手順2（発生原因）・手順3（本来の捕捉工程・通過理由）とは別の軸として、**内部レビュー機構（angle の routing／各 reviewer unit の検出／finding の集約／machine gate）のどの層で今回の escaped finding（由来は手順1の (a)/(b)/(c) いずれでもよい）が素通りしたか**を次の4値から1つ選ぶ。この分類は発生原因・本来の捕捉工程・再発防止（`docs/planning/pr-history-schema-design.md` §3.3／§3.6／§3.5 の統制語彙）を**置き換えない**——両方を残したまま追加する軸である。例えば「発生原因: `test-oracle-weakness` ＋ 検出漏れ分類: `detection-miss`」「本来の捕捉工程: `ci` ＋ 検出漏れ分類: `machine-miss`」はどちらも成立する組合せである。

| 分類 | 意味 |
|---|---|
| `routing-miss` | 本来必要だった semantic angle／conditional angle／sidecar が selection されなかった（例: security-relevant な変更なのに adversarial／`/security-review` が routing されていなかった） |
| `detection-miss` | 必要な unit は正しく起動していたが、その unit 自身が valid Med+ の defect を検出できなかった |
| `aggregation-miss` | finding 自体は内部で発見されていたが、dedup／[review-angles/finding-criteria.md](review-angles/finding-criteria.md) の計上基準／裁定／noise filtering 等で誤って drop された |
| `machine-miss` | 本来 machine が担うはずのカテゴリだったが、scope／設定／配線／実行／enforcement 等の問題で検出されなかった |

**`routing-miss` の判定**: 可能な範囲で次の証跡を確認する。

- 当該 `.git/agent-review/` snapshot の起動計画（`review-plan.json` 等。[review-angles/README.md](review-angles/README.md)「共通成果物（snapshot）」参照）
- consumer 側に snapshot-bound な routing assessment／shadow routing selection の記録があれば、その内容
- 実際に起動した legacy review plan・実施記録（対応履歴・レビューループ記録）
- manual escalation の有無（`escalate` による加算）。**provenance の判定は `review-state.json` の `state.escalations` のうち `kind === 'manual-escalation'` であるものに限る**——`state.addedAngles` は manual-escalation と tier-reclassification（legacy Tier の自動再分類）を区別しない legacy execution cache であり、**manual escalation の provenance source として使わない**（その時点で実効的に起動していた angle 集合を確認する補助情報としてのみ参照してよい）
- 対象所見が本来どの unit（通常 angle／conditional angle／sidecar）の責務だったか

**ephemeral な `.git/agent-review/` が既に破棄されている・存在しない場合、これらの証跡なしに推測で `routing-miss` と判定しない。** ただし**これは miss subtype（4分類のどれか）を確定できるかの問題であり、対象選別（手順1の (a)/(b)/(c) に該当し分析対象になるか）とは別問題である**——(c) 由来など ephemeral 証跡が乏しい所見でも、対象選別自体は `docs/pr/PR-{番号}.md`・レビューループ記録・最終独立レビューの実施記録・PR 本文の `## セカンドオピニオン記録` という恒久証跡だけで判定でき、対象から外さない（`second-opinion-review.md` は gate 定義の正本であり、この恒久証跡そのものではない）。ephemeral 証跡が無いために確定できないのは miss subtype の分類だけであり、その場合は上記のとおり `不明（欠けている証跡: …）` に倒す。

**証拠不足で確定できない場合**: 4分類のいずれかへ推測で押し込まず、`不明（欠けている証跡: …）` と記録する。これは5番目の miss taxonomy ではなく、分類未完了の表明である（手順2の `root_causes` 不明・手順3の 通過理由 不明と同じ扱い）。

**対象由来 (a)/(b)/(c) の位置づけ**: 手順1の「由来」条件は (a) external first-found／(b) aggregation rediscovery／(c) independent first-found の **OR** として成立する（手順1参照）。(b)(c) は「内部で既に発見済み・内部レビューで見つかった、なら常に対象外」という原則への後付けの例外ではなく、手順1の positive gate 自体に組み込まれている。**「内部レビュー」という一括分類で独立 review gate 由来 (c)（最終独立レビュー・high-risk second opinion 等）まで対象外へ落とさない。**

**`aggregation-miss`（(b)）の対象選別**: (b) に該当するかどうかは、対象所見と同じ defect を指す内部所見が `## 内部レビュー所見の裁定` に存在し、その裁定が dedup／裁定／集約により誤って drop・non-Actionable とされていたかで判定する。**単に「内部で発見済みだが（Actionable のまま）対応履歴上まだ修正されていなかった」というだけでは (b) に該当せず、`aggregation-miss` の対象にもならない**（それは対応履歴の通常フローの遅延であり escaped finding ではない）。

**`independent first-found`（(c)）の扱い**: 既存の独立 review gate——最終独立レビュー（修正コンテキストを持たないレビュアーによる fresh・全体再探索）、または [second-opinion-review.md](second-opinion-review.md) が定める high-risk second opinion 等——で初めて発見された valid Med+ の escaped finding は (c) として対象に含む。**(c) は「normal angle／conditional angle／sidecar のいずれでもない既存の外部/独立ゲート」という kind で定義し、特定の provider・実装手段（例: 特定のツール名）に固定しない**——独立 review gate の具体的な実装が変わっても (c) の定義自体は変わらない。**通常の観点別レビュー・`/security-review` が既に同じ defect を Actionable として捕捉していた場合はこの限りでない**（手順1「対象外」参照。独立 review gate が単に同じ所見をなぞっただけのケースは (c) ではなく通常の内部所見として扱う）。(c) は通常の angle routing の外側にある独立確認であり、その独立ゲートで初めて見つかったことこそが4分類（特に `routing-miss`／`detection-miss`）の分析対象になる。

**high-risk second opinion 由来の判定手順**: (c) の由来が high-risk second opinion かどうかは、次をすべて確認してから成立させる。**`second-opinion-review.md`（workflow / gate 定義の文書）の存在だけで (c) を成立させない**——同ファイルは gate definition であり、当該 PR での実施証跡（instance evidence）ではないため、これと切り分けて次を確認する。

1. `second-opinion-review.md` で high-risk second opinion の対象条件・Required artifacts の記録先を確認する（gate 定義の確認）
2. PR 本文の `## セカンドオピニオン記録` を読み、当該 PR で実際に実施されたかを確認する（PR 固有の instance evidence）
3. finding への対応が発生していれば `docs/pr/PR-{番号}.md` の記録も確認する
4. 当該 defect が通常の観点別レビュー・`/security-review` 等で既に Actionable として捕捉済みでないことを確認する（手順1「対象外」参照）

この4点を満たして初めて independent first-found（high-risk second opinion 由来）の候補とする。

**finding contract との整合**: 対象は原則、[review-angles/finding-criteria.md](review-angles/finding-criteria.md) の `scope_relation ∈ {introduced, worsened, newly_exposed}` かつ `severity >= med` かつ `evidence ∈ {verified, strong}` を満たす valid escaped finding とする。「当初の想定ケース表・完了条件に無かった」ことは対象外の理由にしない（同ファイル「Actionable の原則」と同じ扱い）。

**`routing-miss` の学習**: `routing-miss` と判定した場合、次を根拠または再発防止フィールドに記録する。

- signal／semantic dimension／routing policy の回帰 fixture 候補であること
- 必要 unit を直ちに再確認すべきと判断する場合、対象 unit の kind に応じて次のいずれかを**提案**として記録する：
  - **通常 angle／conditional angle**: main session／orchestrator が既存の `escalate`（`scripts/agent/review-plan.js escalate --angles ... --reason ...`）で追加 budget・再確認を割り当てることを提案する
  - **sidecar**（例: `/security-review`）: sidecar は `escalate --angles` の加算対象ではないため、当該 sidecar 固有の既存起動契約（例: `/security-review` の再実行）で再確認することを提案する。特定の sidecar 名に固定せず、対象 unit が実際にどの sidecar かに応じて提案する

  いずれも提案に留め、本ワークフローのサブエージェント自身は `escalate` を実行しない。分析のみ——「実行タイミングと実施者」の責務境界と同じ

この分類の全 PR 横断集計は将来の派生物候補だが、本改定では `scripts/analyze-pr-history.js` の `parsePrFile` 拡張は行わない（現時点は PR 単位の記録のみ）。

### 5. 再発防止・昇格の確認

対象所見ごとに、今回適用した（または適用すべき）再発防止策を **§3.5 `preventable_by`** の語彙（`lint`, `custom-eslint-rule`, `unit-test`, `ci-check`, `review-guideline`, `risk-model-checklist`, `agent-skill`, `design-doc`, `not-practical-to-automate` 等）＋具体アクション（追加したテストのパス／承認フローで作成した issue 番号／改訂先ガイドライン）で記録する。昇格しない場合は `昇格なし（理由: 前提: … ／ 失効条件: …）`（書式は下記「判断は前提つきで書く」）。

すでにレビューループの昇格判断（[pre-commit-review.md](pre-commit-review.md) ステップ6）で記録済みの内容は**再掲せず**、根拠フィールドから参照する（二重記録禁止）。

**判断は前提つきで書く**（[skill-design-rubric.md](skill-design-rubric.md)「判断を記録するスキルの追加基準」）: `昇格なし` の理由は結論だけでなく反証可能な前提として書く——`昇格なし（理由: 前提: {X である限り昇格不要} ／ 失効条件: {…（任意）}）`。前提のない判断は、いつ無効化されたか追跡できない（再発時の失効確認は「再発時の扱い」の項）。`対象なし` 宣言は当該ラウンドのコメントに対する事実分類であり、後から再利用される判断ではないため前提書式は要求しない（1文の理由でよい）。

### 6. 記録

分析結果を `docs/pr/PR-{番号}.md` の末尾に `## レビュー振り返り` セクションとして追記する（新規なら作成。2回目以降のラウンドは同セクション内に実施日行から追記する）。**このセクションは常にファイル末尾に維持する**——後続ラウンドの対応履歴（`### 日付` ＋表）は本セクションより前に挿入する（[review-pr.md](review-pr.md) ステップ8「追記時」）。

**書式（本セクションが正本）：**

```markdown
## レビュー振り返り

<!-- 書式の正本: docs/agent-workflows/review-retrospective.md（表は位置を問わず analyze-pr-history.js に取り込まれるため、本セクションでは表と「### 日付」見出しを使わない） -->

- 実施日: {YYYY-MM-DD} / commit: `{ハッシュ}` / 実施者: {サブエージェント/モデル}
- レビュー振り返り: 対象あり（{n}件）
```

宣言行に続けて、所見ごとに H4 ブロックを書く（対象0件ならセクション自体を作らない）：

```markdown
- レビュー振り返り: 対象あり（{n}件）

#### 所見1: {1行要旨}（対応履歴 {YYYY-MM-DD} #{項番} / レビュアー: {名前}）
- 発生原因: {root_causes 語彙}（{補足1文}）
- 本来の捕捉工程: {implementation_phase_catchable 語彙}
- 通過理由: {工程未実施／実施済み通過を区別して1〜3文。不明なら「不明（欠けている証跡: …）」}
- 根拠: {成果物・diff・テスト・レビューループ記録・昇格判断へのパス/参照}
- 再発防止: {preventable_by 語彙} — {具体アクション} ／ または 昇格なし（理由: 前提: {…} ／ 失効条件: {…（任意）}）
- 検出漏れ分類: {routing-miss／detection-miss／aggregation-miss／machine-miss ／ 不明（欠けている証跡: …）}（該当する unit/gate があれば1句で補足。無理に埋めない）
```

**書式の制約（パーサ安全性）**: このセクション内では**表（`|` 区切り行）と `### 日付` 見出しを一切使わない**。`scripts/analyze-pr-history.js` の `parsePrFile` はファイル内の**位置を問わず** `|` 行を表として取り込み、直前の `### YYYY-MM-DD` ラウンドに帰属させる——「日付見出しの配下でなければ表を置いてよい」は成立しない。`### 日付` 見出しはラウンド境界の誤認を生むためこれも禁止。上記の箇条書き（`- ラベル: 値`）と H4 見出し（`#### 所見N` は `^### ` にマッチしない）は現行実装ではパースされない。この非干渉はリポジトリ内のテストではまだ固定されていない——将来 `parsePrFile` を拡張する際に、本セクションとの非干渉を固定する回帰テストを併せて追加する。検出漏れ分類（手順4）の追加後もこの制約と非干渉範囲は変わらない——新設した `- 検出漏れ分類: …` 行も同じ `- ラベル: 値` 書式に従うだけであり、表や `### 日付` 見出しを持ち込まない。

### 再発時の扱い（同一所見・同一原因の再登場）

- **同一PR内の同一所見**: 後続ラウンドで同じ所見を再分析しない。既存の所見ブロックに1行追記する（新ブロックの重複作成禁止）。
- **過去の `昇格なし` と同型の再発**: 分析中の所見と同じ発生原因で過去に `昇格なし` と判断した記録（同一PR・他PR とも）があれば、その前提が今も成立するかを**1回・1文**で確認する。同型の再発はその前提を崩す典型であり、崩れていれば `昇格なし` は失効——再発防止を再判定し、新しい所見ブロックに失効した過去判断への参照を残す（結論の無条件再利用をしない。書式の考え方は [review-pr.md](review-pr.md) ステップ4 の 🔁 と同じ）。

## 集計（派生物）ポリシー

- 正本は PR 単位の `docs/pr/PR-{番号}.md`「レビュー振り返り」セクション。**全PR横断の JSON・集計ファイルを PR ごとに手動更新しない。**
- 横断集計は [analyze-pr-history.md](analyze-pr-history.md) 相当の分析を実行したときに、PR 単位の Markdown 正本から生成する派生物とする。実装は `scripts/analyze-pr-history.js` の `parsePrFile` 拡張として行う（`- ラベル: 値` の行プレフィックスで機械抽出できる書式にしてある）。
- 本ワークフローの記録は `root_causes` / `implementation_phase_catchable` に `confidence: curated` 相当の入力を与える（PR 単位の分析 → 横断分類・集計 → [risk-modeling.md](risk-modeling.md) §2.5 への還元、の3層）。

## 既存記録との非重複

| 既存記録 | 担う内容 | 本ワークフローの扱い |
|---|---|---|
| 対応履歴（[review-pr.md](review-pr.md) ステップ8） | 何を指摘され、どう判断・対応したか | 所見の見出しから項番参照。再掲しない |
| レビューループ記録・昇格判断（[pre-commit-review.md](pre-commit-review.md) ステップ6） | 収束の証跡・class への昇格判断 | 根拠フィールドから参照。再掲しない |
| learning ロール（[systematize.md](systematize.md)・[analyze-pr-history.md](analyze-pr-history.md)） | 自動化・lint/test/CI への格上げ**提案** | 本記録を入力として消費する下流。提案の実施判断は人間 |

サブエージェントは分析と記録内容の作成のみを行い、実装の変更・大規模なルール追加・語彙の新設は行わない（提案は返答に分離して残し、採否は人間・orchestrator が判断する）。

## 関連

- 本ワークフローの導入経緯 / 多軸分類・統制語彙の正本 / risk-modeling との関係
- [docs/agent-workflows/review-pr.md](review-pr.md) — 呼び出し元（ステップ7.5）
- [docs/agent-workflows/pre-commit-review.md](pre-commit-review.md) — 独立アンカー・昇格判断・レビューループ記録の正本
- [docs/agent-workflows/subagent-roles.md](subagent-roles.md) — ロール定義（review-retrospective / learning）
- [docs/agent-workflows/analyze-pr-history.md](analyze-pr-history.md) — 横断集計（派生物）の実行入口
- [review-angles/finding-criteria.md](review-angles/finding-criteria.md) — finding contract（`scope_relation`／`severity`／`evidence`／`provenance`）の正本。手順4の対象選別・`aggregation-miss` 判定で参照
- [review-angles/README.md](review-angles/README.md) — snapshot 成果物・`escalate` の正本。手順4の `routing-miss` 判定で参照
- [second-opinion-review.md](second-opinion-review.md) — high-risk second opinion（既存の独立 review gate）の **gate 定義・Required artifacts** の正本（PR 固有の実施記録ではない。実施記録は PR 本文の `## セカンドオピニオン記録`）。手順1・手順4の `independent first-found`（(c)）判定で参照
- `docs/planning/pr-history-schema-design.md` — 統制語彙（§3.3 / §3.5 / §3.6）
- 将来候補: 運用で無言スキップが観測された場合、`docs/pr/PR-*.md` の宣言行を検査する機械ゲートを別 issue で検討する（`check-artifacts.js` は PR 本文検査のため対象外）
