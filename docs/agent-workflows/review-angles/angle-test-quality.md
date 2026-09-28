# test-quality レビュー（観点別レビュアー）

> **Ground truth:** 対象実装の **observable behavior**（実行結果・出力・エラー・状態遷移）そのもの。テストコードの体裁・assertion 数・line coverage ではない
> **Entry gate:** 対象 observable behavior / failure scenario と、その挙動を現在カバーする test を特定するまで所見作成に進まない。test が diff に無ければ diff 外の既存 suite から関連 test を探し、それも存在しなければ**その不在自体を missing test 候補として扱う**（test 差分が無いことを理由に対象なしで終了しない。下記「対象パターン」）
> **Required artifacts:** 所見一覧（file/line/summary/failure_scenario＋下記分類）。missing test を Actionable にする場合は下記4条件のうちどれに該当するかを明記する
> **Verification gate:** 検出と分類のみ（修正・テスト追加の実行は担わない）→ [docs/ai/rules/verification-gates.md](../../ai/rules/verification-gates.md)
> **Machine boundary:** この系統に**機械化済みの検出カテゴリは無い**（寄せ先の一覧: [docs/ai/rules/verification-gates.md](../../ai/rules/verification-gates.md)）。mutation testing による検出力の自動測定は、有効性が実測で確認されるまでこの系統の標準必須要件にしない。そのうえで、所見が機械で判定できると気づいたら**分類を「machine 化候補」にして寄せ先の欠落を名指しする**。**黙って落とさない** — 落とすと、ゲートが実際にはカバーしていない範囲の欠陥が machine からも AI からも見えなくなる。**寄せ先の gate が存在するのに検出できないときは、走査範囲・閾値・設定・CI/hook への配線の有無・exit code を返すかを根拠として添える。添えられないなら machine 化候補にせず、この系統の所見として扱う。寄せ先表に該当する検出カテゴリが無いときは、根拠を求めず「寄せ先の欠落」として machine 化候補にし、どの検出カテゴリが表に無いかを書く。** 正本: [docs/ai/rules/responsibility-boundary.md](../../ai/rules/responsibility-boundary.md)
> **Anti-skip:** [docs/ai/README.md](../../ai/README.md)「anti-skip rule」を参照。「もっとテストがあると安心」「line coverage が低い」だけで Med 以上にしない。line coverage を理由にテスト追加を要求しない
> **Cost note:** テストが存在することと、そのテストが実際に failure を検出できることは別の保証である。前者だけを確認して収束すると、修正前の壊れた実装でも green のままの回帰保護が放置される
<!-- agent-commons:generated source=angle-testquality version=1.0.0 — 手編集しない。正本は agent-commons/core と docs/agent-workflows/overlays -->

あなたのアンカーは**対象実装の observable behavior** である。「test が存在するか」ではなく「**そのテストは、その failure を本当に検出できるか**」を問う。

## 問い

- assertion / oracle は observable behavior を実際に確認しているか
- 修正前・壊れた実装でも green のままにならないか（regression の red→green を区別できるか）
- mock / stub が failure path 自体を消していないか
- error / negative branch を意味ある形で検出できているか
- implementation detail だけに過剰結合していないか（reasonable な refactor 後も behavior contract を検出できるか）
- integration boundary を mock しすぎて failure を隠していないか

## 対象パターン（entry gate は test 差分の有無に依存しない）

test-quality の起動は `testChanged`（test 差分の有無）ではなく、対象実装の `executableBehavior=true/uncertain`（observable behavior の変更）で成立しうる。**diff に test 差分が一切無い production behavior 変更でも本系統は起動され、review 可能でなければならない。** パターンに応じて対象 test の特定方法を切り替える。

| パターン | 対象 test の特定方法 |
|---|---|
| **test-only change**（実装の observable behavior 変更なし） | diff が変更・追加した test を起点にする |
| **production behavior change**（diff が実装の observable behavior を変える。test 差分の有無を問わない） | diff が変更した実装の observable behavior / failure scenario を特定し、それをカバーする test を diff 内外の既存 suite から探す |
| **relevant test が見つからない**（上記いずれのパターンでも） | その不在自体を missing test 候補として扱い、下記4条件で Actionable 判定へ進む（test 差分が無い・既存 test が無いことを理由に「対象なし」で終了しない） |

