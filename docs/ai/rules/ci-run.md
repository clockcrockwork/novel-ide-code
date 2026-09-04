# CI の起動単位とマージまでの手順

GitHub Actions の重い CI（`.github/workflows/ci.yml`）の起動単位は **repository の visibility で分かれる**。

| repository | PR での起動 | 根拠 |
|---|---|---|
| **private**（control repo。現行 novel-ide） | **起動しない**。観点レビューループが収束したあとに、明示的な操作で最新 HEAD に対して 1 回だけ起動する（#551） | required status checks を利用できず技術ゲートが存在しない。Actions minutes は Free 枠を消費する |
| **public**（public code repository） | **`pull_request` イベントで起動する**（open / synchronize / reopen） | required status checks が技術ゲートとして効く。標準ランナーの Actions 利用は public repository では無料・無制限で minutes 枠を消費しない |

この分岐は `ci.yml` の `changes` / `secret-scan` / `required-gate` の 3 job に置いた
`github.event_name != 'pull_request' || github.event.repository.visibility == 'public'` が実装する。
詳細は下記「PR 起動の適用範囲」。

> **重要**: novel-ide は現在 GitHub Free の private repository である。GitHub の protected branches
> （required status checks を含む）は、Free プランでは **public repository が対象**であり、
> private repository は Pro / Team / Enterprise 系プランが対象となる。つまり「設定はできるが効かない」
> のではなく、**現在のプラン・private 構成では、強制可能な branch protection / required status
> checks をそもそも利用できない**。そのため本書は **private 期間**（現在）と
> **public/private 分離後の public code repository**を明確に分けて記述する。
> private 期間の安全性は **エージェントの運用手順（プロセスゲート）** に依存し、GitHub 側の
> **技術ゲート**には依存できない。この区別を崩す記述は書かない。

- 設計の背景・不採用案: `docs/planning/ci-split-design.md` §11
- 変更種別ごとのローカル検証コマンド: [verification-gates.md](verification-gates.md)

---

## PR 起動の適用範囲（なぜ visibility で分けるか）

**#551 の「PR push では CI を起動しない」と、public repo で `required-gate` を required にすることは、
本 repository で観測した挙動のもとでは両立しない。**

観測した事実（`novel-ide-code#6` での実測。同一 PR・連続する2つの head SHA での対照）:

| head SHA | CI の起動イベント | `required-gate` の check run | PR の required 欄 | `mergeable_state` |
|---|---|---|---|---|
| `f8e11e8` | `workflow_dispatch` | `conclusion: success`（head SHA 上に実在） | `Expected — Waiting for status to be reported` | `blocked` |
| `76a4385` | `pull_request` | `conclusion: success` | 満たされた | `clean` |

check run の内容はどちらも success で、**変わったのは起動イベントだけ**である。

> **一般則としては書かない**: required status checks が head SHA 単位で評価されることは GitHub の
> 仕様だが、「どの起動イベント由来の check run が充足として扱われるか」は公式ドキュメントで
> 確認できていない。本節は **本 repository の設定（ruleset・GitHub Actions）における実測**として
> 扱い、他環境へ一般化しない。将来 GitHub 側の挙動やドキュメントが変わりうる前提で読むこと。

分けられる理由は、2 つの制約が **visibility に対して排他**だからである。

- **minutes 削減が要るのは private だけ**: 標準ランナーの Actions 利用は public repository では
  無料・無制限で、Free 枠を消費しない。public 側で PR ごとに CI を回しても枠を圧迫しない。
- **技術ゲートが要る（かつ持てる）のは public だけ**: private（Free）では required status checks を
  そもそも利用できない。

したがって private では #551 の方針を**完全に維持**し、public でのみ `pull_request` 起動を有効にする。

### 実装上の制約

- **`on.pull_request` に `paths` / `paths-ignore` を付けない**。対象外の変更では workflow 自体が
  起動せず、`required-gate` が報告されないまま `Expected` で PR が詰む。絞り込みは従来どおり
  `changes` job の分類 → 各 job の `if` で行う（起動はするが中身を skip する形にする）。
- **ガードは `changes` / `secret-scan` / `required-gate` の 3 job に置く**。他 job は
  `needs: changes` の cascade で skip されるため不要。`required-gate` は `always()` との AND を保つ
  （`always()` を落とすと上流 skip 時に job ごと skip され、branch protection が skipped required を
  成功扱いにする穴が戻る。#430）。
- **`changes` job は `pull_request` イベント用の差分経路を持つ**。持たないと差分不明として
  fail-closed（全分類 true）に落ち、public の PR で常に全 job が走って分類による削減が消える。
  base/head は PR context（`pull_request.base.sha` / `pull_request.head.sha`）から取る
  （checkout は merge ref のため `GITHUB_SHA` は merge commit を指し、base 側の変更まで拾ってしまう）。
