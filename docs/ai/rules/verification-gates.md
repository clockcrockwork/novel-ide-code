# 変更種別ごとの verification gate

「この変更種別なら、完了扱いにする前に最低限どのコマンドを通すべきか」を実在の npm script 名で引けるようにした参照表。AIエージェントが「小さい変更なので検証不要」で閉じないための機械的なゲート選択基準。

コマンド名は `package.json` の `scripts` を唯一の正とする（存在しない script を書かない。`/security-review` などのAIスキル実行ゲートを除く）。各スキル冒頭の Verification gate 欄からここを参照する（[skill-design-rubric.md](../../agent-workflows/skill-design-rubric.md)）。

---

## 変更種別 → verification gate

複数種別にまたがる変更は、該当する行のゲートを**すべて**通す。

| 変更種別 | 最低限の verification gate |
|---|---|
| **docs のみ** | `npm run docs:links:check`（リポジトリ内相対リンク切れ・アンカー不整合の機械検出。CI の `docs-links` ジョブで docs 変更時に必須）<br>参照導線の確認（リンクにすべきプレーン言及の欠落は機械検出不能なので目視。例外: [docs-maintenance.md](docs-maintenance.md)「public→control 参照の表記」）<br>※`.md` は `npm run format:check`（js/jsx/css 対象）・`lint`・`test` の対象外。これらは docs-only では実行不要（既存の未変更 JS/JSX の整形 warning で失敗し、無関係にブロックされるため）<br>※「ドキュメントのみなので確認不要」でもリンク・参照導線の確認は省略しない<br>※コード例・設定断片を含み実際に動く箇所を変更した場合は、該当種別（src / security 等）のゲートを適用する |
| **src 変更（一般）** | `npm run lint`<br>`npm run test`<br>`npm run build`（import 追加・削除・ファイル移動等の構造変更を含む場合）<br>※実質 `npm run check`（lint + check:thresholds + test）でまとめて通せる |
| **Tiptap / 本文処理** | 上記 src 一般 + 代表 fixtures の unit test<br>長文 / Unicode / surrogate pair / 不可視文字の観点（[risk-modeling.md](../../agent-workflows/risk-modeling.md) 領域表） |
| **GitHub同期 / 永続化（IDB）** | 上記 src 一般 + malformed / stale state の観点の unit / integration 相当<br>（stale SHA / GitHub側直接編集 / 401·403·409·5xx / 壊れた永続データ） |
| **security / public化** | `npm run security:secrets`（gitleaks）<br>`npm run security:semgrep`（semgrep: javascript / react / owasp-top-ten）<br>`/security-review`（[pre-commit-review.md](../../agent-workflows/pre-commit-review.md)） |
| **完了主張 artifact（PR本文）** | `npm run check:artifacts`（完了条件・想定ケース・既存実装調査・証拠表・レビューループ記録の存在／証拠なしチェック・収束宣言・関連 issue 参照の検出。CI の `artifacts-gate` で必須（mdast 依存を束ねた bundled local action として実行し、runtime の npm ci を要さない。bundle の更新・検証は [.github/actions/artifacts-gate/README.md](../../../.github/actions/artifacts-gate/README.md) / `npm run check:artifacts-gate-bundle`）、Claude Code では PreToolUse hook が PR 作成前にも実行。詳細: [evidence-check.md](../../agent-workflows/evidence-check.md)「機械的下限ゲート」） |
| **dependency / architecture** | `npm run analyze:deps`（dependency-cruiser）<br>`npm run analyze:unused`（knip）<br>`npm run analyze:duplicates`（jscpd）<br>※3つとも CI に配線されておらず手動実行のみ。exit code も返さない（depcruise は `.dependency-cruiser.js` の全ルールが `severity: 'warn'` のため 0 で返る）。走査範囲は下の寄せ先表を参照 |
| **overlays / agent-manifest.json / execConfigModule**（canonical source は外部リポジトリ `agent-commons` の `core/**` — このリポジトリはそれを consume する側で、`agent-commons/core` を直接持たない） | ローカル手順の正本は [docs-maintenance.md](docs-maintenance.md)「agent-commons の projected file」（`AGENT_COMMONS_PATH` を設定して `npm run agents:project` → `npm run agents:check`）。<br>CI 側は `scripts/agent/classify-changes.js` の分類で2経路に分かれ、この2経路で全入力形状をカバーする（片方だけが検査され他方が skip される diff 形状は無い）: overlay や projected な `.md` の変更（`docs=true`）は `docs-links` job が `node scripts/agent/verify-projection.js` を直接実行、`agent-manifest.json` / `agent-commons.lock.json` / `scripts/agent/**` の変更（`code=true`。いずれも `.md` でも `docs/` 配下でもないため `docs=false` になる）は `lint-test` job の `npm run test` が `tests/agentCommons.test.js`（受領証の独立ハッシュ照合込み）を実行する。両方に該当する diff は両方の job が走る |
| **モバイル viewport / iOS キーボード**（`src/App.jsx` / `src/index.css` / viewport 系フック / `src/lib/viewportMetrics.js` / `src/components/footer/**`〔viewport 系フックを呼ぶコンポーネント〕/ `EditorBox.jsx`・`PreviewMode.jsx`・`RubyEditPopup.jsx`〔`viewportMetrics` 利用箇所〕/ 下部固定・浮遊 UI の `position: fixed`・`sticky`・`100dvh`・`safe-area` に触れる変更。**このトリガー集合が正本** — pre-commit-review / risk-modeling は本行を参照し列挙を複製しない） | 上記 src 一般 + `npm run test:e2e -- e2e/mobile/`（`e2e/mobile/` のキーボード・viewport 系 spec。実行不能な環境〔ブラウザ未導入等〕では理由を明記して見送る） |

