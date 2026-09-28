# novel-ide repository 固有規約

外部 skill や一般的な AI workflow へ混ぜるべきでない、`novel-ide` 固有の残余規約だけを置く。アーキテクチャ・データ不変条件・review 規約に正本がある内容はここへ複製しない。

## UI 言語

- UI テキストとデフォルト値は原則として日本語にする。
- 外部仕様・プロトコル・ユーザーが入力する識別子など、日本語化すると契約を変えるものは対象外。

## modern-web-guidance の採用境界

`.agents/skills/modern-web-guidance/` は外部由来 guidance であり、**skill に記載されていることだけを理由に novel-ide の採用仕様へ昇格させない**。

- current repository の仕様・security boundary・browser support と衝突する場合は repository 側を優先し、仕様変更が必要なら承認フローへ返す。
- **passkeys / built-in AI 系 guidance は現時点では採用保留**。認証または AI integration の対応 scope が明示的に採用された時点で再検討する。
- upstream 由来 skill 本文へ novel-ide 固有判断を直接書き込まず、この repository 側正本で補足する。

## authority routing（shadow assessment）の起動手順

[`docs/agent-workflows/review-angles/README.md`](../../agent-workflows/review-angles/README.md)「起動手順（orchestrator）」の手順2（`review:plan` 実行）は、snapshot ディレクトリに **valid な shadow assessment**（`shadow-routing.json`）が既にある場合にだけ authority mode（semantic `selectedAngles` が通常 angle の正本）へ切り替わる。同 README は consumer 非依存の正本であり `shadow-routing.js` は novel-ide 固有スクリプトのため、具体的な実行手順は手順化されていない——**本節が novel-ide 側の補完手順**である（`docs/planning/review-system-phase5-plan.md` §3.5 が assessment のスキーマ契約）。

authority mode を使う場合、手順2（`review:plan`）の前に:

1. `npm run review:shadow -- packet` で snapshot から routing packet（`shadow-routing-packet.json`）を作る
2. orchestrator が packet の `requiredDimensions` を判定し、assessment JSON（`{assessmentVersion, snapshotId, dimensions}`）を作る
3. `npm run review:shadow -- assess --file <assessment.json> --snapshot-id <snapshotId>` で `shadow-routing.json` を書く

を実行する。**省略しても壊れない** — assessment が無い・invalid・stale であれば `review:plan` は legacy Tier fallback を使い、従来どおり動く（安全側のデフォルト）。

## Authority receipt（Artifacts Gate 連携）の PR 本文への反映手順

`review:plan` が authority mode（前節）で計画を確定した場合、stdout に **Authority receipt**（`Authority receipt: v1 head=... authority=authority ...`）の1行が案内される。この行を PR 本文の「レビューループ記録」セクションへそのまま貼り付けること。貼らない場合、CI の Artifacts Gate（`scripts/agent/check-artifacts.js`）は authority routing の削減を認識できず、legacy Tier の必須系統をそのまま要求する（安全側フォールバックであり誤検出はしないが、削減効果が得られない）。

receipt は現在の PR head SHA に束縛されるため、**push のたびに再生成・再貼付が必要**（古い receipt は stale として無視され legacy Tier へ自動フォールバックする）。**再生成は `npm run review:snapshot` からやり直すこと** — `review:plan` は `requireSnapshot()` で既存の最新 snapshot を読むだけで、`manifest.headSha` は `review:snapshot` 実行時点の HEAD に固定されている。push・追加コミットの後に `review:plan` だけを再実行しても、この headSha は更新されず古いコミットの SHA のままの receipt が再生成されてしまう（CI は常に stale と判定し、authority routing の削減効果を得られない）。これは [`create-pr.md`](../../agent-workflows/create-pr.md) ステップ4.5（内部レビュー所見の裁定を `docs/pr/PR-{番号}.md` へ転記し追加コミット・push する工程）にも適用される——**このコミットが docs-only であっても head SHA は変わる**ため、初回 PR 作成時に貼った receipt は転記コミット後の `synchronize` で必ず stale になる。

**`review:snapshot` の再実行だけでは authority mode に戻らない**——`npm run review:snapshot` は新しい `snapshotId` と専用の snapshot ディレクトリを新規に割り当てる。前節の手順で書いた `shadow-routing.json` は古い snapshot ディレクトリの中にあり、`resolveRoutingAuthority()` は新しい snapshot ディレクトリ内に**同じ snapshotId の** `shadow-routing.json` が無ければ authority mode にしない（無ければ fallback 側へ倒す。これも安全側であり誤検出はしない）。そのため転記後は「`review:snapshot` 実行」だけで終えず、前節の手順1〜3（packet 作成 → orchestrator によるassessment作成 → `review:shadow -- assess`）を新しい snapshot に対してやり直してから `review:plan` を実行し、最新の receipt で PR 本文を更新すること（CI が赤になった場合の最も一般的な原因）。

**push を伴わない `escalate` 実行後も同様に再貼付が必要**——receipt の失効判定は head SHA の一致のみで行われ、`.git/agent-review/state.json`（git 非追跡・disposable）側の変化には反応しないため、head を変えずに `escalate --angles ...` だけを実行した場合、古い receipt がそのまま「有効」として使われ続ける（head SHA だけで束縛し、base SHA・snapshotId 等の追加フィールドは持たない設計判断による。CI 側の fresh checkout は state.json を参照できないため、この drift 自体を機械検出する手段はない）。`review:plan` を再実行し、案内された最新の receipt で置き換えることが望ましいが、それが難しい場合は次段落の「実効Tier:」宣言で暫定的に必須系統を底上げできる。

authority mode で PR 本文に「実効Tier:」宣言（`review-plan.js escalate` を経由しない widen-only の手動加算）を**正しい書式で**書くと、有効な receipt があっても必須系統は receipt の `effective` との**和集合**になる（縮小されない）。値をインラインコードで囲む・箇条書きにする等で書式が壊れている（かつ「実効Tier:」というラベル自体は現れている）場合は `実効Tier:` として認識されず fail-loud になる（`scripts/agent/check-artifacts.js` が「宣言なし」と「書式外」を区別し、receipt 採用時に書式外を検出可能な範囲で検出する）。**ただし全角空白を前置した宣言は検出対象外**——行頭アンカーは legacy `Tier:` 宣言の `TIER_MENTION` と同じく半角空白・タブのみ許容するため、全角空白を前置すると fail-loud にはならず「宣言なし」（receipt がそのまま有効）に静かに落ちる（Tier: 宣言側と同じ既知の残存制約であり、本機能が新たに悪化させるものではない）。authority mode での恒久的な加算は、PR 本文の宣言だけに頼らず `review-plan.js escalate --angles <系統>` を実行し receipt を再生成することを推奨する（state.json 側にも記録され、次の receipt にも自動的に引き継がれる）。
