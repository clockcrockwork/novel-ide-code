# CLAUDE.md

Claude Code 向けの **novel-ide 入口**です。

## Start here

作業開始時は [`docs/ai/README.md`](docs/ai/README.md) を読み、タスク種別に応じてそこから正本の rule / workflow / checklist へ進んでください。

`.claude/` 配下の command / agent / hook は Claude 固有の実行インターフェースです。**意味・判断基準の正本は repository docs / scripts 側に置き、このファイルへ詳細を複製しません。**

## Always-on

- 対象は **Vite + React + Tiptap v3** の `novel-ide`。詳細アーキテクチャは [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) を正とする。
- repository 固有の残余規約（UI 言語・外部 web guidance の採用境界）は [`docs/ai/rules/repository-conventions.md`](docs/ai/rules/repository-conventions.md) を正とする。
- MVP の段階・実装順は [`docs/MVP_PLAN.md`](docs/MVP_PLAN.md) を正とする。
- PR / review / issue / commit の共通規則は [`docs/REVIEW_GUIDELINES.md`](docs/REVIEW_GUIDELINES.md) を正とする。
- 検証コマンドと変更種別ごとの gate は [`docs/ai/rules/verification-gates.md`](docs/ai/rules/verification-gates.md) を正とする。
- 対話・issue・PR・docs は [`docs/ai/rules/communication.md`](docs/ai/rules/communication.md) に従い簡潔にする。
- **要件以上を足さない**: implementer の最小実装規則は [`docs/ai/rules/implementation.md`](docs/ai/rules/implementation.md)「実装中の原則」、観点レビュアーの所見計上基準（新規所見 / 参考）は [`docs/agent-workflows/review-angles/finding-criteria.md`](docs/agent-workflows/review-angles/finding-criteria.md)、収束判定は [`docs/agent-workflows/pre-commit-review.md`](docs/agent-workflows/pre-commit-review.md) ステップ6 を正とする。
- 工程ごとの役割分離・移譲計画は [`docs/agent-workflows/subagent-roles.md`](docs/agent-workflows/subagent-roles.md) を正とし、その entry gate を作業開始時に適用する。
- 設計判断・制約・不変条件・例外・過去の教訓に関わる実装／レビュー前は、`node scripts/agent-memory.js search "<キーワード>"` で検索型永続記憶を確認する。運用は [`docs/agent-memory/README.md`](docs/agent-memory/README.md) を正とする。
- UI / CSS / form / accessibility / security / mobile layout に影響する変更では、最初に [`.agents/skills/modern-web-guidance/SKILL.md`](.agents/skills/modern-web-guidance/SKILL.md) を参照し、採用境界は repository conventions に従う。
- main へ直接 push しない。必ず PR を経由する。
- 生成マーカー付き projected file は手編集せず正本を編集する。正本: [`docs/ai/rules/docs-maintenance.md`](docs/ai/rules/docs-maintenance.md)「agent-commons の projected file」。

## Compatibility references

旧入口の見出し名を参照する既存文書は、次の正本へ読み替えます。この節自体は規約本文を持ちません。

- `Project Vision` → [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)「創作文書管理方針」
- `Key Conventions` / `UI テキストは日本語` → [`docs/ai/rules/repository-conventions.md`](docs/ai/rules/repository-conventions.md) + [`docs/REVIEW_GUIDELINES.md`](docs/REVIEW_GUIDELINES.md) + [`docs/data-model/INVARIANTS.md`](docs/data-model/INVARIANTS.md)
- `検索型永続記憶` → [`docs/agent-memory/README.md`](docs/agent-memory/README.md)
- `Related Documents` → [`docs/ai/README.md`](docs/ai/README.md)

## Agent workflows

定型作業は [`docs/agent-workflows/`](docs/agent-workflows/) を正とします。Claude 固有 command が存在する場合も、workflow の意味を command 側へ重複させません。