---

## ローカル検証と CI の責務分担

GitHub Actions の重い CI（`ci.yml`）は **PR ブランチへの push では起動しない**。レビューループ中の検証は
上表のローカルゲートが担い、GitHub Actions は**レビュー収束後の明示起動**と **main 反映後のバックストップ**を担う。
起動手順・マージ可否の状態遷移は [ci-run.md](ci-run.md) を正本とする。

「CI が拾ってくれる」を理由に上表のローカルゲートを省略しないこと（CI はレビュー収束後まで走らない）。

---

## 機械的検出は AIレビュー前ゲートへ寄せる

機械的に落とせる項目は、AIレビュー（観点別レビュー[review-angles](../../agent-workflows/review-angles/README.md) / `/security-review`）へ渡す前に CI / lint / analyze / security script で落とす。AIレビューは「機械的に判定できないもの」に集中させる（[risk-modeling.md](../../agent-workflows/risk-modeling.md)「将来の機械化」と同方針）。

| 観点 | 寄せ先 |
|------|--------|
| コーディング規約・custom rule 違反 | `npm run lint`（`eslint.config.js` の `localPlugin`） |
| パフォーマンス定数の未文書化 | `npm run check:thresholds` |
| 未使用 export / コード | `npm run analyze:unused`（knip。**報告のみで exit code を返さない**。`src` / `scripts` / `bench` / `tests` / `e2e` / `.github/actions/*/src` が対象、`worker/` は対象外。`includeEntryExports: true` により entry ファイル内の export も未使用判定の対象になる。`tests` は `tests/**/*.test.js` のみでヘルパー・フィクスチャは対象外） |
| 重複コード | `npm run analyze:duplicates`（jscpd。`src` と `scripts` が対象、`*.test.js` と `tests/` は対象外。**検出下限**は `.jscpdrc.json` の `minTokens: 50` / `minLines: 5` 未満を報告しない。**失敗判定閾値は未設定で exit code を返さない**。テキスト的に似ていない意味的重複は検出できない） |
| 整形逸脱（Prettier） | `npm run format:check`（js/jsx/css のみ。CLAUDE.md の決定により `npm run check`・CI には配線しない＝手動運用） |
| 依存方向違反 | `npm run analyze:deps`（dependency-cruiser。`src` のみが対象、`scripts/` `worker/` `tests/` `e2e/` `bench/` は対象外） |
| secret 混入 | `npm run security:secrets`（gitleaks） |
| 既知脆弱性パターン | `npm run security:semgrep`（semgrep。CI の `semgrep` ジョブと同一引数＝リポジトリ全体。**ローカルには semgrep が必要**。`--error` により findings があれば exit code は非0） |
| 未作成のままチェック済みの完了主張 | `npm run check:artifacts`（PR本文の artifact 存在・証拠形式） |
| docs 相対リンク切れ・アンカー不整合 | `npm run docs:links:check`（CI の `docs-links` ジョブ。外部 http は対象外・リポジトリ内相対リンクのみ） |
| 実装前ワークフローを含まない plan での実装移行 | ExitPlanMode PreToolUse hook（`scripts/agent/hooks/check-plan-gates.js`。plan 本文の想定ケース表・既存実装調査表 or 工程明記を検査。fail-open、最終防衛線は `artifacts-gate`） |

