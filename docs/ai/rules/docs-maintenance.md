# ドキュメント更新・ルール追加の運用

ルールを追加・変更するときの反映先確認と、既存 Issue/PR への遡及判断フロー。

---

## ルール追加時の反映先チェックリスト

```
[ ] 追加するルールの置き場所は [docs/ai/README.md](../README.md)「ドキュメント置き場のガイドライン」に沿っているか
[ ] [docs/ai/README.md](../README.md) のタスク対応表に、新しい参照先を追記する必要があるか確認した
[ ] AGENTS.md / CLAUDE.md / GEMINI.md / copilot-instructions.md の常時入口に、正本への参照を追加・変更する必要があるか確認した
[ ] 既存の未完了 Issue / open PR に影響するか確認した（下記「遡及判断フロー」参照）
[ ] 関連するスキル（docs/agent-workflows/*.md）に手順の更新が必要か確認した
```

---

## 既存 Issue / PR への遡及判断フロー

```
新しいルールを追加・変更する
  └─ 既存の未完了 Issue / open PR に影響するか？
       ├─ 影響する
       │    ├─ 軽微な追記で済む → 既存 Issue のコメントに追記する
       │    └─ 方針変更・大きな追加 → issue 候補として承認フローでユーザーへ提示し、承認後に Issue を立てて関連付ける
       └─ 影響しない → ドキュメントを更新するだけでよい
```

### 「影響する」の判断基準

以下のいずれかに該当する場合は影響ありと判断する：

- 追加するルールが、未完了 Issue の実装方針を変える
- 既存 Issue の受け入れ条件を満たすには、新ルールを考慮した実装が必要になる
- open PR のレビュー観点が変わり、再レビューが必要になる

---

## ドキュメント置き場のガイドライン

AGENTS.md / CLAUDE.md / GEMINI.md / copilot-instructions.md に詳細ルールを集約しない。
これらのファイルは「常時遵守する最低限の原則」と「参照先一覧」のみを保つ。新しい規則は正本に書き、これらのファイルへは参照 1 行のみ追加する（本文を複製しない）。