- 上記 3 点は `tests/gateScopeDrift.test.js` が機械検査する（トリガー欠落・`paths` 追加・
  ガード欠落・`always()` 欠落をそれぞれ検出する）。

### public 側で残る削減

`pull_request` 起動でも次の 2 つはそのまま効く。

- **変更分類**（`changes` job）: docs のみの PR では `lint-test` / `worker-test` / `semgrep` /
  `audit` / `bundle-check` が skip される。
- **`concurrency` の `cancel-in-progress`**: 同一 PR への連続 push では古い run が自動キャンセルされる。

失われるのは「レビューループ中の中間 HEAD では一切走らせない」という部分だけで、これは
required status checks が head SHA 単位で評価される以上、技術ゲートを持つ限り避けられない。

---

## 3 層の検証責務

| 層 | 実行者 | 何を | いつ |
|---|---|---|---|
| ローカル検証 | 実装／レビューエージェント・人間 | [verification-gates.md](verification-gates.md) の該当行（`npm run check` / `docs:links:check` / `check:artifacts` 等） | **修正ごと**（毎 commit の前） |
| 最終 CI | GitHub Actions `ci.yml` | lint・test・docs-links・bundle-check・audit・semgrep・secret-scan | **private**: レビュー収束後に手動起動（1 PR につき原則 1 回、修正が入れば都度）／**public**: `pull_request` イベントで自動（上記「PR 起動の適用範囲」） |
| バックストップ | GitHub Actions `ci.yml`（`push: main`） | 同上（main の実 HEAD に対して） | main への merge 後（自動） |

`artifacts-gate`（PR 本文の完了主張 artifact 検査）だけは例外で、軽量なため PR イベント
（open / 本文編集 / push / reopen）で自動実行する。CI 枠の主消費は `ci.yml` 側にある。

---

## 通常フロー（private repository）

> public code repository では `pull_request` 起動のため下図と異なる（push ごとに CI が自動で走り、
> `required-gate` が PR の required 欄を満たす）。適用範囲は上記「PR 起動の適用範囲」を参照。

```text
実装・修正 → commit・push（CI は起動しない）
  ↓  ※push ごとに artifacts-gate だけが走る
観点レビュー → 指摘修正 → commit・push（CI は起動しない）
  ↓
レビュー系統が収束
  ↓
最新 HEAD で CI を明示起動  ← ここだけが重い CI の実行点
  ↓
エージェントが「merge 前必須確認」を実施 → 全項目クリアで merge
```

### CI の起動方法

**GitHub UI**: Actions タブ → 左の **CI** → **Run workflow** → 対象ブランチを選択 → 実行。

**エージェント / CLI**: workflow_dispatch を叩く（MCP なら `actions_run_trigger`、`method: run_workflow`、
`workflow_id: ci.yml`、`ref: <ブランチ名>`）。**対象ブランチ（`ref`）を取り違えると、意図しないブランチの
HEAD を検証してしまい、確認対象の PR には何の保証にもならない**。起動前に `pull_request_read`（`get`）で
PR の head ブランチ名を取得し、`ref` と一致させてから叩くこと。

起動時点のブランチ HEAD が検証対象になる。**起動後に push した場合は、その commit は未検証**なので
もう一度起動する。

---

## private 期間: エージェントの merge 前必須確認（正本）

> **この節が正本**。review-pr.md・create-pr.md 等から複製せず、本節を参照する。

private repository では required status checks が merge を強制しない。**エージェントが merge を
実行・提案する前に、以下をすべて自分で確認する**。GitHub UI 上で人間が確認せずに merge ボタンを
押すこと自体は技術的に防げないため、この確認はエージェント側の義務として運用で担保する。

`required-gate`（`ci.yml`・`workflow_dispatch`）と `artifacts-gate`（独立 workflow・`pull_request`
イベント）は起動契機が異なるため、**確認方法を分ける**。特に `artifacts-gate` は PR の checks に
test merge commit（GitHub がベースへのマージを試算した仮想 commit）を対象として付く場合があり、
head commit の SHA と一致しないことがある（GitHub 公式: test merge commit に status があればそちら
が評価対象、無ければ head commit が対象）。したがって `artifacts-gate` の確認では**check-run の**
head SHA 一致を要求せず、代わりに run 自身の出力に埋め込まれた**証明行（proof line）**との
完全一致で判定する（`scripts/agent/check-artifacts.js` の `runCli` が出力。時刻の前後関係を
突き合わせる曖昧な比較ではなく、値の完全一致で判定できる）。証明行は「どの PR の・どの head
SHA の・どの本文を・どの run が検査したか」（PR番号・head SHA・本文 sha256・run ID の4値）に
加え「その検査が通ったか（`result=ok`/`failed`）」も含む。run ID（`<GITHUB_RUN_ID>-
<GITHUB_RUN_ATTEMPT>`）を含めているのは、GitHub Actions runner 自身が step の `with:` 入力
をジョブログへ列0・逐語で出力するため、証明行と同じ書式の**ファイル名**を commit に混入
させるだけでログに偽の証明行を注入できてしまうことへの対策（敵対的レビューで実証。
check-artifacts.js 自身の出力を対象にした偽装対策では防げない — runner が直接書く経路の
ため）。run ID は GitHub がその run を実際にスケジュールした時点で初めて確定する値であり、
事前に用意するファイル名には正しい run ID を埋め込めない。

