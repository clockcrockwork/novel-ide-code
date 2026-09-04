# サブエージェント構成とエージェント移譲計画

> **Ground truth:** 本ファイル（ロール定義・移譲計画の正本）/ 各ロールの手順正本（下表の「正本ワークフロー」列）
> **Entry gate:** タスク開始時にロール表と標準フローを引き、どの工程をどのロール・どのモデルに移譲するかを決めるまで実装に進まない
> **Required artifacts:** 移譲計画（工程 × 担当ロール × 成果物の対応。実装計画・作業メモ・PR本文に残す）
> **Verification gate:** 各ロールの正本ワークフローに従う → [docs/ai/rules/verification-gates.md](../ai/rules/verification-gates.md)
> **Anti-skip:** [docs/ai/README.md](../ai/README.md)「anti-skip rule」を参照。「小さいタスクなのでロール分担不要」でも requirement-probe / risk-modeling / evidence-check の成果物は省略しない
> **Cost note:** 省略すると、非言語化要件の見落とし・「やった」報告だけの未完了・低品質なAIレビューの応酬が発生する

AI開発フローを工程ごとのロール（サブエージェント）に分割し、各工程の担当・成果物・引き継ぎを定義する正本。

## 目的

- **最低品質の底上げ**: 賢くないモデルが担当しても、成果物テンプレートと verification gate によって一定品質を保証する
- **低品質なAIレビューの抑制**: レビューで指摘を拾うのではなく、実装前（requirement-probe / risk-modeling）と実装中（evidence-check の中間実行）で品質を上げ、レビューを「漏れ確認・妥当性確認」に寄せる
- **移植性**: ロジックの正本は `docs/agent-workflows/` に置き、Claude / Codex / Gemini の各入口（`.claude/agents/`・`.claude/commands/`・AGENTS.md・GEMINI.md）は正本を参照するだけの薄いラッパーに保つ（#343 の方針）

## 原則

1. **正本は docs、入口は薄く**: エージェント固有ファイルに手順本文を書かない。正本の参照のみ。
2. **成果物はファイル・PR本文に残す**: 各ロールの出力（チェックリスト・想定ケース表・証拠表）はチャット内で完結させず、実装計画・作業メモ・PR本文に書く。弱いモデルへの引き継ぎ・後続工程の検証はこの成果物だけで成立させる。**移譲時に渡す最小項目**（Intent / Ground Truth / Observed Constraints / Decisions / Unknowns / Output Contract）と「本文を写さずパスで指す」規則は [responsibility-boundary.md](../ai/rules/responsibility-boundary.md)「工程間ハンドオフの最小コンテキスト」を正本とする。
3. **クロスモデル検証**: レビュー系ロール（diff-review / evidence-check）は、実装した主体と**別のモデルまたは別セッション**で実行することを推奨する（自己承認バイアスの回避）。同一モデルしか使えない場合も、実装コンテキストを持たない新規セッション・サブエージェントで実行する。
4. **機械化できるものはロールに残さない**: lint / test / CI で判定できる観点はロールのチェック項目から外し、[verification-gates.md](../ai/rules/verification-gates.md) の機械的ゲートへ寄せる。層の分担と、machine が判定できる所見が出たときの扱い（ゲートの欠落として格上げする）は [responsibility-boundary.md](../ai/rules/responsibility-boundary.md) が正本。
5. **AIのチェックを最終ゲートにしない（自己言及的な穴を塞ぐ）**: 各ロールの成果物（チェックリスト・証拠表）は AI が埋めるため、「未作成のままチェック済み」で通せてしまう再帰的な穴がある。この floor は**非AIの機械ゲート** `npm run check:artifacts`（CI の `artifacts-gate`）が保証する。機械は存在・形式まで、内容の真偽は evidence-check（cross-model）が担う。詳細は [evidence-check.md](evidence-check.md)「機械的下限ゲート」。

## orchestrator と planner の責務（役割分離）

役割分離の経緯: `docs/planning/agent-minimal-ops-plan.md` §1。

### orchestrator（メインセッションが担う。サブエージェント化しない）