恒久 docs に「残すもの / 削減するもの」の基準は [communication.md「恒久 docs」](communication.md#恒久-docs) を正とする。

| 書くべき内容 | 置き場所 |
|------------|---------|
| セルフレビュー項目・コーディング規約 | `docs/REVIEW_GUIDELINES.md` |
| タスク種別ごとのオペレーション手順 | `docs/ai/rules/*.md` |
| スキルとして実行する定型フロー | `docs/agent-workflows/*.md` |
| 設計方針・判断基準 | `docs/maintenance/*.md` |
| アーキテクチャ詳細 | `docs/ARCHITECTURE.md` |
| エージェント起動設定・参照先一覧 | CLAUDE.md / AGENTS.md / copilot-instructions.md |

---

## 段階の表記

**恒久 docs では、作業の段階を番号ではなく内容・名前で説明する。** 段階番号は計画文書ごとに独立した系列であり、恒久 docs に持ち出すと読み手はどの系列の番号か判別できない（実際に「導入段階の P1」と計画文書の Phase 1 が同一文書内で衝突していた）。経緯を残したい場合は「経緯: {計画文書のパス}」の形にし、番号を主語にしない（リンクの張り方は次節）。

なお `P0`〜`P3` は [pick-issue.md](../../agent-workflows/pick-issue.md)（トリアージ）と [analyze-pr-history.md](../../agent-workflows/analyze-pr-history.md)（lint 昇格）で**優先度**を指す確立した表記なので、段階の意味では使わない。

---

## public→control 参照の表記

**control-only ディレクトリ（`docs/planning/` / `docs/pr/` / `docs/pr-analysis/` / `docs/agent-memory/records/`。正本: `scripts/policy/public-tree-policy.js` の `CONTROL_ONLY_DIRS`）配下のファイルへ、それ以外の場所（`docs/` 配下に限らない。`CLAUDE.md` 等リポジトリ内の `.md` 全体が対象。ベンダリングされた外部スキルガイド〔パス中に `.agents/skills/*/guides/` / `.claude/skills/*/guides/` を含むファイル。root 起点に限らない〕は `check-doc-links.js` の走査対象外）から参照する場合は、**Markdown リンク・HTML `<a>` / `<img>` いずれも張らず**パスをバッククォートで示す**（例: `` `docs/planning/xxx.md` ``。Markdown リンク `[text](../planning/xxx.md)` は `npm run docs:links:check` が `public→control リンク（repo 分離後に切れる）` warning を出すが、HTML アンカーは検査対象外で警告が出ないまま GitHub 上で実リンクとして描画されるため特に注意。#470）。

- **control-only ディレクトリ同士の参照**（例: `docs/planning/` から `docs/pr/` へ）は対象外で、通常の Markdown リンクでよい。
- バッククォートは推奨表記であり必須ではない。**バッククォート無しの平文言及も同じ理由（Markdown リンクにしない）で意図的な表記であり、Markdown リンクへの「修正」はしない**（見出しに含まれる場合の扱いも同様。本文へ切り出すか既存文へ吸収するかは編集者の裁量）。

---

## agent-commons の projected file

生成マーカー行（`<!-- agent-commons:generated ... -->`）を持つファイルは**手編集しない**。正本は外部の canonical source リポジトリ `agent-commons` の `core/**` と、このリポジトリ側の overlaysDir（`docs/agent-workflows/overlays/`。consumer 固有の記述）。対象ファイル（asset → target）の一覧は `agent-commons` リポジトリの `registry.json` の `assets`/`target` を正本とする（このリポジトリには存在しないため、ここへ列挙を複製しない）。

`agent-commons.lock.json`（リポジトリルート）も**生成物であり手編集しない**。直近の projection が「どの入力（manifest / overlay / execConfigModule）からどの出力（projected file 一式）を作ったか」を各ファイルのハッシュで記録した受領証で、`scripts/agent/verify-projection.js` がこれと突き合わせて drift を検出する。

変更後は `npm run agents:project`（後述のとおりトラステッド環境が必要）で再生成し、`npm run agents:check` で drift が無いことを確認する。`agents:project` は orphan（registry から外れたのに残っている旧 projected file）を削除せず報告のみ行う。registry から asset が削除された更新を取り込んで `agents:check` が「余分な生成物」で止まった場合のみ `npm run agents:project -- --prune` を使う。

### consumer / commons の分離

このリポジトリ（consumer）は canonical source（`agent-commons`。private）を**直接は持たない** — vendoring された `agent-commons/` ディレクトリは無く、参照するのは `agent-manifest.json`（`commons.repo` / `commons.version` と consumer 固有の `targets` / `values` / overlaysDir）と、projection の結果である projected file 一式・`agent-commons.lock.json` だけ。

- **projection（再生成）はトラステッド環境で行う**: `agent-commons` をローカルに checkout し、`AGENT_COMMONS_PATH=<checkout のパス> npm run agents:project`（`package.json` の `agents:project`）を実行する。これは private リポジトリへの読み取りアクセスを要する唯一の操作。**checkout する ref の既定は `main` の最新**（特定の commons commit へ追随したいときだけそれを checkout する）。`agent-manifest.json` の `commons.version` と commons 側 `registry.json` の `version` が一致しない組み合わせを checkout しても、projection 自体が fail-loud で停止する（commons 側 `scripts/lib/projector.js` の version 不一致検査）ため、版ズレは実行時に機械的に検出され、人手での事前確認は不要。
- **CI 検証（`npm run agents:check` = `node scripts/agent/verify-projection.js`）は commons に一切アクセスしない**。node ビルトインのみに依存し、`agent-commons.lock.json` に記録されたハッシュだけで「projected file が受領証どおりか」「入力（manifest / overlay / execConfigModule）が変更されているのに reprojection されていないか」を fail-closed で検査する。**novel-ide の CI が private な agent-commons リポジトリへの network / token アクセスを必要としない**、という不変条件を守るための設計（public / fork PR でも CI が動く必要があるため）。CI 側の実行経路（どのジョブがいつこれを実行するか）は [verification-gates.md](verification-gates.md)「変更種別 → verification gate」の overlays 行を正本とする。
- **commons 側に変更があったときの更新手順**: (1) `agent-commons` をローカルに checkout（or 既存 checkout を更新。ref は前述のとおり既定で `main` 最新）する。(2) `AGENT_COMMONS_PATH=<checkout> npm run agents:project` を実行し、projected file と `agent-commons.lock.json` を再生成する（`agent-manifest.json` の `commons.version` を上げる必要がある変更ならそれも先に反映する）。(3) `npm run agents:check` で drift 0 を確認する。(4) 通常の PR フローで差分をレビュー・マージする。
- **commons へのアクセスを持たない担当者の引き継ぎ**: overlay ファイル（`docs/agent-workflows/overlays/`）自体は誰でも手編集できるが、その変更を projected file へ反映する再 projection（`npm run agents:project`）には commons checkout への読み取りアクセスが要る。アクセスが無い担当者は overlay の変更だけを PR に含め、`npm run agents:check` が検出する「未反映」の解消（再 projection）は commons へアクセスできるメンテナに依頼する。PR 本文に「overlay のみ変更・再 projection は要依頼」である旨を明記する。この PR は再 projection の commit が同じ PR へ入るまで CI（`docs-links`）が「未反映」で落ち続け、required check が揃わないためマージできない — 依頼を放置したまま止まらないよう、依頼先を PR 本文で名指しする。
- **`commons.version` と lock の `commons.revision` の違い**: `commons.version`（`agent-manifest.json`）は commons `registry.json` の `version` と一致していなければならない契約バージョンで、上げるかどうかは commons 側の規則（意味を変えない修正は据え置き／意味を変える修正は minor／契約破壊は major）で決まり、consumer は projection PR で追随するだけで自分では上げない。一致していないと上記のとおり projection が fail-loud で止まるため、不一致のまま consumer にコミットされることはない。一方 `commons.revision`（`agent-commons.lock.json` の `commons.revision`）は「直近の projection がどの commons commit から作られたか」を記録する provenance の git SHA で、契約バージョンとは別軸。**version が一致していても revision が古いまま**（= commons 側で意味を変えない修正がその後入ったが再 projection していない）ということはあり得るが、この場合 `agents:check` は drift として検出しない（契約上壊れていないため）。version の不一致は projection 実行時点で fail-loud に検出され、revision の古さは「反映漏れ」として `npm run agents:project` の再実行でのみ解消される。

---

## ルール追加後の周知

ルールを追加・変更した場合、PR 本文に以下を記載する：

```markdown
## ルール変更の影響

- 変更したドキュメント: （ファイルパス）
- 影響する既存 Issue/PR: （番号 or「なし」）
- 遡及対応: （追記済み / 承認済み Issue #{番号} で管理 / 不要）
```