1. **PR の現在の head SHA・PR 番号・本文を取得する**（`pull_request_read` の `get`）。
2. **`required-gate` を次の手順で確認する**:
   a. `CI` workflow（`workflow_dispatch` で起動した run）のうち `head_sha` が、1 で取得した現在の
      head SHA と**完全一致**する run を `actions_list` の `list_workflow_runs`（`branch` 指定）
      または `actions_get` の `get_workflow_run` で特定する（ブランチ名の一致だけで判断しない —
      古い run が同名ブランチに残っているだけの可能性がある）。**同一 SHA に対して run が複数
      ある場合は最新の run を対象とする**（同じ SHA へ `workflow_dispatch` を再起動すると新しい
      run が追加され、旧 run は残る — 上書きされない）。対象 run の `status` が `completed` で
      なければ（`queued`/`in_progress`）完了を待ってから **a を最初からやり直す**（§3a の run
      特定と同じ扱い）。対象 run の `status` が `completed` かつ `conclusion` が `cancelled` の
      場合（concurrency による中断等。cancelled は `status=completed`／`conclusion=cancelled`
      であり `queued`/`in_progress` ではないため上記の待機には当てはまらない）は、その run を
      対象として使わず、同じ SHA に対して `workflow_dispatch` を起動し直してから **a を最初
      からやり直す**。
   b. a で確定した run の中で `required-gate` job が success であることを確認する。**その run が
      re-run 済み（`run_attempt` が 2 以上）の場合**、過去の attempt に failure があったかを
      `actions_get`（`get_workflow_run_attempt` 等、attempt 指定での取得）で確認する。過去
      attempt に failure があった場合、最新 attempt が success でも「一過性障害としての1回の
      再試行」を消費済みとして扱う（§4 の failure 分岐の「1回だけ」再起動と同一の予算 — GitHub
      UI からの re-run も `workflow_dispatch` の再起動も、この節の「同一 run に対する再試行1回」
      という点では区別しない）。過去 attempt の failure 原因が診断されないまま re-run で success
      に切り替わった状態を、無条件に「success だから merge 判断へ進んでよい」根拠にしない —
      §4 の failure 分岐（原因を diff・ログから特定し、PR 起因なら修正して push、一過性障害と
      判別できるならそこで初めて1回の再試行として扱う）に従う。