- 責務は調査・計画・分配・完了判定に限定する。**コード変更（`scripts/agent/classify-changes.js` が「コード」と判定するファイル）を直接編集しない** — implementer へ移譲する。classify の code 判定が false のファイルは orchestrator が直接編集してよい（禁止判定は classify の「コード」判定のみを正とし、中間帯を作らない。正本 `scripts/agent/classify-changes.js`。単一パスの判定は `CHANGED_FILES=<path> node scripts/agent/classify-changes.js` で確認できる。#446 round4 観点別レビュー 減算2）。例外はユーザーがその作業で明示的に指示した場合のみ。ただし prose であっても**機械ゲート・権限・エージェント制約を定義するファイル**（`.claude/agents/*.md` の frontmatter の `model` / `tools` 等）の緩和方向の変更（フック除去・allow 拡大・モデル固定解除・ツール追加。`tools` キーの削除＝キー不在は全ツール継承、およびラッパー本文・正本の制約文〔信頼境界・読み取り制限・禁止事項〕の除去・弱体化も含む）は、ユーザーの明示指示なしに行わない。
- レビュー所見の裁定: 「採用」にできるのは [review-angles/finding-criteria.md](review-angles/finding-criteria.md) の**新規所見**だけ。参考（Low）は採用せず PR 本文「残る制約・判断」に記録するか、承認フロー（[REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md)「issue の作成・close」）を経て issue-candidates へ送る。implementer への修正指示は採用項目のみを列挙し **1 回 10 件以下**にする（この値の正本はここ。implementation.md はこれを参照する）。収束判定は [pre-commit-review.md](pre-commit-review.md) ステップ6「起動側の収束判定」に従い、同じ変更に対する再探索を増やして完了を遅らせない。
- implementer が verification gate 赤・中断で戻った場合、部分編集状態をコード編集で直さず、修正指示を移譲計画表へ追記して**再移譲**する（受け入れ条件を変えない再移譲は再承認不要。変える場合はユーザー承認を経る）。部分編集済みの作業ツリーは再移譲された implementer が引き継ぐ。再移譲を打ち切る場合（アプローチ変更・タスク中止）は、orchestrator が `git restore` / `git checkout` 等の**機械的な復元操作**で部分編集を破棄してよい（復元先は**移譲前の状態＝当該作業開始時点の HEAD** に限る。任意の過去 ref を source とする restore は意味的なコード変更であり、復元でなく編集に当たる）。implementer が新規作成した untracked ファイルは復元操作では消えないため、`git status` で当該タスク由来のものを特定してから個別パス指定で削除する（無差別な `git clean -f` はしない）。
- 既存成果物（requirement-probe / risk-modeling / codebase-recon 等）を再利用し、**stale（前提が変わった）ものだけ再生成**する（全成果物の機械的な作り直しはしない）。
- 提供単位（1 PR = 自己完結した提供結果・検証単位・ロールバック単位）を維持する。
- 対話・成果物は [communication.md](../ai/rules/communication.md) の簡潔化規則に従う。

### planner（orchestrator 内の計画工程。独立ロール・独立サブエージェント化しない）

実体はメインセッションの工程であり、別役割として立てると同一主体に2つのロール定義が並存する。ユーザー対話上の呼称（planner）は維持しつつ、定義は orchestrator 内の工程として置く。

- 出力契約: 目的／受け入れ条件（検証方法付き）／影響範囲／検証手順。[communication.md](../ai/rules/communication.md) の簡潔化規則に従う。
- 計画成果物の正本は1箇所のみ: 独立した計画文書を要する場合は `docs/planning/` 配下、通常タスクの計画は PR 本文の該当セクション。**docs と PR 本文の二重管理を禁止**する（他方には参照1行のみ。複製しない）。
- 将来候補を issue 群へ自動変換しない（`docs/planning/issue-candidates.md`・承認フローへ回す）。

## ロールカタログ