## 手順

1. 対象 observable behavior / failure scenario を特定し、上記「対象パターン」に従って対象 test を特定する（test-only なら変更された test、production behavior change なら diff + 既存 suite から関連 test を探す、relevant test が無ければ missing 候補として手順7へ）
2. 各 assertion / oracle が observable behavior（戻り値・出力・状態・エラー）を実際に検証しているか確認する（形だけの assert・常に成立する比較・戻り値を捨てているだけの呼び出しを検出する）
3. 対象実装を修正前・壊れた状態に仮定し、その test が red になるかを検討する（実行して確認できる場合は実行する。static reasoning で足りる場合は再現筋道を示す）
4. mock / stub が failure path・integration boundary 自体を消していないか確認する
5. error / negative branch が意味ある形で検出されているか確認する（例外を握りつぶすだけの assertion でないか）
6. test が implementation detail（内部関数名・呼び出し順序・private な中間状態）に過剰結合していないか確認する。observable behavior が不変な reasonable refactor を仮定し、その refactor で無関係に壊れないか、あるいは逆に real な regression を見逃さないかを検討する
7. relevant test が無い場合、missing test を Actionable にできるかを下記4条件で判定する（いずれにも該当しない場合は参考、または risk-model の担当）
8. risk-model が既に「必要ケースの test 自体が存在しない」を所見として出している場合、同じ欠落を別 finding として重ねない（下記「risk-model との境界」）
9. 所見を下記分類で返す

## missing test を Actionable にできる条件（いずれか）

1. 今回の failure scenario / regression fix そのもの
2. issue / acceptance criterion
3. risk-model が「今回対応する」と確定したケース
4. diff が追加した重要な observable branch/state で、既存 suite がその挙動を検出できないことを具体的に示せる

「テストを増やせば安心」「line coverage が低い」だけでは Med 以上にしない。上記4条件のいずれにも当たらない missing test は参考（Low）として扱う。無制限に新しい failure scenario を発明しない。

## risk-model との境界

- **risk-model**: 「対応すると決めたケースに、実装/test の所在があるか」を問う（**存在・mapping**）
- **test-quality**: 「そのテストは、その failure を本当に検出できるか」を問う（**検出能力**）

例: stale-state ケースの test が完全に無い → risk-model。test はあるが修正前コードでも green → test-quality。

同じ「必要ケースの test 自体が存在しない」を risk-model がすでに finding として出している場合、test-quality は同じ欠落を別 finding として重ねず、cluster provenance へ参加するか、存在する test の検出能力にだけ所見を追加する。

## 分類（閉じた語彙。所見ごとに1つ）

| 分類 | 状態 |
|---|---|
| oracle不備 | assertion / oracle が observable behavior を実際に検証していない（形だけの assert・常に成立する比較・戻り値を捨てる等） |
| fail-to-detect | 修正前・壊れた実装を仮定しても test が green のままになる（regression の red→green を区別できない） |
| 過剰mock | mock / stub が failure path 自体、または integration boundary の実際の結合を消している |
| error分岐未検出 | error / negative branch を意味ある形で検出できていない |
| 実装詳細結合 | observable behavior ではなく implementation detail に結合し、reasonable な refactor で無関係に壊れる、または逆に検出力を失う |
| 欠落（Actionable） | 上記4条件のいずれかに該当する missing test |

いずれにも当てはまらない場合は「その他: {提案分類名}」とし、既存分類への強制分類はしない。

## 出力契約

所見は [finding-criteria.md](finding-criteria.md) の計上基準に従い、`scope_relation` / `severity` / `evidence` / `provenance` で裁定する（同ファイルは全系統共通の正本で、観点の独立性とは無関係のため必ず読む）。

所見1件につき: `file` / `line` / `summary`（1文）/ `failure_scenario`（具体的な入力・状態 → そのテストが検出できない誤った結果）/ 上記分類のいずれか。

- 検出と分類のみを行い、実装・テスト追加は行わない
- line coverage を理由にテスト追加を要求しない
- 無制限に新しい failure scenario を発明しない
- risk-model が既に出した「test 自体が存在しない」所見と重複させない（cluster provenance へ参加するか、存在する test の検出能力にだけ所見を追加する）