3. **`artifacts-gate` を次の手順で確認する**（check-run の head SHA 一致は求めない。証明行で
   代替する）:
   a. **run を特定する**: `actions_list` の `list_workflow_runs`（`workflow_id: artifacts-gate.yml`、
      `branch` に PR の head ブランチを指定）で最新 run を取得する（`get_check_runs` の check-run
      `id` は `get_job_logs` が要求する run/job の ID 体系と異なり流用できないため使わない）。
      - **run が1件も返らない場合**は、`artifacts-gate` の起動そのものを確認できていない状態
        なので、待たずに 4 の「workflow の起動・完了状態を確認できない場合」の分岐（人間へ
        報告）へ進む（Dependabot PR の `skipped` とは区別する — `skipped` は run 自体は存在し
        `conclusion=skipped` になる。run が無いのは全く別の異常）。イベント直後の反映遅延・
        Actions の retention 超過による run の消失も区別せず一律この扱いとする（意図的な
        判断 — 発生頻度が低く、原因の切り分けより人間への即時報告を優先する）。
      - `status` が `completed` でなければ（`queued`/`in_progress`）完了を待ってから **a を
        最初からやり直す**（同じ呼び出しを再実行して最新状態を取り直す。待っている間に別の
        push で run が差し替わっている可能性があるため、待った後の結果を前提にしない）。
      - `conclusion` が `cancelled` の場合（concurrency による中断等）は新しい run の完了を
        待ってから **a を最初からやり直す**（cancelled になった run の `id`/`run_attempt` を
        使い回さない — 新しい run は別の run ID を持つ）。新しい run が一定時間経っても現れ
        ない場合（後続の push/本文編集が無く再走が起きない）は、待ち続けずに PR 本文を編集
        して再走を発生させる（`artifacts-gate` は `workflow_dispatch` を持たないため、
        イベントを自分で起こすのがこの状態からの唯一の脱出経路）。**この場合は a ではなく
        手順1から**（本文を編集した以上、下記 4 の「それ以外の形で…不一致」の分岐と同じ理由で
        本文の再取得が必要）。
      - `conclusion` が `skipped` の場合（Dependabot PR は `artifacts-gate.yml` の
        `if: github.actor != 'dependabot[bot]'` により job 自体が走らず、証明行を出す経路が
        存在しない）、**かつ この run 自身の `actor`（`github.actor` に対応する値。re-run 時に
        異なりうる `triggering_actor` は判定に使わない）が `dependabot[bot]` である場合に限り**、
        この PR では artifacts-gate の確認を対象外とする（PR の作成者ではなく run 自身が持つ値
        のため、a で run を取得した際にあわせて確認する — 1 の取得項目を増やす必要はない）。
        安全性は `required-gate` の確認と人間によるレビュー内容確認に委ねる。**それ
        以外の actor で `skipped` になった場合**（PR 自身が `artifacts-gate.yml` の `if` 条件
        や起動対象を変更してゲートを無効化した可能性がある — job が走るかどうかは
        `pull_request` イベントでは PR 側の workflow 定義に従うため、PR 自身で制御できる）は
        対象外にせず、4 の「workflow の起動・完了状態を確認できない場合」の分岐（人間へ報告）
        へ進む。
      - 上記いずれにも当てはまらない（`completed` かつ `skipped`/`cancelled` でない）場合の
        みここで確定した run を使う。この呼び出しで得た **run の `id`・`run_attempt`** を
        控える（`--run-id` に `<id>-<run_attempt>` の形式で渡す。証明行の run ID をログの
        テキストからではなく、この API 呼び出しから独立に得ることが偽装対策の要 — 上記背景
        参照）。
   b. a の run に属する `artifacts-gate` job の `job_id` を特定する（`actions_list` の
      job 一覧を **a で得た `run_attempt` を指定して**取得し、job 名で引く — attempt を
      指定しないと最新 attempt の job が返るため、a で控えた `run_attempt` と食い違う
      job を引く可能性がある）。`get_job_logs`（`failed_only` は付けない — success 時の
      ログも必要）でログを取得してファイルへ保存する。1 で取得した本文もファイルへ保存する。
      **ログ・本文のどちらも、シェルの変数展開を経由しない方法**（Write 等のツールで直接
      書き込む）で保存する（heredoc・`echo` 等はバッククォート・`$` 等を展開し内容を変質
      させる。ログは runner が逐語出力した攻撃者制御テキストを含みうるため特に注意 —
      本節冒頭の背景参照）。本文が未設定（API が `body: null` を返す）の場合は、文字列
      `"null"` を書き込まず **0バイトの空ファイル**を保存する。
      現在の（PR の head をチェックアウトした）リポジトリルートで、依存インストール済み
      （`npm ci` 実行済み）の環境で実行する（`check-artifacts.js` は `mdast-util-from-markdown`
      等を静的 import するため。証明行の書式は生成側〔run が実行した bundled action〕と
      検証側〔ここで実行するローカルの `check-artifacts.js`〕で一致している必要があるため、
      PR ブランチと無関係な古い/別ブランチのチェックアウトで実行しない）。
      `node scripts/agent/check-artifacts.js --verify-proof --log-file <ログファイル>
      --pr-number <PR番号> --head-sha <head SHA> --body-file <本文ファイル>
      --run-id <a で控えた run の id>-<run_attempt>` を実行する（`--pr-number` は `#` 付き・
      無しのどちらでも受理される。`--head-sha` は大文字小文字を区別しないフル40桁 SHA —
      短縮 SHA のみ引数エラーになる。`--run-id` は必ず a の API 呼び出し結果から組み立てる —
      ログ中の `run=` の値をそのまま使うと偽装対策の意味が無くなる）。証明行の書式・偽装対策
      （行全体一致のみ受理する・run ID を要求する等）は `scripts/agent/check-artifacts.js` の
      コード自身を正本とする（ここにも `docs/planning/ci-split-design.md` にも複製しない）。
      終了コード 0 なら「4値一致かつ result=ok」。非0の場合、stderr で下記 c の分類（「不一致」
      ／「result=failed」／「確認不能」／「証明行が見つからない」の4分類、または呼び出し側の
      引数の誤り）に従って切り分ける。
   c. b の stderr が区別する4分類（「不一致」／「result=failed」／「確認不能」／「証明行が
      見つからない」）は、それぞれ次の 4 の分岐へ進む（分岐の並び順は変更されうるため、
      以後の改訂でもここは番号や行番号ではなく分岐の内容で参照すること）:
      - 「証明行が見つからない」（run はあるがログに証明行が無い — a で拾えなかった早期失敗・
        ログの部分取得等）と「確認不能」は、**どちらも** 4 の「workflow の起動・完了状態を
        確認できない場合」の分岐（人間へ報告）へ進む。
      - 「不一致」は相違した値に応じてさらに分岐する — **run ID だけ**が相違する場合は 4 の
        「run ID だけが…不一致の場合」の分岐（§3a やり直し）、run ID 以外の値（head SHA・
        本文 sha256・PR番号）が相違する場合は 4 の「それ以外の形で…不一致」の分岐（本文編集
        して再走）の対象。
      - 「result=failed」（4値は一致しているが判定結果が失敗）は 4 の「result=failed の場合」
        の分岐へ進む。**「不一致」へ寄せない** — 原因と無関係な本文編集を誘導しないため。
      - 上記4分類とは別に、**必須引数（`--log-file`/`--pr-number`/`--head-sha`/`--body-file`/
        `--run-id`）の欠落**、または `--head-sha` がフル40桁でない・`--run-id` が
        `<id>-<run_attempt>` 形式でない場合は**引数エラー**として非0終了する（stderr に
        「引数が必須です」または `FULL_SHA_RE`/`RUN_ID_RE` の書式エラーが出る — いずれも
        「確認不能」ではない。ファイル自体は読めているか、コマンドの呼び出し方が誤っている
        だけで、PR やログ・本文の状態とは無関係）。これは 4 のどの分岐にも進まない — 上記 b の
        指示に従って引数を組み立て直し、`--verify-proof` を再実行するだけでよい。