| ロール | 責務 | 正本ワークフロー | 推奨割当 |
|---|---|---|---|
| **orchestrator** | タスク分割・優先順位付け・移譲計画の作成・進捗管理・差し戻し判断（完了判定）。**コード変更を直接編集しない**（詳細は本ファイル冒頭「orchestrator と planner の責務」節） | 本ファイル + [pick-issue.md](pick-issue.md) | 高能力モデル（Claude Opus 等）。メインセッションが担う |
| **requirement-probe** | 明文化されていない要件・完了条件の洗い出し。「これがないとPASSできない」の TODO 化 | [requirement-probe.md](requirement-probe.md) | 高能力モデル推奨（実装前の1回なのでコスト影響小） |
| **risk-modeling** | 不正・異常入力・外部状態変化・競合の想定ケース洗い出し | [risk-modeling.md](risk-modeling.md) | 高能力モデル推奨。requirement-probe と同一セッションでもよい |
| **codebase-recon** | 実装直前の既存実装調査。類似実装・再利用候補・慣習サンプル・影響箇所を検索し、再利用/準拠/新規の判断を調査表に残す | [codebase-recon.md](codebase-recon.md) | implementer と同じモデルで可（検索と記録が主体）。risk-modeling と同一セッションでもよい |
| **implementer** | 実装。入力は**承認済み計画のみ**——移譲計画表＋受け入れ条件に加え、requirement-probe の完了条件・risk-modeling の想定ケース表・codebase-recon の既存実装調査表（標準フロー 2〜4 の成果物）を含む。**要件を勝手に追加しない**。コード・テスト・必要 docs を一単位で変更し、変更種別に応じた verification gate（[verification-gates.md](../ai/rules/verification-gates.md)）を実行して結果を返す。実装中に発見した issue 候補は自分で起票せず、orchestrator 経由でユーザー確認へ返す。出力は [communication.md](../ai/rules/communication.md) の簡潔化規則に従う（作業日誌・網羅列挙を返さない） | [docs/ai/rules/implementation.md](../ai/rules/implementation.md)（正本。新設しない） | Claude: **Sonnet 固定**（`.claude/agents/implementer.md` の frontmatter に `model: sonnet`。エイリアスは新しい Sonnet 世代へ自動追従し、バージョン変更への耐性を優先する）。Codex / Gemini も可（成果物駆動なので比較的軽いモデルで可） |
| **diff-review** | 差分レビューの orchestration（snapshot 生成・Tier / 実効 Tier 判定・起動系統とレビューモードの決定・fresh/継続の選択・観点別レビュアーの起動・所見集約・収束判定・最終独立レビューの起動）。**各観点のレビュー自体は実施しない**（レビュー内容の代行ではなく実行の準備・分配・状態管理・完了判定） | [review-angles/README.md](review-angles/README.md)「起動手順（orchestrator）」（実行手順の正本）＋[pre-commit-review.md](pre-commit-review.md)（収束条件・周回上限。`/security-review` を内包） | **メインセッション（orchestrator）が担う。独立サブエージェント化しない** — Claude Code のサブエージェントは `tools` に `Agent` を持たない限り別サブエージェントを起動できず、観点レビュアーには意図的に持たせていない。機械的処理は `scripts/agent/review-snapshot.js` / `review-plan.js` へ委譲する。Codex `/codex:review` の運用整備は #357 |
| **review-subtractive / review-riskmodel / review-spec / review-adversarial / review-quality / review-operability / review-cleanup** | 観点別レビュー（diff-review の分割。#397）。各系統は異なる ground truth をアンカーにし、**自系統の正本のみ**を読む（盲点の相関防止）。減算は入口・清掃は最終1周のみ起動 | [review-angles/](review-angles/) 配下の各 `angle-*.md`（共通規約・Tier・レビューモード・実行設定は [README.md](review-angles/README.md)） | 修正コンテキストを持たないサブエージェント（`.claude/agents/review-*.md`。model / effort / maxTurns / tools を frontmatter で明示 — 正本は `scripts/agent/review-exec-config.js`）。起動要否・モード・fresh/継続は diff-review の計画（`npm run review:plan`）が決める |
| **specialist-review** | 必要時のみ起動する専門レビュー（security / frontend・a11y / ビジネスロジック） | security: [pre-commit-review.md](pre-commit-review.md) 手順4 + `docs/security/`。frontend: **未整備（#311 で整備予定）** | 該当領域の変更時のみ。orchestrator が要否を判断 |
| **review-memory**（条件起動） | 記憶適合レビュー。7系統・Tier とは独立に、orchestrator の `agent-memory.js search` が有効な accepted 記憶にヒットした場合のみ起動する | [review-angles/README.md](review-angles/README.md)「条件起動系統」+ [angle-memory.md](review-angles/angle-memory.md) | 修正コンテキストを持たないサブエージェント（`.claude/agents/review-memory.md`） |
| **evidence-check** | 完了主張の証拠検証・TODO 消化確認・スコープドリフト監査。**機械的下限ゲート（`npm run check:artifacts`）で存在・形式を保証したうえで**、証拠の真偽を検証する | [evidence-check.md](evidence-check.md) | 実装と別モデル・別セッション推奨。機械的照合が主なので軽いモデルで可 |
| **review-retrospective** | 外部レビュー（GitHubレビューコメント）由来の正当な新規所見の 発生原因・内部検出漏れ原因（どの内部ゲートをなぜ通過したか）・再発防止昇格の分析と記録内容の作成（[review-pr.md](review-pr.md) ステップ7.5。#444） | [review-retrospective.md](review-retrospective.md) | 実装・修正と別コンテキストのサブエージェント（`.claude/agents/review-retrospective.md`）。成果物照合が主体なので比較的軽いモデルで可 |
| **learning** | 繰り返し作業のスクリプト/スキル化候補、lint / test / CI への格上げ、除外判断の提案。`docs/pr/PR-*.md`「レビュー振り返り」記録を入力とする（#444） | [systematize.md](systematize.md) + [analyze-pr-history.md](analyze-pr-history.md) + [verification-gates.md](../ai/rules/verification-gates.md)「機械的検出」 | PR 作成後・レビュー完了後に実行。提案止まり（採否は人間） |