現時点で寄せ先が存在しない検出カテゴリもある（AI 層に残すのではなく、寄せ先が無いので machine 化候補として承認フローへ回す対象）:
- 成果物スキーマ（`manifest.json` 等）と正本 doc の記述の drift（例: 分類器の新規列挙 `PROSE_INERT_PATTERNS` / `CODE_FORCE_PATTERNS` と docs 記述〔review-angles/README.md・subagent-roles.md・ci-split-design.md 等〕の drift。#446 round3/round4 観点別レビュー 減算5）
- 同じ判断を持つ実装どうしの一致（例: base 解決・コマンド引数の二重管理。分類器入力を作る git diff 呼び出しのフラグ一致 — rename 検出・`core.quotepath=off`。ci.yml の `changes` / artifacts-gate.yml / check-artifacts.js の `gitChangedFiles` に加え、review-snapshot.js は `--find-renames` を意図的に維持し `oldPath` を classify 入力へ含める形で補完する — 計4経路が「rename 元の分類を落とさない」という同じ目的を異なる手段で満たしているか。#446 round2/round3/round4 観点別レビュー 減算5）
- 文書化された不変条件が未配線であること（呼び出し元がゼロ）
- client の変更系 fetch が `workerFetchWithCSRF()`（`workerFetch()` の変更系誤用がないか）・
  worker 側ルートが `validateCSRFToken` を通っているかの強制（現状は
  `docs/REVIEW_GUIDELINES.md`「CORS / CSRF」節のレビュー checklist と
  `worker/src/__tests__/csrf-route-coverage.test.ts`（ルート introspection によるテスト）に
  依存。ESLint custom rule / Semgrep 等での静的検出は未整備）
- control-only / visibility の public tree 混入検出（`build-public-tree.js` は runbook §4 step 2 の手動実行のみで CI 未配線）
- `docs/planning/issue-candidates.md` の状態語彙（`提示済み` / `承認→#番号` / `破棄（理由）`）からの逸脱検査
- docs 内の control-only ディレクトリ列挙（checklist・runbook 等の手順文中の記述）と `CONTROL_ONLY_DIRS`（`scripts/policy/public-tree-policy.js`）のパリティ（15箇所前後への複製を1箇所参照へ集約する減算は、checklist/runbook の構成変更を伴い本 PR のスコープ外として不採用。ラウンド3減算 S-6）
- strict secret scan（`npm run security:secrets:strict` = `run-strict-secret-scan.js`）の CI 配線欠如（public 化前の手動実行のみ）
- workflow YAML の静的検査（shellcheck / yamllint 等の CI 未配線。`.sh` / `.yml` を触る変更が `code` 判定されても、下流ゲートは当該ファイルの内容自体を検査しない）
- prose ディレクトリ配下に置かれる実行系・機械ゲート宣言ファイルの列挙漏れ（新しい設定ファイル形式が `CODE_FORCE_PATTERNS` に追加されないまま prose 扱いされ続けるケース。#446 round3）
- workflow 定義の pin 直書き・非 pin 参照・job/step env での shadow 禁止違反（`.github/workflows/**` を走査する検査器が未導入。例: NPM_PIN shadow の YAML 解釈付き検出。`scripts/agent/check-npm-pin-cooldown.js` の `resolvePin` は block style の `NPM_PIN:` 行のみを見る正規表現ベースのベストエフォートで、YAML パーサではない）
- container image の tag/digest 一致検証（更新時に registry で照合する手動手順のみ。機械検査器は未導入）
- pin 値と `engines` 等 repo 内制約の整合（`scripts/agent/check-npm-pin-cooldown.js` が root/worker の両 `package.json` を検査する。`.github/dependabot.yml` の cooldown 日数設定との二重化〔値のずれ検出〕は未検査）
- `.github/workflows/**` の逐語重複ブロック検出（検査器は未導入）
- remote / IDB 由来の動的キー辞書を生 object（`{}` 由来）で索引していないか（null-prototype
  正規化。INVARIANTS #11）の静的検査（現状は `security/detect-object-injection` の一般的な
  object injection 警告止まりで、null-prototype 化の有無までは判定しない。#609 round2 で
  `Object.hasOwn` / `Object.create(null)` による個別対応を実施したが機械検査は未整備）

新しく機械化できたカテゴリは、リスクモデリング表のチェック項目から外して lint / test / CI へ格上げしていく。

---

## anti-skip

変更規模・「既存に合わせた」を理由に上記ゲートをスキップしない（[docs/ai/README.md](../README.md#anti-skip-rule)「anti-skip rule」/ [implementation.md](implementation.md#anti-skip-rule)「anti-skip rule」）。スキップが必要な例外的事情がある場合は PR 本文に理由を明記する。

---

## 関連

- [docs/ai/README.md](../README.md) — ground truth / 必須 artifact / verification gate 表の正本
- [docs/ai/rules/implementation.md](implementation.md) — 機能実装・バグ修正の verification gate と anti-skip rule
- [docs/agent-workflows/skill-design-rubric.md](../../agent-workflows/skill-design-rubric.md) — 各スキルの Verification gate 欄からの参照元
- [docs/agent-workflows/risk-modeling.md](../../agent-workflows/risk-modeling.md) — 領域別の想定ケースと機械化方針