4. 1〜3 のいずれか一つでも満たさない場合は **merge を実行・推奨しない**。
   - CI が未実行、または対象 SHA に紐づく `required-gate` run が無い場合 → **まず手順1をやり直して
     現在の head SHA を取り直す**（起動と待機の間に別の push で head が動いていると、起動した run
     の `head_sha` は手順1で取得した古い SHA と永久に一致しない）。取り直した head SHA に対する
     run がなお無ければ、レビューが収束していることを確認したうえで `workflow_dispatch` を正しい
     `ref` で起動し、完了を待つ。**同じ head SHA に対して2回起動しても対象 run を特定できない
     場合は確認不能として人間へ報告する**（起動自体が機能していない可能性があり、無限に起動し
     続けない）。
   - `required-gate` job が success 以外の場合（`failure`／`timed_out` 等。cancelled は §2a 側で
     同じ SHA への再起動を扱うためここには到達しない。job 自体が作られない `startup_failure` 等
     で job を特定できない場合は次項の「確認できない場合」として扱う）→ 原因を diff・ログから
     特定する。**PR の変更内容に起因する失敗**（lint/test/audit 等の実失敗。**テストの断続的な
     失敗〔flaky〕もここに含める** — 「たまたま失敗した」ことは PR の変更内容に起因しないことの
     証明にならない）は原因を修正して push（新 HEAD）し、手順1からやり直す。**PR の変更と無関係な
     一過性障害**（ネットワーク瞬断・GitHub 側の一時的な不調等、インフラ層の障害であるとログから
     明確に判別できる場合に限る。判別に確信が持てない場合は一過性障害として扱わず、修正して push
     する側に倒す）は、同じ SHA に対して `workflow_dispatch` を再起動するか、同一 run を re-run
     するか、いずれか**1回だけ**行い（状態遷移表「同一 SHA に対して `workflow_dispatch` を
     再起動」「CI を同一 run 内で Re-run」の各行 — この2つは同じ「同一 run に対する再試行1回」の
     予算を共有する）、新しい run／attempt の完了を待って §2 からやり直す（新 HEAD を作る必要は
     ない）。**再試行後も同じ job が success でない場合は、一過性障害としての再試行を打ち切り**、
     原因を修正して push するか、判別できなければ確認不能として人間へ報告する（無制限の再試行で
     実在する失敗を再試行回数の運で通過させない — §2b が過去 attempt の failure を検出した場合も
     同様にこの分岐へ従う）。
   - `artifacts-gate` の証明行のうち **run ID だけ**が現在の PR 状態と不一致の場合（PR番号・
     head SHA・本文 sha256 は一致）→ **本文編集はしない**。§3a を最初からやり直し、最新の
     run の `id`/`run_attempt` を控え直してから再度 `--verify-proof` を実行する（`--verify-proof`
     の stderr がこの場合の案内を出す）。やり直しても解消しない場合は、偽装された証明行が
     混入している可能性があるため確認不能として人間へ報告する（§3a の cancelled 分岐が
     「新しい run が現れなければ本文編集で再走を起こす」という脱出経路を持つため、そのやり直し
     の過程で本文編集に至ることはある — その場合はこの禁止より §3a の脱出経路を優先し、編集後は
     `body-sha256` も変わるため手順1からやり直す）。
   - `artifacts-gate` の証明行がそれ以外の形で現在の PR 状態と不一致（head SHA・本文
     sha256・PR番号のいずれかが食い違う）の場合 → `artifacts-gate` は `workflow_dispatch` を持たない
     （`pull_request` イベント専用）ため、**PR 本文を編集して再走を待つ**。新しい run に対して
     **手順1（本文取得）から改めてやり直す**（§3 の a からではない — 本文を編集した以上、
     手順1で取得済みの古い本文ファイルには編集後の内容が反映されておらず、それを使い回すと
     `body-sha256` だけで恒久的に不一致になる。この不変条件は本文編集を伴う他の経路〔§3a
     の cancelled 分岐・状態遷移表「PR 本文のみ編集」行〕にも同様に適用される）。前 run で
     控えた値は1つも使い回さない（新しい run はログ・本文・run ID のいずれも古い run と
     異なる）。**同一の値が2回連続で不一致になった場合は、本文編集を繰り返さず確認不能と
     して人間へ報告する**（手順の誤りである可能性が高く、本文編集では解消しないため無限
     ループを避ける）。
   - `artifacts-gate` の証明行の4値は一致しているが `result=failed` の場合 →
     **本文を無関係に編集して再走させない**（4値が一致している以上、その run 自体が実際に
     artifacts-gate の検査に失敗している。原因は `--verify-proof` の stderr、または run の
     ログに出ている `check-artifacts` のエラー内容を見て特定する）。原因（PR 本文の完了主張
     artifact 不備等）を修正したうえで再走を待ち、新しい run に対して同様に手順1からやり直す。
     **原因を特定・修正しないまま同じ理由で2回連続 `result=failed` になった場合は、本文編集
     を繰り返さず確認不能として人間へ報告する**（上記の不一致ループと同じ理由）。
   - workflow の起動・完了状態を確認できない場合、証明行が見つからない場合（API エラー・権限
     不足・GitHub 障害・ログ/本文ファイルの取得失敗・run 自体の早期失敗等）は、**確認不能で
     ある事実と未検証項目を人間へ報告する**。この状態を「人間へ委ねたので通常どおり merge
     してよい」という経路として扱わない。人間がそれでも merge する場合は、通常の merge 判断
     ではなく「CI 未確認の例外的な手動 merge」として明示的に判断してもらう（エージェントは
     この例外判断そのものを代行・推奨しない）。