### 採用しなかった・統合したロールと理由

| 候補 | 判断 | 理由 |
|---|---|---|
| 完了判定専任（標準フローを終わらせてよいか判断する担当） | orchestrator に統合 | evidence-check の証拠表が判定材料のすべて。判定だけの独立エージェントは新しい情報を生まず、ハンドオフが1つ増えるだけ |
| スコープドリフト監査専任（脇道・TODO不一致・仕様肥大の検出） | evidence-check に統合 | 手順が証拠検証と同一（宣言と実態の照合）。実行タイミングが「実装中の中間」か「完了時」かの違いのみ |
| 実装依頼専任（Codex / Gemini への依頼担当） | orchestrator に統合 | 「誰に実装させるか」は移譲計画の一項目であり、独立した手順を持たない |
| planner の独立ロール化・サブエージェント化 | orchestrator 内の工程に統合 | 実体はメインセッションの計画工程であり、別役割として立てると同一主体に2つのロール定義が並存する。独立サブエージェント化すると計画↔実装のハンドオフが1つ増えるだけで、成果物（目的・受け入れ条件・影響範囲・検証手順）は orchestrator 自身が作れる |

## 標準フロー（エージェント移譲計画）

```
1. orchestrator: タスク受領・分割（issue 起点なら pick-issue.md）
   └─ 成果物: 移譲計画（この表を実装計画に含める）
2. requirement-probe: 非言語化要件・完了条件の洗い出し
   └─ 成果物: 完了条件チェックリスト（検証方法付き TODO）
3. risk-modeling: 想定ケース洗い出し
   └─ 成果物: 想定ケース表（対応する/しない＋理由）
4. codebase-recon: 既存実装調査（コードを書き始める直前）
   └─ 成果物: 既存実装調査表（実行した検索・再利用/準拠/新規の判断＋理由）
5. implementer: 実装（2・3・4 の成果物を入力とする）
   ├─ 実装中に新規ファイル・関数・依存が増えたら 4 を対象分だけ再実行
   └─ 長時間作業では evidence-check を中間実行（ドリフト監査モード）
6. diff-review: pre-commit-review（lint / test / 観点別レビュー / security-review）
   ├─ 観点別レビュー: Tier 判定（加算式） → review-subtractive（先）→ review-riskmodel / review-spec / review-adversarial / review-quality / review-operability → review-cleanup（最終1周）
   ├─ 記憶適合（条件起動）: 有効な accepted 記憶にヒットした場合のみ review-memory を起動（起動条件・記録は [review-angles/README.md](review-angles/README.md)「条件起動系統」が正本）
   └─ specialist-review: 該当領域の変更がある場合のみ追加
7. evidence-check: 完了条件・想定ケース・TODO の証拠検証
   ├─ 機械ゲート: npm run check:artifacts（存在・形式の下限保証）
   └─ 成果物: 証拠表（✅ / ⚠️ / ❌）
8. orchestrator: 完了判定
   ├─ ❌・⚠️ あり → 5 へ差し戻し（差し戻し理由は証拠表の該当行）
   └─ 全 ✅ → create-pr.md へ
9. learning: systematize.md による自動化候補の提案（任意・提案止まり）
```

