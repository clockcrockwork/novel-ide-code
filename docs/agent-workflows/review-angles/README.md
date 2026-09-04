# 観点別レビュー（review-angles）— 共通正本（orchestrator 用）

> **Ground truth:** 各系統の正本 `angle-*.md`（下表）/ [pre-commit-review.md](../pre-commit-review.md) ステップ6（収束条件・上限・受理文法）
> **Entry gate:** Tier 判定（下記 [§Tier](#tier対象系統の判定コスト制御)）を確定するまでレビュアーを起動しない
> **Required artifacts:** 系統別所見（[§出力契約](#出力契約全系統共通)）、系統列付きレビューループ記録（[§収束と記録](#収束と記録)）
> **Verification gate:** 所見の修正後は変更種別に応じたゲートを再実行 → [docs/ai/rules/verification-gates.md](../../ai/rules/verification-gates.md)
> **Anti-skip:** [docs/ai/README.md](../../ai/README.md)「anti-skip rule」を参照。「差分が小さいので Light で十分」は高リスク領域には使えない（Tier 表が正）
> **Cost note:** 全レビュアーが diff をアンカーにすると盲点が相関し、セルフ収束宣言後に外部レビューが新規所見を出し続ける（外部レビューで実証された）
<!-- agent-commons:generated source=review-angles-readme version=1.0.0 — 手編集しない。正本は agent-commons/core と docs/agent-workflows/overlays -->

包括的レビューは全員が **diff そのものをアンカー**にして読むため盲点が相関する。**観点の違い＝アンカーする ground truth の違い**として7系統のレビュアーを定義し、[pre-commit-review.md](../pre-commit-review.md) / [review-pr.md](../review-pr.md) のレビューループに組み込む（運用性・状態遷移系統の追加と加算式 Tier は Gemini レビュアー退役に伴うギャップ分析より。減算・清掃系統と LIMIT 収束を追加した経緯は `docs/planning/review-system-phase2-plan.md`。旧「5系統」呼称は本 README・関連 docs 中に残る場合がある — 現行は7系統）。

## 分離原則（アンカー純度）

- **各レビュアーには自系統の `angle-*.md` だけを渡す。** 他系統の観点・出力分類を読むと視点が濁り、盲点の相関が再発する。`angle-*.md` は互いに参照せず、本 README へも逆リンクしない。
- 本 README（Tier 判定・起動・所見の集約・ループ記録）を読むのは **orchestrator（レビューを起動する側）だけ**。
- **例外（diff 含有時）**: 本 README・他系統の `angle-*.md` が**レビュー対象 diff に含まれる**場合、各レビュアーはそれらを**レビュー対象として**読む（自系統以外の観点定義として採用はしない）。review-angles 配下を変更する PR で「読まない」規則とレビュー任務が衝突するのを防ぐ（全系統共通。各ラッパーにも同文を置く）。
- 起動は `.claude/agents/review-*.md` のサブエージェント経由（修正コンテキストを持たない独立アンカーとして成立させる）。

## 7系統の定義

| 系統 | 正本 | サブエージェント | アンカー | 問い |
|---|---|---|---|---|
| **減算** | [angle-subtractive.md](angle-subtractive.md) | `review-subtractive` | diff そのもの（追加された helper・分岐・規則・成果物） | この変更は足さずに済まないか。削除・統合で解決できないか |
| **risk-model 検証** | [angle-riskmodel.md](angle-riskmodel.md) | `review-riskmodel` | 想定ケース表 | 表の約束は diff のどこで果たされているか。表と diff の不整合はどれか |
| **仕様・ビジネスロジック** | [angle-spec.md](angle-spec.md) | `review-spec` | issue / MVP_PLAN / ドメイン docs（**PR 本文を読む前に**期待挙動を自力導出） | この挙動は作品・章・執筆というドメインの意図に合うか |
| **敵対的** | [angle-adversarial.md](angle-adversarial.md) | `review-adversarial` | 攻撃面・故障モード | どの入力・状態・タイミングで壊れるか。この diff の修正自体をどう騙すか |
| **コード品質** | [angle-quality.md](angle-quality.md) | `review-quality` | 規約・既存コード（CLAUDE.md / REVIEW_GUIDELINES.md） | 重複・複雑さ・規約違反・既存ヘルパーの再実装 |
| **運用性・状態遷移** | [angle-operability.md](angle-operability.md) | `review-operability` | 実行主体・状態遷移・データ契約・失敗途中状態 | この手順・状態機械を別のエージェントが暗黙入力なしで完走できるか。途中で止まったら何が残るか |
| **清掃** | [angle-cleanup.md](angle-cleanup.md) | `review-cleanup` | diff とその周辺コード・docs（変更後に不要になったもの） | この変更で消せるようになったものが残っていないか |

運用性・状態遷移系統はレビュー対象**自身**の内部性質（実行可能性・ライフサイクル・拡張性）を見る。検索型記憶に保存された過去の設計決定との適合性検出（下記「条件起動系統」の記憶適合レビュアー）とは対象が異なり、重複しない。

**減算・清掃の起動位置**: 減算は他系統より**先**（入口）に起動する（足したものを他系統が診断する前に、削減・統合の余地を検証する）。清掃は他系統が**収束した最終1周のみ**起動する（修正ラウンドごとに回すと周回数が増えるため）。両系統とも `implementation` / `documentation-workflow` / `mixed` の3モードを持ち、diff の内容から自動選択する（詳細は各正本）。系統列の受理トークンは「減算」「減算レビュー」「清掃」「清掃レビュー」のいずれも可（正本: `scripts/agent/review-angle-tokens.js`）。

## Tier（対象系統の判定・コスト制御）

必須系統は**加算式**で決まる: 基礎 Tier（コード変更のリスクで判定）の系統に、実行可能設計文書への変更があれば加算分を足す。**減算（入口）・清掃（最終周）は全 Tier に共通の下限**として含む（経緯: `docs/planning/review-system-phase2-plan.md`）。

| Tier（宣言名） | 対象 | 必須系統 |
|---|---|---|
| **Full（7系統）** | 高リスク領域（second-opinion-review.md §1 の表を正とする: editor / persistence / GitHub sync・Worker / security boundary / export・import / 本文処理の性能）or 大規模 diff or 新サブシステム | 減算＋敵対的＋risk-model 検証＋コード品質＋仕様・ビジネスロジック＋運用性・状態遷移＋清掃 |
| **Light（5系統）** | 上記以外のコード変更 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 |
| **設計文書** | docs のみの変更で、実行可能設計文書（下記パス列挙）に触れる | 減算＋仕様・ビジネスロジック＋運用性・状態遷移＋清掃 |
| **Record** | docs のみの変更で、記憶レコード・構造化記録（`docs/agent-memory/records/` 配下）に触れる | 減算＋清掃 |
| **Docs** | 上記以外の docs のみの変更（説明・履歴文書） | 清掃 |
| **なし** | 既知ワークスペース（リポジトリルート・`worker/`）直下の依存 manifest のみの変更・変更なし | なし |

docs のみの変更が複数カテゴリ（設計文書・Record・Docs）にまたがる場合は、優先順位 **設計文書 > Record > Docs** で最も広い Tier を宣言する（設計文書が最も拘束力が強いため。稀な混在ケースの簡略化）。

**加算規則（実行可能設計文書。コード変更との混在時）**: スキーマ・状態遷移・CLI/API 契約・エージェントワークフロー・機械パース対象・セキュリティ境界など、**後続の実装・運用を拘束する docs** に触れる変更は、基礎 Tier（Full/Light）に関わらず**仕様・ビジネスロジック＋運用性・状態遷移**を必須系統に加算する（減算・清掃は基礎 Tier に既に含まれるため加算不要）。判定は次の**パス列挙を正**とする（機械判定可能性のため。意味定義は列挙の設計意図。大小非依存）:

> `docs/agent-workflows/` `docs/planning/` `docs/data-model/` `docs/security/` `docs/ai/` `docs/maintenance/` `.claude/agents/` `.claude/commands/` `.claude/skills/` `.agents/skills/` 配下、`agent-manifest.json` / `agent-commons.lock.json`、および `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.claude/settings.json` / `.github/pull_request_template.md` / `.github/copilot-instructions.md`

**記憶レコード・構造化記録のパス列挙**（Record Tier）:

`docs/agent-memory/records/` 配下（判定の正は `scripts/agent/classify-changes.js` の `RECORD_DOC_PATTERNS`。大小非依存）。

- **宣言名**: docs のみの PR は「**設計文書**」「**Record**」「**Docs**」のいずれか（基礎 Tier なし＋当該 Tier の必須系統のみ）。コード変更と混在する PR は「{基礎 Tier}＋設計文書」（例: `Light＋設計文書`＝ Light の5系統＋仕様・運用性の2系統＝7系統）と宣言する（宣言名だけで実施系統集合を復元できるようにする。混在の加算対象は設計文書のみ — Record/Docs はコード変更と混在する場合、基礎 Tier〔Full/Light〕の減算・清掃で足りるため加算しない）
- **基礎 Tier の「コード変更」判定**は正本 `scripts/agent/classify-changes.js` の `code` 判定を正とする — 文書内の解釈で判定しない（規則本文は複製しない。単一パスの判定は `CHANGED_FILES=<path> node scripts/agent/classify-changes.js` で確認できる）
- **既知ワークスペース直下の依存 manifest のみの変更**（classify の depOnly。`scripts/agent/classify-changes.js` の `isKnownDepManifestPath` — リポジトリルート・`worker/` 直下のみ。bundled action の dist 配下等、ワークスペース外の package.json は対象外＝通常判定）は「なし」相当（従来どおり免除）。設計文書と混在する場合の宣言名は「**設計文書**」（コード Tier は生じない）。Record/Docs パスと混在する場合も同様にそれぞれの Tier 名で宣言する
- **列挙外の成果物**（docs に限らず、エージェント挙動・機械ゲートを拘束する設定等を含む）でも「後続の実装・運用を拘束する」と判断したら加算してよい（広げる方向の裁量は常に可。ゲートは列挙外での「{基礎 Tier}＋設計文書」宣言を受理し、加算系統の実施を要求する）。その場合は列挙への追加を同 PR または issue で提案し、列挙の不足を観測可能にする
- **docs のみ PR の Tier 引き上げ**: 機械判定（設計文書 > Record > Docs の優先順位で確定した Tier）より**厳しい**（必須系統が超集合の）Tier を著者が自主的に宣言することは常に受理する（同じ「広げる方向の裁量は常に可」の docs-only 版）。典型例: Docs 判定の変更が新しい規則・必須手順・役割を追加すると著者が判断した場合、`Tier: Record` を宣言して減算を加算する（Docs Tier は説明文書向けに減算を除外しているが、拘束力のある記述を追加する回はこの引き上げで対応する）。逆方向（判定より緩い Tier の宣言）は拒否する（fail-closed）
- **ゲート導入以前から open の PR**（Tier 宣言なし・旧3列表・旧規約で非必須だった設計文書 PR）は、synchronize 等で新ゲートに落ちたら**不足系統を後追いで実施して**宣言行・系統行を追記する（実施していない系統のトークンだけ書くのは起動漏れ検出の毀損。skip マーカーは全検査を消すため最終手段）
- **過剰トリガーの脱出**（設計文書パス配下の誤字修正・trivial な docs 修正等）: **docs のみ（`check-artifacts` の `mandate !== 'full'`＝classify の `codeChanged=false` または `depOnly`）の PR に限り**、Tier 宣言行を `Tier: なし（説明・記録文書: 理由）` として記載して免除する（この場合レビューループ表は省略可。`check-artifacts` はこの宣言を免除として受理し警告を残す）。**コード変更と混在する PR では免除しない**（「{基礎 Tier}＋設計文書」と宣言する。誤字等で実質対象が無い場合も、運用性系統は Entry gate の「対象なし（理由1行）」宣言で即終了し、仕様系統は差分が小さいほど照合も小さいため、コストは限定的）
- 加算式にする理由: 設計文書は Light 相当のコード変更と同じ PR に混在しても後続実装を拘束する。並列 Tier 方式（docs のみ用の独立 Tier）ではコード Tier が勝って設計文書分が素通りする（過去に、docs-only 免除で観点レビューを受けなかった変更に対し、外部レビューが2段階操作の不整合・実行者不在の手順・語彙の拡張閉塞を検出したことがある）
- **加算規則の実施は機械検査される**: `npm run check:artifacts` が **Tier 宣言×系統列の突き合わせ**で、設計文書 Tier の素通りと、Tier で定義した系統の起動漏れを同一ゲートで塞ぐ。**判定の正はゲート実装（`scripts/agent/classify-changes.js` の `DESIGN_DOC_PATTERNS` 列挙）**で、本 README の列挙は同一内容の参照（乖離は `tests/reviewAngleTokens.test.js` が検出する。更新は同一 PR で両方行う。この検出は `DESIGN_DOC_PATTERNS` のみが対象で、上の「コード変更」判定〔`PROSE_INERT_PATTERNS` / `CODE_FORCE_PATTERNS`〕の乖離は検出しない）

**コード品質は Light にも必須（品質ゲートのフロア）**: 従来 pre-commit-review ステップ3 の `/code-review high` が全コード変更で必須だった品質観点（重複・既存ヘルパー再実装・責務分離・パフォーマンス退行）は lint で機械検出できず、Light から外すと通常変更の必須ゲートが静かに弱まる。Full と Light の差は**仕様・ビジネスロジック系統と運用性・状態遷移系統の有無**とする（Light に運用性を含めないのはコスト制御。状態機械・多段操作を触るコード変更は高リスク領域として大半が Full に入る。拡大は既知穴コーパスベンチで効果を測ってから判断する）。

**減算・清掃は全 Tier のフロア**: Docs Tier まで含めた全 Tier に減算・清掃を含めるのは、追加方向だけのレビューでは新規実装・新規規則・新規 docs が単調増加し続けるため。Docs Tier のみ減算を含めない（清掃のみ）のは、docs-only の説明文書に対して「削除・統合できないか」を毎回問うコストが、対象が実行を拘束しない純粋な説明文書には見合わないため（拘束力を持つ設計文書・記憶レコードには含める）。

## レビューモード

各周回でレビュアーへ渡す「何を対象に、何を問うか」を3区分に分ける。**2周目以降を一律「所見確認だけ」にしない** — 修正によって探索対象が変わった観点は新規探索を継続する（初回の盲点を固定化させないため）。

| モード | 対象 diff | 問い | 成果物 |
|---|---|---|---|
| **所見確認** | 前回 snapshot → 現在（`previous-to-current.patch`） | 前回の所見は正しく直ったか | 所見ごとの解消／未解消 |
| **差分探索** | 同上 | 修正差分に**新しい**欠陥が生じていないか（必要に応じ影響する周辺も見る） | 新規所見 |
| **全体再探索** | merge-base → 現在（`base-to-current.patch`） | PR 全体をこの観点で探索し直す | 新規所見 |

**レビュアーへ渡す patch は、起動を決めた範囲を必ず覆う**（一致ではなく**包含**）。起動するかどうかは「起動のスケジューリング」のとおり系統ごとの累積差分で判定するが、その範囲が `previous-to-current.patch` に収まらない場合は**モードを全体再探索へ引き上げる**（差分探索の成果物は直前 hop 固定なので、そのまま渡すと起動の根拠になった変更がレビュアーに届かない）。

- **渡すのは上表の成果物そのもの**。`baseline` を見て `git diff <baseline>..<現在>` を自作して渡さない — 引き上げ後の対象は `base-to-current.patch` で、自作した範囲はそれより**狭い**。`record-run` は patch の中身を検証しないので受理されてしまい、「引き上げられた全体再探索を差分探索へ落として実行しない」（[pre-commit-review.md](../pre-commit-review.md)「review budget（自動探索の上限）」）が禁じたのと同じ縮小が成立する
- **引き上げが効くのは計画が割り当てたモードだけ**。`所見確認` は machine が提案せず起動側が手動で起動するモードなので、hop を見送った後に手動起動すると `previous-to-current.patch` が渡り、その系統が dirty になった根拠の範囲を覆わない。予算の枠で `所見確認` を使うときは、その系統の未確認範囲が別に残ることを前提にする

**完全 diff（`base-to-current.patch`）が正本**。観点別の圧縮 diff や派生情報を作る場合も、AI 要約のみを根拠に diff を切り捨てない。lockfile・formatter 変更・生成物も無条件にはレビュー対象外にしない（`changed-files.json` の分類は判断材料であって除外規則ではない）。

## 観点別の再探索トリガー

観点ごとに「所見確認だけでよい条件 / 修正差分の新規探索が必要な条件 / base からの全体再探索が必要な条件」を宣言する。**判定の正は `scripts/agent/review-exec-config.js` の `ANGLE_TRIGGERS`**（本表は同一内容の参照。乖離は `tests/reviewExecConfig.test.js` が検出する）。

| 系統 | 差分探索へ（修正差分がこの観点の探索対象を変えた） | 全体再探索へ（この観点のアンカー自体が動いた） |
|---|---|---|
| 減算 | 修正差分に**追加**がある限り常に（アンカーが追加物そのもの） | 設計文書の意味的変更 |
| risk-model 検証 | コード・ガード・テストの変更 | 想定ケース表の変更 |
| 仕様・ビジネスロジック | コード・設計文書・意味的変更 | 仕様アンカー（MVP_PLAN / ARCHITECTURE / `docs/data-model/`）の変更 |
| 敵対的 | コード・設定・テスト・新規ファイル・意味的変更 | ガード種（正規表現・バリデーション・分類器）の変更、高リスク領域 |
| コード品質 | コード・新規ファイル・テストの変更 | 規約の正本（CLAUDE.md / REVIEW_GUIDELINES.md / INVARIANTS.md）の変更 |
| 運用性・状態遷移 | 設計文書・意味的変更・設定 | 手順・状態機械の再定義（意味的変更） |
| 清掃 | 起動されたら常に（最終1周でのみ起動する） | ― |
| 記憶適合 | 記憶レコード・設計文書・コードの変更 | 記憶レコードの変更 |

**計画文書・エージェントワークフローの変更も、コード変更と同じ意味的トリガーで判定する。** 単なる誤字修正と、次の変更を同じ扱いにしない：完了条件の変更／対象範囲の変更／工程順の変更／実行主体の変更／中断・復旧手順の変更／例外・境界の追加／新しい成果物・規則・役割の追加。判定は `review-snapshot.js` の `detectSemanticDocChange` が行い、**fail-closed**（誤字だけと証明できる場合のみ意味的変更なしと判定する）。

**1 snapshot = 1 周**。同じ snapshot で完了済みの観点は再起動しない（次の行動は「修正 → 新しい snapshot」）。

## 実効 Tier の更新（起動側の判断）

初期 Tier は PR の変更内容から決まるが、**PR 中に固定しない**。GitHub 上の外部レビュアー・別モデル・別セッションから、内部レビューでは見つからなかった**正当な新規所見**が出た場合、その事実を現在の PR のレビュー計画へ反映する。

**その所見が正当か・どの観点に属するか・どれだけ重大かは人間 / orchestrator が判断する**（machine は判定しない。裁定の記録先は下記「所見の裁定」）。判断の結果として「どの系統をやり直すか」だけを起動側へ渡す（`--reason` は理由の言語化を要求するためのもので、**本文は state に保存されない** — 所見の内容を machine state へ戻さないため）:

```bash
node scripts/agent/review-plan.js escalate --angles operability,spec --reason "外部レビューで手順の実行主体が不在と指摘"
```

| 事象 | 対応 |
|---|---|
| 初期 Tier では起動対象外だった観点から新規所見 | その観点を `escalate` で実効 Tier へ加算し、**fresh reviewer で PR 全体を探索**する |
| 初期 Tier で実施済みだった観点が新規所見を見逃していた | 同じレビュアーの継続で済ませない。`escalate` で **fresh reviewer へ交代**する |
| 複数観点をまたぐ所見 | 単一観点へ押し込まない。**関連する観点をすべて** `--angles` に列挙する |
| 高影響所見（データ損失／security boundary の突破／secret・個人情報の漏洩／永続化の不整合／public/private 境界の混入／復旧不能な途中状態／同一根本原因による複数箇所の欠陥／複数観点を横断した内部レビューの見逃し） | **Full への昇格を検討**する。手順は下記「基礎 Tier を上げるとき」 |
| 外部レビューで新規ブロッカーが続く | Tier または探索強度を段階的に引き上げる。**引き上げは人間の判断で、`escalate` が予算の割り当てを兼ねる**（上記「review budget」。定義の正本: `docs/planning/review-memory-boundary.md` §4） |

**エスカレーションしないもの**: 誤検知／既判断／任意改善／好みの違い／既出所見の言い換え／PR 外の問題で今回の変更により悪化していないもの。これらは `escalate` せず、見送りの理由を `docs/pr/PR-{番号}.md` に残す。

**基礎 Tier を上げるとき（Light → Full 等）**: `escalate` は**系統の加算しかしない**ため、PR 本文の `実効Tier:` 宣言を Full にするだけでは planner は Full の必須系統を計画しない（Light の既存系統から高影響所見が出た場合、`escalate --angles adversarial` は既にある系統を再起動するだけになる）。**昇格先 Tier の必須系統のうち、まだ実効 Tier に無いものをすべて `--angles` に列挙する**:

```bash
# Light → Full: 不足するのは spec / operability（TIER_ANGLES の差分。宣言と計画を一致させる）
node scripts/agent/review-plan.js escalate --angles spec,operability --reason "高影響所見により Full へ昇格"
```

宣言だけ Full にして系統を足さないと、**Full と宣言しながら Light 相当しか実施しない**状態になる（`check:artifacts` は宣言と系統列の整合は見るが、planner の計画までは見ない）。

**条件起動系統（記憶適合）の escalate は基礎 Tier を動かさない** — Tier 表に属さないため、`escalate --angles memory` は `addedAngles` と再起動義務にだけ反映され、宣言 Tier 名は変わらない（`widenEffectiveTier` が条件起動系統を宣言名の計算から外す）。

### 所見の裁定

**所見の意味・因果・裁定を machine state（`review-state.json`）は持たない。** 所見ごとの裁定（判断・理由・対応・証拠）の恒久正本は `docs/pr/PR-{番号}.md`（外部レビュー由来は `## 対応履歴`、内部レビュー由来は `## 内部レビュー所見の裁定`）。由来を問わず同じ手順で裁定し、判断記号（✅ 対応 / ⏭️ 見送り / 🔁 既判断 / ❓ 要確認）と理由1文の書式も共通にする。責務境界の正本: `docs/planning/review-memory-boundary.md` §3。

- **`review:plan` の「収束」は所見が無いことの宣言ではない** — 計画した起動をすべて記録したという意味だけを持つ。所見が残っているかは裁定ログ側で判断する
- PR 番号が確定する前（`pre-commit-review`）の裁定は作業中の一時情報として保持し、PR 作成後に転記する（[pre-commit-review.md](../pre-commit-review.md) ステップ6）
- 内部所見は**表形式で書かない**（`scripts/analyze-pr-history.js` が外部レビュー指標として誤集計するため。同 §3「provenance の保持」）

**初期 Tier と実効 Tier は区別して記録する**（下記「収束と記録」の宣言行）。実効 Tier は原則として PR 内で縮小させず、追加された観点の確認が済んでも履歴上は保持する。

## review budget（自動探索の上限）

**自動の新規探索は1観点につき1回。** それを超える探索は、人間が明示的に予算を割り当てたときだけ起こる。判定は `review-plan.js` の `applyBudget` が行い、`npm run review:plan` が予算終了した系統を「⚠️ 予算終了（人間判断が要る）」として別枠で報告する。

由来と定義: `docs/planning/review-memory-boundary.md` §4（review budget と終了条件）。本節はその恒久実装であり、同書 §7 の「移行期の手運用」を置き換える（public→control のリンクは張らない）。

### 枠表（値の正本。他の文書・コードはここを参照し、値を写さない）

**必須系統ごと:**

| 枠 | 既存語彙での定義 | 上限 |
|---|---|---:|
| 新規探索 | **fresh** レビュアー ×（`全体再探索` または `差分探索`） | **1回** |
| 所見確認（**別枠**） | `所見確認` モード | 所見が出た系統につき **1回** |
| `所見確認` から `差分探索` / `全体再探索` への復帰 | — | **しない** |
| 未解消のまま使い切った | — | **人間判断**（続行 / follow-up / 現状受容 / 設計へ戻す） |

**最終独立レビュー（angle に依らない起動単位。machine の義務ではない）:**

| 枠 | 既存語彙での定義 | 上限 |
|---|---|---:|
| 新規探索（外部。Codex 等） | **fresh** ×`全体再探索` | **1回** |
| 所見を修正した場合の確認（**別枠**） | **`差分探索`**（`所見確認` ではない） | 必要なら **1回** |
| `差分探索` から `全体再探索` への復帰 | — | **しない** |

final の確認だけ `差分探索` なのは、`所見確認` の問いが「前回の所見は正しく直ったか」に限られ、**修正が別箇所を壊した場合を構造的に見逃す**ため。final の目的は最終状態の独立確認なので、修正差分に対する新規探索が要る。

### 何を数えるか

| 数えるもの | 数えないもの |
|---|---|
| `state.runs` に残った起動記録（`status` を問わない） | 所見を裁定すること／修正すること／`PR-{番号}.md` に記録すること／外部レビューへ返信すること |

- **新しい永続 state を持たない。** 消費は既存の `state.runs`、追加割当は既存の `state.escalations` から毎回導出する（予算専用の台帳・カウンタ・`skipped-by-budget` のような一時 state は作らない）
- **`status` で例外を作らない。** `error`（起動失敗）も `incomplete`（`maxTurns` 到達）も消費する — 除外すると、起動が恒常的に失敗する環境や maxTurns に当たり続ける観点で**最も高価な組合せ（opus × 全体再探索）の自動ループが止まらない**。続きを見るかどうかは人間の判断に属する
- **`incomplete` / `error` を所見ゼロで収束させない**のは、**`converged` を false に保つこと**が担う（下記「予算終了で何が起きるか」）。**PR 本文の機械ゲートは予算を判定しない** — `check:artifacts` は形式だけを見る（`review-memory-boundary.md` §1(a) が「CI の機械ゲートが reviewer の実走を検証すること」を保証しないと明記）
- **`incomplete` は fresh で再起動するより継続のほうが安い。** 同じレビュアーを再開して未確認範囲だけを埋められるなら、それは新規探索ではないので予算を消費しない（再開手段が無い環境では人間が `escalate` で予算を割り当てる）
- **引き上げられた全体再探索を差分探索へ落として実行しない。** `record-run` は patch の中身を検証しないので受理されてしまい、起動の根拠になった累積差分がレビュアーへ届かないまま `complete` が記録され baseline だけが前進する（＝見送った hop のすり抜けが「対応済み」の顔で再現する）。この保証は累積差分の判定が効く範囲でのみ成り立つ — 基準が解決できなければ fail-closed で全体再探索を要求し、判定範囲が `previous-to-current.patch` に収まらなければモードを引き上げる
- **予算のスコープは attempt**（1回の連続した review attempt）。作業キャッシュ（`review-state.json`）を捨てれば予算は再計算される。**ただし `docs/pr/PR-{番号}.md` に残った人間の停止判断は attempt をまたいで有効** — セッション再開だけを理由に自動探索を再開しない（正本: §4「予算のスコープ」）

### 予算終了で何が起きるか

| | 内容 |
|---|---|
| **止まるもの** | 自動の新規探索（`差分探索` / `全体再探索` の提案）。トリガーが立っていても `run: false` になる |
| **止まらないもの** | finding intake（新しい所見の受け入れ）／段階機械（次の段階へ進む）／snapshot の取得 |
| **残るもの** | 予算が無ければ要求していた探索の内容（`withheld`）と、その系統が見ていない範囲（`baseline`）。**「トリガー非該当・実施済み」に畳まない** |

**「段階が進むか」と「全部見たか」は別の問い。**

- **段階機械は進む。** 予算終了した系統で段階を止めると、解除できる唯一の行動が人間の `escalate` になり、人間が来るまで入口で固まる（＝「収束していないのに打てる手が無い」を machine 側で作る）
- **`converged` は false のまま。** ここまで true にすると「未確認範囲を残したまま収束」が**各系統1回起動した後の既定**になり、PR 本文の閉じた収束文法（`0` ＋ `収束`）でそのまま通せる。`converged` を false に保つことが、`incomplete` / `error` / 未レビュー差分を所見ゼロで収束させないための唯一の機械的な担保である
- 解除は**人間の判断**: 続行なら `escalate`、現状受容なら判断と理由を `docs/pr/PR-{番号}.md` に残し、PR 本文のループ記録を **「残所見: {系統}の未確認範囲（予算終了）」** で閉じる（`check:artifacts` の閉じた文法における予算終了の書き方。`収束` ＋ `0` で閉じない）

### 予算を追加で割り当てる（人間の判断）

```bash
node scripts/agent/review-plan.js escalate --angles adversarial --reason "外部レビューで見逃しが判明"
```

- **1 escalation = 1 起動**。消化すると再び予算終了へ戻る
- **指名した系統にだけ割り当てる。** エスカレーション1件で全系統を回し直すと、1回の人間判断が N 回の起動へ増幅する。他系統も要るなら `--angles` に列挙する（正本: 下記「実効 Tier の更新」）
- 実効 Tier が広がって**新しく必須になった系統**は、一度も見ていないので初回探索として起動する（予算の増幅ではない）
- 判断（続行 / follow-up / 現状受容 / 設計へ戻す）と理由は `docs/pr/PR-{番号}.md` に残す

### 所見が出た系統の確認（1回・machine の外）

所見を直したあとの確認は上の枠表の「所見確認」行に従う。`review:plan` は提案せず `record-run` も受理しない（下記「所見確認モードの扱い」）ため、起動側が手動で回す。**確認から新規探索へは自動で戻さない** — 戻すと「修正 → fresh → 修正 → fresh」の自己増殖が復活する。確認で新しい所見が出た場合は intake（裁定）へ入れ、追加の探索が要ると判断したら上の `escalate` で予算を割り当てる。

### 予算の値を変えるとき

`AUTO_EXPLORATION_BUDGET`（現在 1。**環境変数・CLI での上書き経路は持たない** — 実行ごとに変えられると「予算を守った」の意味が消えるため）を上げる前に、**上げて何が改善するかを測る**。過去の実測では、探索を増やして検出した欠陥の一部が前周回の修正自体が持ち込んだ回帰であり、探索を足すこと自体が欠陥を作る側にも働いたことがある。角度数・model・maxTurns の削減は別の問題として扱う（まず起動回数を減らす）。

## レビュアーの継続とリフレッシュ

同じレビュアーを起動し続ける方法を無条件には採らない（過去の理解と見逃しを保持する／修正内容にアンカーされ新規探索が弱くなる／履歴が膨らむ／初回の盲点が固定化する）。

| 場面 | レビュアー |
|---|---|
| 初回探索 | **fresh** |
| 同じ所見の修正確認（所見確認モード） | 継続可。上限は上記「review budget」の枠表。**起動も記録も machine を経由しない**（下記「所見確認モードの扱い」） |
| 修正によって探索空間が変わった（差分探索・全体再探索） | **fresh**。ただし**自動では起動しない**（予算終了。人間が `escalate` で割り当てたときのみ） |
| 外部レビューで見逃しが判明した観点 | **fresh**（エスカレーション） |
| 直近の起動が `incomplete`（maxTurns 到達等） | **fresh**。所見ゼロとして収束させない。**自動では再起動しない**（予算を消費済み）— 未確認範囲として人間判断へ返す |
| 最終確認（最終独立レビュー） | **fresh**（修正コンテキストを持たない）。**この起動判断は machine の義務ではなく手順が持つ**（上記手順8） |

- **必須経路**: 毎回 `.claude/agents/review-*.md` を新規起動し、引き継ぎは**成果物ファイル**（snapshot ディレクトリの patch・`review-plan.json`）で行う。Agent Teams・resume は前提にしない。
- **任意の高速経路**: 所見確認モードで継続上限内なら、Claude Code の `SendMessage`（agent ID 指定）で直前のレビュアーを resume してよい（コンテキスト再構築を省ける）。使えない環境では必須経路にフォールバックする。

### 所見確認モードの扱い（machine を経由しない）

`所見確認`（`findings-check`）はレビューモードの語彙としては残るが、**`review:plan` は提案せず、`record-run` も受理しない**（`review-plan.js` の `MACHINE_RECORDABLE_MODES`）。所見の有無を machine state が持たなくなったため、machine には「前回の所見が直ったかを確認する周回」を導出する材料が無い。

したがって `所見確認` は次のように扱う:

- 起動側（orchestrator）が上記「review budget」の枠表に従って手動で起動する（値はそちらが正本。ここで再掲すると片方だけが更新される）
- `review-plan.json` の起動計画には載らない。`record-run --mode findings-check` は fail-loud で拒否される
- 実施した事実と結果は `docs/pr/PR-{番号}.md` の内部レビュー所見の裁定に書く。計数が要るなら `review-metrics.js record` へ渡す

**machine が表現できない確認を machine へ無理に記録しない**（一時 state を足さない）。angle に依らない起動単位（最終独立レビュー・手順8）も同じ扱い。

## 共通成果物（snapshot）

観点によらない機械的処理は `npm run review:snapshot` が生成し、レビュアーは同じ情報を毎回再構築しない。

```text
$(git rev-parse --git-path agent-review)/<snapshot-id>/
├─ manifest.json             base / merge-base / head / dirty / untracked / baseFetch（base 候補〔remote-tracking〕の fetch 結果）/ 前回 snapshot・判定材料
├─ base-to-current.patch     merge-base → 現在の完全 diff（正本）
├─ previous-to-current.patch 前回 snapshot → 現在の修正 diff（初回は空）
├─ changed-files.json        変更ファイル（status・分類・高リスク・シグナル）
└─ review-plan.json          起動する観点・モード・fresh/継続・実行設定（review-plan.js が生成）
```

- 置き場所を `.git` 配下にするのは、作業ツリーに出ない（`.gitignore` の追加も不要・レビュー対象を汚さない）・linked worktree でも `git rev-parse --git-path` が正しい場所を返す・clone 単位で自然に破棄されるため。Windows / WSL / Linux で同じ結果になるようパス結合は Node の `path` に任せる。
- **working tree・untracked も対象に含める**（`git stash create` で作業ツリーをコミット化し、untracked は `git diff --no-index` で patch へ追記する）。作業ツリーを変更しない。
- **patch へ載せられなかった対象は `manifest.unreportedPaths` に残す**。通常ファイルでない untracked（symlink・ディレクトリ）・非 UTF-8 名は完全 diff に現れず、`assume-unchanged` / `skip-worktree` / `ignore = all` の submodule は**作業ツリーの改変分だけ**が隠れる（ファイル自体はコミット済み内容で patch に載りうる）。いずれも「変更なし」と証明できないため、`guardChangeInFix` / `semanticDocChangeInFix` は無条件に立つ（fail-closed）。**正本 patch だけを読んで「変更なし」と判断しないこと。**（`unreportedPaths` の診断出力・解消手順・レビュアーへの受け渡し規約は未確定。レビュー機構の再設計〔ハンドオフ契約〕で扱う）
- レビュー判断の**正本は `docs/pr/PR-*.md`・PR 本文**（GitHub コメント）。snapshot と `review-state.json` は1つの作業ツリー内でのループ制御に使う作業キャッシュであり、恒久記録ではない。
- **base 解決の前に remote-tracking な base 候補（`origin/main` 等）を明示 refspec で fetch する（network I/O をする）**。`refs/remotes/<remote>/<branch>` を `+` 付きで**強制更新する**副作用がある — base を固定したい場合は `--base <sha>` を使うこと（`--base origin/main` は当該 ref を更新する）。失敗しても止まらず手元の ref で続行する（15秒でタイムアウト）。結果は `manifest.baseFetch` と CLI の `baseFetch=` 行に出る。

## 実行設定（model / effort / maxTurns）

**正本: `scripts/agent/review-exec-config.js` の `ANGLE_EXEC_BASELINE`**（`.claude/agents/review-*.md` の frontmatter との drift は `tests/reviewExecConfig.test.js` が検出する）。親セッション設定の無条件継承を避けるため、全レビュアーで `model` / `effort` / `maxTurns` / `tools` を明示する。

- **一律 low effort にしない**。期待挙動の自力導出・攻撃構成が本質の観点（仕様・敵対的）は上位モデル＋高 effort、diff とアンカーへの照合が主体の高リスク観点（減算・運用性）は中位モデル＋高 effort、機械的照合寄りの観点（risk-model 検証・品質・記憶適合・清掃）は中位モデル＋medium とする。`maxTurns` は実測の tool 使用回数の上限付近で切り、超過は `incomplete` 契約で人間判断へ返す。
- **Claude Code の制約**: `model` は frontmatter に加えて起動時パラメータでも上書きできるが、`effort` / `maxTurns` は frontmatter のみ。よって frontmatter には**そのレビュアーが取りうる最も重いモードの値**を置き（fail-closed）、モードによる引き下げは起動時 `model` で行う（所見確認は中位モデルへ。ただし敵対的は「修正自体をどう騙すか」が本質のため引き下げない）。
- **`tools` にキーを置かない＝全ツール継承**（制限の解除）。`Agent` は含めない（観点レビュアーにオーケストレーションを兼務させない）。
- **環境変数の上書き**: `CLAUDE_CODE_SUBAGENT_MODEL` は frontmatter の `model` より優先される。`node scripts/agent/review-exec-config.js` が frontmatter の実効設定と環境変数による上書きを検査・出力する。
- **`incomplete` 契約**: `maxTurns` 到達・入力不足・実行不能で観点を最後まで確認できなかったレビュアーは、**所見ゼロで正常終了せず** `未完了: incomplete（{未確認範囲}）` を返す。orchestrator は `review-plan.js record-run --status incomplete` で記録する。**収束扱いにはしない**（`converged` が false のまま残る）が、**自動では再起動しない**（予算を消費済み）。続きは (a) 同じレビュアーを継続して未確認範囲だけを埋める（新規探索ではないので予算を消費しない。最も安い）、(b) 人間が `escalate` で予算を割り当てて fresh を起動する、のいずれか。

## 計測

`npm run review:metrics -- record` / `report`（`scripts/agent/review-metrics.js`）で 1 起動 1 行の JSONL を残し、レビュー実行の共通化・モード分離の効果を後から評価する。**取得できない値のために独自計測基盤を足さない。**

- **取得可能**: 起動数／観点別起動回数／fresh・継続／モード／model・effort・maxTurns／`status`（complete・incomplete・error）／実行時間（親セッションの壁時計）／新規所見数・既出所見確認数・外部新規所見数（`review-metrics.js` へ手で渡す計数であって、所見台帳ではない）／Tier エスカレーション／snapshot
- **取得不能**: トークン数・turn 数・tool call 数（Claude Code はサブエージェントの内訳を親セッションへ返さない）。turn 数の近似指標は `status=incomplete`（maxTurns 到達）の有無のみ。

## 出力契約（全系統共通）

レビュアーは**検出と分類まで**を行い、どちらに直すかは判断しない（[evidence-check.md](../evidence-check.md) の「検証と差し戻しのみ」原則と同型）。所見1件につき:

- `file` / `line` — 対象箇所
- `summary` — 欠陥の1文要約
- `failure_scenario` — 具体的な入力・状態 → 誤った結果（再現の筋道）
- `分類` — 系統固有の分類（各 `angle-*.md` で定義）

### 所見の計上基準（新規所見 / 参考）

所見を「新規所見（修正要求。Med 以上）」と「参考（修正要求にしない。Low）」に分ける基準の正本は [finding-criteria.md](finding-criteria.md)。各 `angle-*.md` の出力契約から参照され、レビュアーは自系統の正本と併せて必ず読む（他系統の観点ファイルは引き続き読まない）。

## 起動手順（orchestrator）— diff-review の実行オーケストレーション

**diff-review ロール（[subagent-roles.md](../subagent-roles.md)）の実体はメインセッション（orchestrator）である。**新しいロール・サブエージェントは足さない — Claude Code のサブエージェントは `tools` に `Agent` を持たない限り別サブエージェントを起動できず、観点レビュアーには意図的に持たせていない（オーケストレーションの兼務を避けるため）。**このオーケストレーション自体は各観点のレビューを実施しない**（責務はレビュー実行の準備・分配・状態管理・完了判定）。Agent Teams は前提にしない。

各周回は次のとおり。機械的処理は script に出し、判断だけを orchestrator が行う。

```bash
npm run review:snapshot          # 共通成果物（merge-base / 完全 diff / 修正 diff / 変更分類）
node scripts/agent-memory.js search "<キーワード>"   # 条件起動系統の判定（ヒット件数を控える）
npm run review:plan -- --memory-hits <n>            # Tier・実効Tier・起動系統・モード・fresh/継続・実行設定
```

0. **別の PR / ブランチのレビューを始めるなら、先に作業キャッシュを捨てる**（`rm "$(git rev-parse --git-path agent-review)/review-state.json"`）。`state` は base・ブランチ・PR の同一性を持たないため、捨てないと**前 PR の消費がそのまま効き、新しい PR が自動探索を1回も受けないまま全系統「予算終了」になる**。捨てた後は `escalate` と `--memory-hits` を入れ直す（下記「起動のスケジューリング」）
1. **snapshot を生成する**（`npm run review:snapshot`）。base・merge-base・現在（作業ツリー・untracked 込み）を確定し、完全 diff と修正 diff を出す
2. **計画を生成する**（`npm run review:plan`）。初期 Tier・実効 Tier・起動する系統・各系統のモード（所見確認／差分探索／全体再探索）・fresh/継続・実行設定が `review-plan.json` に出る。判定結果と理由は同ファイルに残るので、PR 本文には Tier 宣言行（＋加算があれば実効 Tier 宣言行）を転記する。**`review-plan.json` は生成時点のスナップショットで `record-run` では更新されない** — 中断から再開したときは、成果物を読む前に `review:plan` を実行し直すこと（記録済みの系統を再起動しないため）
3. **減算を先に起動する**（入口。他系統より前）。所見があれば反映し、必要なら `所見確認` を1回。**新規所見ゼロを観測するまで回さない** — 自動の新規探索は1回で、その先は人間判断（上記「review budget」）。修正して新しい snapshot を取ってから残りの系統へ進む
4. **残りの対象系統を計画どおりに起動する**（**清掃を除く**）。**修正コンテキストを渡さない**（渡すのは snapshot 内の patch ファイルパス・自系統の入力アンカー・モードのみ。PR 本文は `review-spec` には期待挙動の自力導出後まで渡さない）
5. **起動を記録する**（`review-plan.js record-run`、`review-metrics.js record`）。**記録は修正より先**（順序は必須）— 鮮度検証は作業ツリーの変更で fail-closed するため、先に修正すると記録経路が閉じ、**実 invocation を払ったのに消費が0のまま残る**（同じ観点に2回払うことになる）。複数系統を起動した場合は**全系統を記録してから、まとめて修正する**。`incomplete` を返したレビュアーは所見ゼロ扱いにしない。**所見そのものは台帳に入れない** — 裁定は `docs/pr/PR-{番号}.md` へ書く（上記「所見の裁定」）
6. 所見を集約し、[pre-commit-review.md](../pre-commit-review.md) ステップ6 のレビューループ（修正 → 再レビュー）に入れる。周回上限に達したときの分類・対応も同ステップを正とする
7. 減算・清掃を除く系統が段階を通過したら、**最終1周として清掃**を起動する。清掃の所見も裁定・修正するが、**清掃の予算も1回**なので「新規所見ゼロを観測するまで再レビューする」ことはしない（追加が要るなら人間が `escalate --angles cleanup`）。清掃の所見を直した round も**段階の評価は入口（減算）から行う**（「清掃のみ再レビュー」の段階スキップは設けない）。各系統を実際に起動するかは従来どおり再探索トリガー表（`review:plan`）が決めるため、**全系統の機械的な再実行ではない**。段階スキップを設けないのは、「この修正差分は清掃所見への対応だけである」が成果物（差分・所見メタデータ）からは検証できないため（削除のみ・同一ファイル・同一行でも無関係な変更を混ぜられる）
8. **最終独立レビュー**: 全系統が収束したら、修正コンテキストを持たないレビュアーが merge-base からの完全 diff を **fresh・全体再探索**で1回読む。**所見ゼロでも実施記録を `docs/pr/PR-{番号}.md` に残す**（machine が起動義務として追跡しない以上、記録が無いと「実施した」と「省略した」を区別できない。「所見ゼロの周回は転記しない」の唯一の例外）。**これは machine の起動義務ではない** — 起動単位が系統ではなく「1人が完全 diff を1回読む」ためで、系統ごとの `record-run` へ分解すると1回の invocation を N 件の記録に水増しすることになる（execution state は実 invocation と一致させる）。実施の判断・枠・記録は上記「review budget」と `docs/pr/PR-{番号}.md` が正本
9. レビュアーが**系統固有分類の外の所見**（例: 運用性系統の「その他: {提案分類名}」）を返した場合、破棄・既存分類への再分類をせず、**issue 候補としてユーザーへ提示する**（承認フロー: [REVIEW_GUIDELINES「issue の作成・close」](../../REVIEW_GUIDELINES.md#issue-の作成close承認フロー正本)。承認された場合の確定は該当 `angle-*.md` を変更する通常 PR で行う）

**script が使えない環境**（`.git` に書けない・Node が無い等）では、手順3〜9 の判断規則（トリガー表・実効 Tier 表・継続/リフレッシュ表）をそのまま手で適用する。script は判断の**自動化**であって、判断規則の正本は本 README である。

## 起動のスケジューリング（dirty obligation）

段階は**義務単位**の dirty 判定で選ぶ。dirty の条件は「再探索トリガーが該当した」＝計画がその系統に run:true を返したこと。未達の義務（一度も完了していない・直近が `error` / `incomplete`）は `selectMode` が run:true を返すためここに含まれる。**未解消所見は条件に入らない**（所見の有無を machine が持たないため。所見に対応する再起動が必要なら起動側が `escalate` で要求する）。実行するのは **dirty な義務のうち最も早い段階**のものだけ。

**義務は永続台帳ではなく毎回の再計算である。** 「この系統をいま起動すべきか」は、過去の snapshot が発行した未消化の起動記録ではなく、**現在の repo / snapshot / これまでの起動記録**から `review:plan` が毎回導出する。

**再探索トリガー表が見る差分は、系統ごとに基準が違う。** 「直前 snapshot からの修正差分」ではなく、**その系統が最後に実際にレビューした snapshot（最後の `complete` な run）から現在 snapshot までの累積差分**で判定する。基準は `state.runs` から導出するので、新しい永続状態は持たない。したがって:

- 提案された起動を実行しないまま次の snapshot へ進んでも**計画は停止しない**。その hop の変更はその系統にとって未確認のまま残るので、次の計画で累積差分から改めて判定される。**予算が残っていれば** run:true として現れ、使い切っていれば `entries[].budgetOutcome === 'exhausted'`（CLI の ⚠️ 予算終了ブロック）に未確認範囲として現れ、`converged` は false のままになる — どちらの経路でも「見なかったこと」が消えない、というのがこの機構の目的
- **累積差分は直前 hop の修正差分を必ず含む**（観測範囲を広げる仕組みなので、狭める方向へ倒さない）。commit 差分から再計算した値で直前 hop のシグナルを上書きすると、`unreportedPaths`（`assume-unchanged` / `skip-worktree` / submodule 未具現化 / 非通常 untracked）由来の fail-closed が累積経路でだけ外れる。untracked と未報告パスも台帳から復元して累積差分へ載せる
- **基準からの差分を解決できない場合は fail-closed**（全体再探索・fresh を要求する）。dirty snapshot の commit は `KEEP_REFS` を超えると prune されるため、古い基準は取得不能になりうる。ここで直前 snapshot へ縮めると、未確認の累積差分を見落とす方向へ倒れる
- **累積差分で判定した系統は計画に明記される**（`review-plan.json` の `baseline`、CLI の「累積差分で判定した系統」行）。CLI の「シグナル」行は**直前 snapshot からの修正差分**のものなので、累積で判定した系統の理由とは食い違いうる — 食い違いは計画のバグではなく、範囲が違うことの表れ
- **中断・作業キャッシュ削除の後も、過去 attempt の起動義務は復元しない**。`review-state.json` を捨てて `review:plan` を実行し直せば、現在の repo state から必要な起動が出る（起動記録は失われるので未実施として扱われ、「全部実施済み」へは倒れない）
- **ただし人間由来の判断は cache から復元されない**。`escalate` で加算した系統（`addedAngles` / `escalations`）と `--memory-hits` で必須化した記憶適合（`memoryRequired`）は、変更ファイルからは導出できないため cache を捨てると初期値へ戻る。**version 不一致の fail-loud で cache を捨てた場合も同じ**なので、捨てた後は `escalate` と `--memory-hits` を**入れ直すこと**。復元できるよう、`escalate` した時点で**加算した系統名**（と `--memory-hits` の値）を理由とあわせて `docs/pr/PR-{番号}.md` へ書く — 理由だけを残すと `addedAngles` を復元できず、「実効 Tier は PR 内で縮小しない」が cache 破棄で破れる
- **別 PR / 別ブランチへ切り替えたら `review-state.json` を捨てる**。state は `.git/agent-review/` にブランチ横断で永続し、PR / ブランチの識別子を持たない。捨てないと前 PR の `initialTier`（PR 内で縮小しない）と起動記録が次の PR に流用され、前 PR で完了した系統が「実施済み」として素通りしうる。**machine は切り替えを検出しない**ので、切り替えた人・エージェントが捨てる（捨てた後は上記のとおり `escalate` / `--memory-hits` を入れ直す）
- **順序保証**: 減算 → 本体 → 清掃 の段階順は、dirty な義務のうち最も早い段階を選ぶことで担保する（最終独立レビューは段階機械に含めない — 上記手順8）。`record-run` はこの計画を**その場で計算し直して**照合するので、段階順を記録側から迂回できない
- **計画が要求していない起動は記録できない**。段階外でレビュアーを起動してしまった場合、その結果を `record-run` へ入れる経路は無い（入れられると段階順を迂回できるため）。所見は `docs/pr/PR-{番号}.md` へ裁定し、起動記録は残らないものとして扱う（その系統は次の計画で改めて要求される）
- **dirty でない義務は起動しない**。再探索トリガーが該当しない系統は、段階が回ってきても起動されない（計画上は「義務は満たされている」と報告される）
- **ブロック条件には必ず解除経路が対になる**。収束をブロックする条件（未達義務）は、それを解除できる行動を**同じ計画が提案する**。計画は「収束していないのに次にできる行動が1つも無い」状態を検出したら fail-loud で止まる（黙って「収束: いいえ」を出し続けない）

**この段階選択は以前から同じ規則で動いている**（旧実装の `settled` の否定がそのまま dirty に対応する）。PR2' で変えたのは判定ロジックではなく**観測可能性**で、計画の各行に `dirty` を出し、充足済みの義務を「保留」ではなく充足として報告するようにした。

**注意**: PR1 で減算が 38 周まで伸びた原因はこの段階選択ではない。実際の駆動要因は (a) 周回の数え方、(b) 所見の分類・裁定の置き場所（いずれも `docs/planning/review-memory-boundary.md` §3・§4 で境界を決め直した）、(c) 検出器が docs の 1 行変更で減算トリガーを立てること（後続 PR の範囲）。段階選択を変えてもこの発散は止まらない。

## 起動記録の規律（計画との照合 / stale / 冪等性）

- **計画が要求した起動しか記録できない**。`record-run` は指定された snapshot に対する計画を**その場で計算し直し**、観点・モード・fresh がその要求と一致する記録だけを受理する。照合相手は保存された起動義務ではないので、提案と異なる内容の記録は次 round へ持ち越されるのではなくその場で落ちる。`--snapshot-id` は「どの snapshot を読んだレビューか」の**自己申告**で、省略時は最新 snapshot（真偽は検証できない。保護は下の鮮度検証が担う）
- **古くなった結果は受理しない**。同時に snapshot の鮮度（HEAD・tracked の作業ツリー・untracked の集合と内容ハッシュ）を検証し、snapshot 時点と現在が一致しなければ拒否する。台帳に無い・成果物が読めない・鮮度の材料が欠けている場合も**受理しない**（「検査できないので通す」は禁止）
- **拒否されても停止しない**。鮮度違反で結果を捨てる場合、廃棄用のコマンドは要らない。`npm run review:snapshot` で新しい snapshot を取り、`npm run review:plan` から回し直す（未実施の系統は現在の state から改めて要求される）
- **同じ記録の再実行は冪等、ただし計画が改めて要求しているなら別 invocation**（判定条件の正本は `review-plan.js` `recordRunCommand`）

## 収束と記録

収束条件・独立アンカー要件・最終行の受理文法は [pre-commit-review.md](../pre-commit-review.md) ステップ6 を正とする（本ファイルでは再掲しない）。

起動側の収束判定（当初の failure scenario・完了条件・blocker 級所見・regression test・gate・残余の 6 条件と、1 系統 fresh 1 回＋所見確認 1 回の上限）も同ステップ6「起動側の収束判定」を正とし、ここでは再掲しない。**review budget は本ファイル上記の「review budget（自動探索の上限）」が正本**（機械的な終了条件ではない）。観点別レビューではループ記録に**系統列**を加え、セクション内・表の直前に **Tier 宣言行**を置く:

- **実効 Tier 宣言行（閉じた書式・省略可）**: `実効Tier: {宣言名}（昇格理由1行）` の1行を Tier 宣言行の直後に置く。**外部新規所見等で観点が加算された場合のみ**書く（省略時は実効 Tier = 初期 Tier）。宣言名の語彙・書式の制約は Tier 宣言行と同一。`npm run check:artifacts` は、宣言があれば**実効 Tier を必須系統の基準**として系統列と突き合わせ、初期 Tier の必須系統を縮小する宣言を拒否する（PR 内での縮小禁止）。昇格理由には「外部新規所見（観点名）」「高影響所見（クラス名）」など、初期 Tier から変えた根拠を書く
- **Tier 宣言行（閉じた書式）**: `Tier: {宣言名}（判定理由1行）` の1行。宣言名は Tier 表・加算規則の語彙のみ — `Full` / `Light` / `設計文書` / `Record` / `Docs` / `Full＋設計文書` / `Light＋設計文書` / `なし`（正本: `scripts/agent/review-angle-tokens.js` の `TIER_DECL_NAMES`。＋は全角半角どちらも可）。免除は `Tier: なし（説明・記録文書: 理由）`。**書式の制約**: 宣言は行として単独で書く（コードフェンス・インラインコード・引用・表セル・打ち消し線の中の `Tier:` は例示・引用・取り消しであり宣言と数えない）。理由は括弧・改行を含まない300字以内の1行。この行を `npm run check:artifacts` が系統列（受理トークンの正本: `scripts/agent/review-angle-tokens.js`）と突き合わせて機械検査する（系統セルは `＋` 等で複数連結可。系統外レビュー名は警告に出るがフロア充足には数えない）

```markdown
## レビューループ記録

Tier: Light（通常コード変更・高リスク領域外）
実効Tier: Light＋設計文書（外部新規所見: 運用性・状態遷移で手順の実行主体不在を検出）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算 | 1件（未使用になった旧経路の並存） | 削除で対応 |
| 2 | 敵対的 | 2件（fail-open / 否定形迂回） | 全修正＋回帰テスト追加 |
| 2 | risk-model 検証 | 1件（❌約束未実装） | 実装追加＋回帰テスト追加 |
| 2 | コード品質 | 1件（既存ヘルパー再実装） | 全修正（昇格なし: 単発） |
| 3 | 運用性・状態遷移 | 1件（外部所見の再現。実行主体不在） | 全修正（実効 Tier へ加算・fresh 起動） |
| 3 | 仕様・ビジネスロジック | 0件 | 収束 |
| 4 | 減算＋敵対的＋risk-model 検証＋コード品質＋運用性・状態遷移 | 0件 | 収束 |
| 5 | 清掃 | 1件（乖離した旧コメント） | 全修正 |
| 6 | 減算＋清掃 | 0件 | 収束 |
```

**修正時の必須チェック（1所見を修正するたび）:**

- **同クラス全箇所適用**: ガード・修正を入れたら、同じ入力を扱う全箇所に適用したかを grep で確認し、検索クエリと結果を証跡として残す（過去に、同種の修正を1箇所にしか適用せず同じ見落としで2回刺されたことがある）
- **昇格判断の記載**: ループ記録の対応セル（または途中行の本文）に「回帰テスト追加 / lint・ゲート昇格 / 昇格なし（理由）」のいずれかを書く（instance の修正を class の修正に拡張できないか毎回問う）

## 条件起動系統（記憶適合）

7系統・Tier 表とは独立に、**条件起動**で追加する系統。Tier 必須集合には含めない（`docs/planning/agent-minimal-ops-plan.md` §2）。

| 系統 | 正本 | サブエージェント | アンカー |
|---|---|---|---|
| **記憶適合** | [angle-memory.md](angle-memory.md) | `review-memory` | ヒットした有効な accepted 記憶（accepted 以外は根拠にしない — 列挙は angle-memory.md の Ground truth 行が正） |

- **起動条件**: 初回レビュー起動前、および各修正 round の再レビュー起動前に、orchestrator が `node scripts/agent-memory.js search`（既定フラグ。`--all` / `--status` は使わない。変更 scope・path・キーワードで2〜3クエリ）を実行する。**有効な accepted 記憶にヒットした場合のみ**起動する。ヒット 0 件なら起動しない。新たにヒットした round はその round で起動する。前 round で本系統が違反・更新候補の所見を出した場合は、新規ヒットの有無に関わらず修正後の round で再起動する（渡す Memory ID は前回ヒットの全体＋新規ヒットの和集合）。起動時は**検索語・ヒット Memory ID・レビュー対象**の 3 点を渡す。レビュー対象は diff 内容そのもの、または diff を書き出したファイルパスで渡す（`review-memory` は Bash を持たずコミット範囲を diff に具現化できない）。なお既定 search は accepted かつ非 superseded のみを返すため、ヒット結果から accepted を選別する追加手順は不要。更新候補（`[判断不足]`）・`[記憶不足]` の所見は orchestrator が PR 本文「残る制約・判断」へ転記して人間判断へ渡す（起票はしない）。`Tier: なし` を宣言しレビューループ表を省略する PR では、レビュー自体を起動しないため本系統の判定・記録も不要。
- **起動判定の記録**: 起動の有無に関わらず、レビューループ記録表の**直後**に**判定 1 回 = 1 round の検索一式 = 1 行**で残す（再検索した round は行を追記し、既存行を上書きしない。`{検索語}` には当該 round の全クエリを `"..."` で個別に引用して併記〔クエリ自体に区切り文字が含まれても分解可能にする〕、ヒット件数は合算・Memory ID は和集合）。書式:
  - `記憶適合起動判定: {検索語} → ヒット {n} 件（{Memory ID…}）`
  - `記憶適合起動判定: {検索語} → ヒット 0 件（未起動）`
  - `記憶適合起動判定: {検索語} → 実行不能（exit 非0: 理由1行）` — search がレコード破損等で失敗した場合。「ヒット 0 件」とは区別し、判定未了として修復（`node scripts/agent-memory.js validate`）後に再判定する

  検索語の妥当性（diff との関連）は機械検証しない設計上の残余（「変更 scope・path・キーワードから導出する」の規定が唯一の拘束）。

  記録のライフサイクルはレビューループ記録表と同一（pre-commit-review 段階で作成し、create-pr で PR 本文の「レビューループ記録」節・ループ表直後へ転記する既存経路。転記確認は [create-pr.md](../create-pr.md) の確認項目）。`npm run check:artifacts` の検査対象にはしない（判定＝検索の失念は [evidence-check.md](../evidence-check.md) の確認項目で検査する）。
- **機械ゲート**: `memory` は通常7系統の `ANGLE_TOKENS` へは追加せず、`scripts/agent/review-angle-tokens.js` の条件起動トークン区分（`CONDITIONAL_ANGLE_TOKENS`）に登録する。受理トークンは「記憶適合」「記憶適合レビュー」のいずれも可。`check:artifacts` はこの区分の語彙も既知トークンとして受理する（unknown 警告を出さないだけで、収束検査の対象には含めない）。収束はレビューループの運用規則（新規所見ゼロまで再起動）で担保する。

## 既知穴コーパス検出ベンチ（定義）

観点別レビュアーの効果を実装者の自己評価に依らず測る retrospective injection ベンチ。判定は「検出した/しない」の機械的二値で、実装者の解釈が入らない。

<!-- overlay: このリポジトリの既知穴コーパス検出ベンチの実施履歴（第1弾の実測値） -->
> **第1弾（#425）**: スナップショット `d615041`（PR #396 の最初の収束宣言状態）に潜在する実穴 16 件をコーパスに、4系統をブラインド起動。系統別検出率＝敵対的 6/16・仕様 4/16・risk-model 3/16・品質 0/16、和集合 7/16。結論・コーパス外の新規発見・tuning 候補は `docs/pr-analysis/review-angles-bench-round1.md` を参照。減算・清掃系統の効果測定は #425（実 PR でのドッグフードを評価対象に追加する形で再定義済み）が引き続き担当する。

- **コーパス**: `docs/pr/PR-396.md` の対応履歴に記録された実穴（証拠ロンダリング・自己証明・収束偽装・コメント適用漏れ・fail-open 悪用 等）を第1弾とする
- **手順**: 各穴について修正前のコミットをチェックアウト → 該当 Tier の系統別レビュアーを当てる → 穴ごと・系統ごとに検出/未検出を記録する
- **記録**: 系統別検出率の表を `docs/pr-analysis/` に残し、系統定義（`angle-*.md`）の調整材料にする
- レビュアー定義（`angle-*.md`・ラッパー）の変更自体も通常 PR として artifacts-gate＋外部レビューに乗せる（定義の劣化を無審査で入れない）
- 外生指標は [analyze-pr-history.md](../analyze-pr-history.md) の「外部レビューの実質新規所見数/PR」の before/after 比較（自己申告でない）

## 関連

<!-- overlay: このリポジトリの関連 issue（採用方針・機械ゲート実証・セカンドオピニオン）の履歴メモ -->
- issue #397（旧5系統の採用方針。完了・close 済み）/ #396（レビューループ機械ゲート・実証データ）/ #357（セカンドオピニオン。完了・close 済み）
- `docs/planning/review-system-phase2-plan.md` — 減算・清掃系統・新 Tier（Record/Docs）・LIMIT 収束の実施計画
- [pre-commit-review.md](../pre-commit-review.md) — 組み込み先（ステップ3・6）。収束条件・周回上限・受理文法の正本
- [review-pr.md](../review-pr.md) — 組み込み先（ステップ6・7）
- [subagent-roles.md](../subagent-roles.md) — ロール表（diff-review の分割）
- [second-opinion-review.md](../second-opinion-review.md) — 高リスク領域表の正本
- [evidence-check.md](../evidence-check.md) — 「検証と差し戻しのみ」原則の同型元