**既知の残余（証明行が束縛しない範囲）**: 証明行の `result` は `checkArtifacts()` の判定結果
（PR 本文の artifact 検査）のみを束縛する。`CHANGED_FILES` 自体の計算が空になった場合の経路ごとの
扱い（fail-loud の所在は `.github/actions/artifacts-gate/src/index.js`）は
docs/planning/ci-split-design.md §1.1 を正本とする（本文を複製しない。#446 round4）。残余は
「空ではないが部分的に欠落した一覧」（例: git diff 自体は成功したが取得漏れがある場合）で、
これはどの経路でも検出しない（`bundle-check`〔`required-gate`〕・人間のレビュー内容確認が
別の安全網として働く）。

この確認は agentic な merge 提案・実行の**直前に毎回**行う。「前回確認したから」「レビューが
収束したから」だけでは merge しない — 収束は CI を起動する条件であって、merge する条件ではない。

---

## 状態遷移（private 期間: 技術ゲートではなく運用判断）

private repository では GitHub 側が merge を技術的に強制停止しない。次の表は
**「GitHub が何を返すか」と「エージェント・人間が何を判断すべきか」を分けて**示す。

| 状態 | CI 状態（GitHub 側の事実） | private 期間の運用判断 |
|---|---|---|
| CI 未実行（push しただけ） | `required-gate` の check run が存在しない | **merge 禁止**。収束後に `workflow_dispatch` |
| CI 実行要求済み／実行中 | pending | **merge 禁止**。完了を待つ |
| CI 失敗（`required-gate`） | failure | **merge 禁止**。修正 → push → 再度手動起動 |
| `artifacts-gate` 失敗（証明行不一致・`result=failed`・確認不能） | failure | **merge 禁止**。対処は上記「merge 前必須確認」§4 |
| CI 成功（`required-gate`）／`artifacts-gate` も証明行が現在の PR 状態と一致して success | success | merge 判断へ進んでよい |
| CI 成功後に新しい push | `required-gate` の新 SHA には check run が無い | **merge 禁止・再実行**。古い成功 run を根拠にしない |
| CI 確認不能（API エラー・権限不足・GitHub 障害等） | 不明 | **merge を実行・推奨しない**。確認不能の事実と未検証項目を人間へ報告する。それでも人間が merge する場合は「CI 未確認の例外的な手動 merge」として明示判断してもらう（通常の merge 判断の代替経路にしない） |
| PR 本文のみ編集 | `artifacts-gate` が自動で再実行（新しい run ID が割り当たる。`required-gate` の対象 SHA は不変） | `artifacts-gate` は**手順1から**（§3a からではない — 本文を再取得しないと `body-sha256` が編集前の値のまま不一致になる）やり直して得た新しい run の証明行で確認、`required-gate` は SHA 一致で確認（別基準・上記「merge 前必須確認」） |
| workflow 設定自体を変更 | 変更後のブランチ HEAD を手動起動すると、そのブランチ版の `ci.yml` で実行される | 起動して確認 |
| CI を同一 run 内で Re-run（GitHub UI の re-run） | 同一 run の `run_attempt` が増え、その run の check run が置き換わる | 最新の結果だけを無条件に信じない。過去 attempt に failure があれば §2b・§4 の failure 分岐に従う（一過性障害としての再試行は `workflow_dispatch` 再起動と合わせて1回まで） |
| 同一 SHA に対して `workflow_dispatch` を再起動 | **新しい run が追加され、旧 run は残る（上書きされない）**。先行 run が実行中だった場合は concurrency で cancelled になる | 最新の run を対象とする（上記「merge 前必須確認」§2a・§3a。古い/cancelled になった run を根拠にしない） |
| PR を reopen | `reopened` は `artifacts-gate` の起動契機のため新しい run が走る。`required-gate`（`ci.yml`）は `workflow_dispatch` 専用のため reopen では動かず、対象 SHA の check run は直前のまま | `required-gate` は「対象 SHA と現在の head SHA が一致するか」で再確認（一致しなければ手動起動）、`artifacts-gate` は reopen で走った最新 run に対して証明行の一致＋`result=ok`で再確認する（§3a が「最新の run」を要求するため、reopen 前の run を根拠にしない。run ID も新しい run のものを使う） |
| Dependabot の PR | `required-gate` は通常 PR と同じ（push では CI が起動しない）。`artifacts-gate` は job-level `if` で skip される（証明行を出す経路が無い） | `required-gate` はマージ判断者が手動起動してから確認。`artifacts-gate` は run 自身の actor が `dependabot[bot]` であることを確認したうえでこの PR では確認対象外（上記「merge 前必須確認」§3a）— `workflow_dispatch` で代替起動しようとしない |
| run の actor が `dependabot[bot]` 以外の bot 等 | 通常 PR と同じ（push では CI が起動しない。`artifacts-gate` は skip されない） | 通常どおり手動起動してから確認 |
| run の actor が `dependabot[bot]` 以外なのに `artifacts-gate` が `skipped` になった場合 | PR 自身が `artifacts-gate.yml` の `if` 条件・起動対象を変更してゲートを無効化した可能性がある | 対象外にせず、確認不能として人間へ報告する（上記「merge 前必須確認」§3a） |
| main へ merge | `push: main` でバックストップ CI が自動実行 | 失敗したら follow-up 対応 |