PR 作成後のレビュー対応は [review-pr.md](review-pr.md) を正本とする。レビュー収束後は review-retrospective（ステップ7.5）が外部所見の発生原因・内部検出漏れ原因を記録し、その記録が learning（9）と #353 の横断分析の入力になる。

### 移譲計画テンプレート

orchestrator がタスク開始時に実装計画へ含める：

```md
## 移譲計画

| 工程 | 担当（モデル/エージェント） | 成果物 | 状態 |
|---|---|---|---|
| requirement-probe | （例: Claude Opus・メインセッション） | 完了条件チェックリスト | ⬜ |
| risk-modeling | （例: 同上） | 想定ケース表 | ⬜ |
| codebase-recon | （例: implementer 自身） | 既存実装調査表 | ⬜ |
| 実装 | （例: Claude Sonnet / Codex） | diff | ⬜ |
| diff-review | （例: 実装と別モデル） | レビュー所見 | ⬜ |
| specialist-review | （該当なし → 理由を書く） | ― | ― |
| evidence-check | （例: 別セッション） | 証拠表 | ⬜ |
```

- 工程を省略する場合は「該当なし」ではなく理由を書く（anti-skip）。
- 1人（1セッション）で全部やる場合もこの表は作る。ロールの切り替わりを成果物の区切りとして扱うことが目的であり、必ずしも別プロセスを要求しない。

## エージェント別の入口

| エージェント | 入口 | 備考 |
|---|---|---|
| Claude Code | `.claude/agents/*.md`（サブエージェント定義）/ `.claude/commands/*.md`（スラッシュコマンド） | どちらも正本参照のみの薄いラッパー |
| Codex | [AGENTS.md](../../AGENTS.md) → 本ファイル | diff-review ロールとしての `/codex:review` 運用は #357 |
| Gemini | [GEMINI.md](../../GEMINI.md) → 本ファイル | |

## 導入段階

この運用基盤は一度に完成させず段階導入する。各段階は「前段階が回っている」ことを入口条件にする（先に重い自動化を作らない）。**現在地は「拘束力」段階の途中**。ただし役割分離（orchestrator 実装禁止・implementer Sonnet 固定）と記憶適合の条件起動系統は `docs/planning/agent-minimal-ops-plan.md` で先行導入済み。

段階は番号でなく名前で参照する（番号は計画文書ごとに別系列で、どの系列か判別できないため。[docs/ai/rules/docs-maintenance.md](../ai/rules/docs-maintenance.md)「段階の表記」）。

| 段階 | 目的 | 主な内容 | 依存 issue | 目安 | 状態 |
|---|---|---|---|---|---|
| **基盤** | ロールと正本を置く | subagent-roles / requirement-probe / evidence-check の正本＋薄いラッパー（`.claude/agents`・`.claude/commands`） | — | S | ✅ 完了（#387） |
| **拘束力** | 完了主張を機械で縛る | 機械ゲート `check-artifacts`／専用ワークフロー（edited 追従）／**branch protection で required 化**（リポジトリ設定＝人手） | — | S | 🔄 進行中（required 化はオーナー操作待ち） |
| **実践調整** | 実運用で docs を削る | Alpha issue 1〜2件でロール標準フローを一周し、摩擦点を docs に反映（過剰な想定・冗長な工程を削る） | — | M | ⬜ |
| **コスト削減** | トークン・手作業を減らす | `scripts/agent/` でコンテキスト圧縮・証拠表/移譲計画の下書き生成 | #343 / #332 | L | 🔄 進行中（レビューコンテキスト圧縮＝`review-snapshot` / `review-plan` / `review-exec-config` / `review-metrics` を先行導入。証拠表・移譲計画の下書き生成は未着手） |
| **検証拡張** | レビューの質を上げる | Codex `/codex:review` を diff-review 経路化／frontend specialist-review／PR履歴多軸分類→risk-modeling 還元・変更種別→必須セクション自動判定 | #357 / #311 / #353 | L | ⬜ |
| **永続化（判断保留）** | artifact をより堅く | PR本文が緩いと判明した場合のみ、artifact をコミットファイル化しゲートを file 対象に切替 | #343 | M | ⬜（採否は「実践調整」の結果次第） |

段階の考え方：**拘束力 → 実践で調整 → 自動化でコスト削減**の順（表の並び順が実施順）。コスト削減以降の自動化は「手作業で回して痛い箇所」が実践調整で特定されてから着手する（先に作ると使われない・的外れになる）。

## TODO（本正本の残課題）

- [x] 基盤・拘束力 — 機械的下限ゲート `scripts/agent/check-artifacts.js`（`npm run check:artifacts` / 専用ワークフロー `artifacts-gate`）を追加済み（#387）
- [ ] **拘束力 — `artifacts-gate` を branch protection の required status に設定する（リポジトリ設定。オーナー操作）**
- [ ] 実践調整 — Alpha issue で標準フローを一周し、docs の摩擦点を反映
- [x] コスト削減 / #343 — レビューコンテキスト圧縮（`review-snapshot.js` / `review-plan.js` / `review-exec-config.js` / `review-metrics.js`）を導入済み。#343 全体の完了ではなく、レビュー経路の圧縮部分の先行実装
- [ ] コスト削減 / #343 — 成果物テンプレート（証拠表・移譲計画）の機械生成
- [ ] コスト削減 / #332 — スキル使用履歴の集計を learning ロールに接続
- [ ] 検証拡張 / #357 — Codex `/codex:review` を diff-review ロールの標準経路として整備（正本整備後、ロール表を更新）
- [ ] 検証拡張 / #311 — frontend specialist-review の正本整備（整備後、ロール表の「未整備」を解除）
- [ ] 検証拡張 / #353 — PR履歴の多軸分類を learning ロールの入力として接続（risk-modeling への還元）
- [ ] 永続化 / #343 — （判断保留）artifact のコミットファイル化。PR本文運用が緩いと判明した場合のみ

## 関連

- [docs/agent-workflows/requirement-probe.md](requirement-probe.md) — 非言語化要件・完了条件の洗い出し
- [docs/agent-workflows/evidence-check.md](evidence-check.md) — 完了証拠の検証とスコープドリフト監査
- [docs/agent-workflows/risk-modeling.md](risk-modeling.md) — 実装前リスクモデリング
- [docs/agent-workflows/codebase-recon.md](codebase-recon.md) — 実装前の既存実装調査
- [docs/agent-workflows/pre-commit-review.md](pre-commit-review.md) — コミット前セルフレビュー
- [docs/agent-workflows/review-angles/README.md](review-angles/README.md) — 観点別レビュー（7系統のアンカー・Tier・出力契約の正本）
- [docs/agent-workflows/systematize.md](systematize.md) — 自動化候補の提案
- [docs/agent-workflows/skill-design-rubric.md](skill-design-rubric.md) — 各正本が満たすべき6項目
- [docs/ai/README.md](../ai/README.md) — AI作業ルール入口