**GitHub の protected branches（required status checks を含む）は、Free プランでは public
repository のみが対象**であり、private repository では利用できない。人間が UI から直接
CI 未実行のまま merge することを技術的に防ぐ手段が現状無い。これは意図的に受容している
残余リスクであり、public/private 分離まで一時的なものとして扱う
（下記「private 期間の残余リスク」）。

補足:

- **base（main）が進んだ場合**、成功済みの check run は head SHA に紐づいたまま残る。厳密に最新 main
  との組み合わせを検証したい場合は、main を取り込んで push（→ 新 SHA）してから再度起動する。
- **同一 SHA に対して `workflow_dispatch` を再度起動すると** concurrency（`cancel-in-progress`）で
  先行 run がキャンセルされうる（PR ブランチへの push では `ci.yml` は起動しないため、push では
  起こらない）。cancelled になった run を根拠にせず**最新の run**で判定すること・再起動が必要か
  どうかの判定手順は上記「merge 前必須確認」§2a が正本（ここに重複定義しない — cancelled な run
  を見るたびに無条件で起動し直すと、複数 run が同時に in_progress になり concurrency で互いを
  キャンセルし続けるループになりうる）。

---

## private 期間の残余リスク（記録）

- **GitHub UI からの誤 merge を技術的に防げない**。Free プランでは private repository に対して
  protected branches（required status checks を含む）を利用できないため、人間が Web UI から
  「Merge pull request」ボタンを押せば CI 未実行・CI 失敗でも merge できてしまう。
- 上記「merge 前必須確認」はエージェントの運用手順としてのみ有効で、人間の直接操作までは
  制御できない。この残余リスクは、public/private 分離により public code repository へ
  protected branches を適用できるようになるまで一時的に受容する（public/private 分離へ移行する動機の一つ）。
- 単独開発・逐次マージを基本とする現在の運用では、誤 merge が発生する経路（複数人の同時操作・
  レビュー未収束のまま UI から直接 merge する等）の発生可能性を限定できるため、public/private 分離までの
  一時的な残余リスクとして受容する（「事故が起きていない」ことをもって「実害が無い」とは
  みなさない）。運用体制が変わる場合（複数人体制・自動 merge 導入等）は再評価すること。

---

## 復旧経路

- CI の起動そのものが復旧経路（workflow_dispatch）なので、追加の経路は不要。何度でも再実行できる。
- `artifacts-gate` を再実行したい場合は PR 本文を編集する（`edited` で再走する）。**ただしどの
  状態で本文編集をしてよいかは上記「merge 前必須確認」§4 の分岐が正本** — run ID だけの不一致・
  `result=failed` では本文編集をしない（無条件に本文編集で再走してよいわけではない。§4 参照）。
- ラベルや状態ファイルを一切使わないため、「実行要求済みのまま止まった」中間状態は発生しない。

**既知の残余（エスカレーション回数の連続性）**: §4 の「2回連続で同じ結果になったら人間へ報告」は、
連続して確認を行う単一の実行（同一セッション、または前回の試行内容を引き継いだハンドオフ）を
前提とする。試行回数を状態ファイルや PR 本文へ永続化する仕組みは意図的に持たない（上記
「ラベルや状態ファイルを一切使わない」と同じ理由）。セッションが不連続に切り替わった場合、
新しいセッションは回数を 1 から数え直すため、原因が解消しない状態が続くとエスカレーション
までに要する試行回数がセッション断のたびに増えうる。これは private 期間の他の残余リスク
（上記「private 期間の残余リスク」）と同様に意図的に受容する——単独開発・逐次マージを基本と
する現在の運用体制では、無人で際限なくセッションが切り替わり続ける状況は考えにくく、いずれ
かのセッションで人間が介入する機会がある。

---

## public/private 分離後: public code repository の技術ゲート

> **この節は private 期間の設定 TODO ではない**。public code repository を作成した後に適用する
> 方針であり、現在の private repository では実施しない（Free プランでは private repository に対して
> protected branches・required status checks をそもそも利用できない）。

public code repository では branch protection（または ruleset）で以下を設定し、
**技術ゲート**として merge を強制する:

1. **Require a pull request before merging** を有効化（main への直接 push を禁止。緊急バイパスの
   扱いは下記「緊急バイパス方針」を参照）。
2. **Require status checks to pass before merging** を有効化し、required に次の 2 つだけを登録する。
   **前提として `ci.yml` が `pull_request` で起動すること**（`workflow_dispatch` の check run では
   required 欄を満たせなかった〔本 repository での実測〕。詳細は上記「PR 起動の適用範囲」）。
   個別 job（`lint-test` 等）は required にしない — `if` でスキップされた job の check run は
   conclusion `skipped` として作られ、branch protection がそれを成功扱いにするため
   （集約 `required-gate` に判定を一本化する理由。#430）。
   - `required-gate`
   - `artifacts-gate`
3. `bundle-check` を required に**個別登録しない**（`required-gate` が内部で判定する。個別登録すると
   意図した skip で PR が pending のまま止まる）。
4. **Require branches to be up to date before merging** の要否は、CI 消費と運用性のトレードオフで
   別途判断する（有効化すると main が進むたび全 PR で再実行が必要になり、枠保護の目的と衝突しうる。
   分離後の実際の PR 頻度・枠状況を見てから決める）。
5. **CI 成功後の新しい push では再検証を必須とする**（required status checks が SHA 単位で評価
   されることにより自然に満たされる。private 期間のような運用確認は不要になる）。`pull_request` の
   `synchronize` で新しい head SHA に対して CI が自動起動するため、手動起動の運用は public では不要。

これらは GUI / API 操作でありコードでは完結しない。リポジトリ分離作業の一部として実施する。

---

## public/private 分離後: 緊急バイパス方針

public code repository で branch protection を有効化したあとも、**管理者バイパスを全面禁止にはしない**。
CI 基盤障害・required check 設定の故障・GitHub Actions 障害・緊急セキュリティ修正など、通常経路で
進行不能になる場合に備え、限定的な緊急経路を残す。

- **通常時のバイパスは禁止**。緊急時のみ利用可能とする。
- 可能な限り **PR 経由のバイパスに限定する**（branch protection の "Allow specified actors to bypass
  required pull requests" 等、PR は経由するが required check を admin 権限で override する形）。
- **main への「理由なし」直接 push は禁止のまま**とする（緊急時であっても push 理由の記録は必須）。
- バイパスを行った場合、**PR 本文またはコメントに理由を記録する**（何が壊れていて、なぜ通常経路が
  使えなかったか）。
- **未実施の検証を明記する**（例: 「secret-scan 未実行」「semgrep 未実行」）。
- **後追い CI または修正 Issue を必須とする**（バイパスした検証を後日実施する、または追跡する
  issue を同時に作成する）。
- **緊急対応の完了を、後追い検証の完了と同一視しない**（バイパスして merge した時点では「対応完了」
  ではなく「後追い検証待ち」の状態として扱う）。
- **バイパス権限を持つ対象は最小限にする**（repository admin 等、必要最小の人数・ロールに限定する）。

---

## private 期間に行わないこと

- 上記「public/private 分離後」の branch protection 設定・緊急バイパス方針は、**private repository では設定しない**
  （Free プランでは private repository に対して強制力を持つ protected branches・required status
  checks をそもそも利用できないため）。
- PR #552（本 issue の実装）は、private 期間の CI 実行単位の変更（push から明示起動への分離）と
  「merge 前必須確認」の運用追加のみを完了条件とし、branch protection 設定を前提にしない。
