# Supply Chain セキュリティ方針

npm 依存パッケージ管理・lockfile 変更レビュー・CI 脆弱性検出の運用方針。

セキュリティインシデント対応手順は [.github/SECURITY.md](../.github/SECURITY.md)、コードレビュー観点は [REVIEW_GUIDELINES.md](REVIEW_GUIDELINES.md) を参照。

---

## 依存追加・更新ポリシー

### 追加前の確認事項

| 確認項目 | 確認方法 |
|---------|---------|
| publish 者の信頼性 | npmjs.com でメンテナ・組織を確認 |
| メンテナンス状態 | 最終リリース日・open issue 数・GitHub stars |
| 週次ダウンロード数 | 極端に少ない場合は供給リスクが高い |
| `install` / `postinstall` スクリプトの有無 | `npm view <pkg> scripts` で確認。内容を必ず読む |
| ライセンス | MIT / ISC / Apache-2.0 以外は要確認 |

### 追加時のルール

- バージョン指定は `npm install <pkg>@<version>` で行う。`package.json` の `^` range は許容
- `--legacy-peer-deps` フラグが必要になった場合は、競合の原因を PR 説明に記載する
- major バージョンアップは破壊的変更を確認してから手動で行い、別 PR として分離する

---

## lockfile 変更のレビュー観点

PR で `package-lock.json` が変更されている場合に確認するポイント。

### 正常なパターン

- `npm install <pkg>` による新規エントリの追加
- `npm update` による既存エントリの `version` / `resolved` の変更
- Dependabot が自動生成した PR での変更

### 警告パターン（要確認）

- `resolved` の URL が `https://registry.npmjs.org/` 以外になっている
- `integrity`（sha512 ハッシュ）が変わっているのに `version` が変わっていない
- `package.json` に変更がないのに `package-lock.json` だけ変わっている
- 明示的に追加していないパッケージが新たに出現している

### 拒否パターン

- `resolved` が内部レジストリや見知らぬホスト名を指している
- `scripts` フィールドが通常存在しないパッケージに追加されている

---

## CI での脆弱性チェック

`.github/workflows/ci.yml` の `audit` ジョブが PR ごとに実行される。production deps audit（ブロック扱い）と CI/dev deps audit（可視化のみ）を分離している。

### production deps audit（ブロック扱い）

| 設定 | 値 | 理由 |
|-----|-----|------|
| `--audit-level` | `high` | moderate は Dependabot で週次管理するため CI ブロック不要 |
| `--omit=dev` | 有効 | ビルドツール・テストツールの脆弱性は本番攻撃面ではない |
| 対象ディレクトリ | root・worker 両方 | worker は本番稼働する Cloudflare Worker のため必須 |

High/Critical が検出されると `audit` ジョブが失敗し、merge ブロッカーになる。

### CI/dev deps audit（可視化のみ）

public repo の GitHub Actions では devDependencies も CI 上で実行されるため、CI サプライチェーンリスクとして別ステップで可視化する（`--omit=dev` なし、root・worker 両方）。

- 初期段階は `continue-on-error: true` で**可視化のみ**（ジョブを落とさない）。
- 運用が安定したら High/Critical のブロック化を検討する。

### CI install は `npm ci` を原則とする

CI の依存インストールは lockfile に厳密一致する `npm ci` を使う（`npm install` は lockfile を書き換え得るため CI では使わない）。root・worker とも lockfile（`package-lock.json`）を保持し、`npm ci` でインストールする。worker も lockfile + `npm ci` を原則とする。

---

## Dependabot 運用

`.github/dependabot.yml` で以下の 3 エコシステムを週次（月曜）監視する。

| エコシステム | ディレクトリ | PR 上限 | グループ |
|------------|------------|--------|--------|
| npm | `/` | 5 | `production` / `development` |
| npm | `/worker` | 5 | `production` / `development` |
| github-actions | `/` | 3 | `actions`（全体で 1 群） |

- major バージョンアップは自動 PR を生成しない（破壊的変更を伴うため手動確認）
- `github-actions` を含めることで SHA pin した action（後述）の更新を週次検出する。Dependabot は `uses:` 末尾のバージョンコメントを読んで SHA 差し替え PR を生成する
- security アップデートは優先して取り込む。通常の minor/patch は週次バッチで処理する
- **更新はパッケージ単位ではなくグループ単位の PR で届く。** パッケージ単位に分割された PR は、peer を完全一致でピンする依存群（`@tiptap/*` 等）を単独ではロック解決できない形で届けてしまう（単独マージすると `npm ci` が ERESOLVE で失敗する）。npm は本番／開発で影響範囲が異なるため `production` / `development` の 2 群に分け、区別を持たない `github-actions` は 1 群にまとめる
- グループ化しても Dependabot PR が CI の検証対象外である点は変わらない。マージ前の lint / test / build は取り込む側が実行する（判定手順の正本は [docs/ai/rules/ci-run.md](ai/rules/ci-run.md)）
- **`NPM_PIN`（値の管理は次節「外部参照の pin（Action / container image / 実行時取得 CLI）」を参照）と semgrep container image（`container.image` の tag+digest）は Dependabot の監視対象外**（`run:` 行・`container:` は追従しない）。定期的な棚卸し手順は現時点で未整備（週次 `weekly-maintenance` 相当の workflow は `docs/planning/ci-split-design.md` で提案止まり・未実装）。棚卸し候補は issue 候補として `docs/planning/issue-candidates.md` に記録済み。

---

## public repo 化前の GitHub Actions hardening 方針（issue #225）

novel-ide は将来 public repo 化する可能性があり、その場合 GitHub Actions が外部 PR から起動され得る。以下を方針とする。npm publish / Trusted Publishing / provenance / npm token 管理は**このプロジェクトでは対象外**（npm publish の予定がないため）。

public 化前の secret・非公開情報（小説本文・設計カード・AI レビュー本文）混入チェック手順は [docs/security/public-release-checklist.md](security/public-release-checklist.md) を正とする（issue #346）。

### workflow permissions の最小化

- ワークフローのトップレベルで `permissions: { contents: read }` をデフォルトにする。
- 追加権限が必要な job のみ、job 単位で明示的に昇格する（例: `secret-scan` は gitleaks の PR 注釈付与のため `pull-requests: read` を明示）。
- `contents: write` / `pull-requests: write` / `id-token: write` は必要性を PR で説明できる場合のみ許可する。

### 外部参照の pin（Action / container image / 実行時取得 CLI）

- **third-party action は full-length commit SHA pin 必須**（例: `gitleaks/gitleaks-action`）。
- 公式 action（`actions/checkout`, `actions/setup-node`）も SHA pin する。
- `uses:` 末尾にコメントで元のタグ/バージョンを残す。更新は Dependabot または手動で SHA を差し替える。
- `container: image:` で参照するコンテナイメージ（例: `semgrep/semgrep`）も tag＋digest で pin する（`image:<tag>@sha256:<digest>`。tag は版の自己記述と tag 剥離後の復旧手掛かり、digest が改竄検証を担う）。`latest` 等のタグ単独参照は禁止。Dependabot 対象外のため更新は手動（tag と digest を同時に差し替える）。
- tag と digest の一致は機械検証されない（更新時に registry で照合する。検査器は未導入＝[verification-gates.md](ai/rules/verification-gates.md)の寄せ先欠落）。
- job 内で `npm install -g npm@<range>` のようにグローバル npm を実行時取得する場合も exact version で pin する。**値の正本は workflow ごとに1箇所の env（`<TOOL>_PIN`。npm は ci.yml の `NPM_PIN`）に集約し、job/step env で上書きしない**。各 step は `:?` ガード付きで参照する（`npm@11` のような直書きは禁止）。Dependabot は `run:` 行/`env:` を追従しないため更新は手動。
- `NPM_PIN` の制約: 11 系（`scripts/agent/check-npm-pin-cooldown.js` の `NPM_PIN_ALLOWED_MAJORS` 定数。メジャーを跨いで更新するときはこの定数も同時に更新する）＋ root/worker 両方の `package.json` の `engines.npm` を満たす ＋ 公開後 `.npmrc` の `min-release-age` 日以上経過している（`min-release-age` 自体も `MIN_RELEASE_AGE_FLOOR_DAYS`〔7〕未満は config エラー。同一 PR で閾値を下げて cooldown をバイパスする経路を塞ぐ）＋ worker/.npmrc がファイルとして存在し `min-release-age` キーが root と一致している（round13 NF-3: ファイル不在自体も config エラー。キー欠落・コメントアウト・キー名違いも config エラー）。cooldown 判定に使う registry は常に公式（`https://registry.npmjs.org`）固定で、`.npmrc` の `registry=` が公式以外を指していれば config エラーにする（証拠源を repo 内容から独立させ、ミラー等への差し替えは人間判断に回す）。検証 step は `changes` job に1つだけ置く（npm を install する全 job は既に registry.npmjs.org 依存で、値は workflow に1つの静的リテラルのため root で1回検証すれば足りる。スクリプトは node ビルトインのみで npm ci を要しないため `changes` job の依存フリー方針を維持できる）。分類結果（code/deps/docs/bundle）が全 false（npm を install する job が1つも走らない差分）のときは検証 step 自体を skip する。`resolvePin` は ci.yml 内で `NPM_PIN:` キー（block style）が2箇所以上あれば config エラーにする（job/step env での shadow の可能性。検出範囲の限界は後述「NPM_PIN shadow 検出の限界」を参照）。

  ```yaml
  - uses: gitleaks/gitleaks-action@<full-sha>  # v3。更新は Dependabot/手動で SHA を差し替え。
  ```

  ```yaml
  # container image: tag + digest
  container:
    image: semgrep/semgrep:<tag>@sha256:<digest>  # 更新は tag と digest を同時に差し替え。

  # 実行時取得 CLI: workflow レベル env に集約（changes job に検証 step を1つだけ置く）
  env:
    NPM_PIN: "<exact version>"  # .npmrc の min-release-age 日以上・engines.npm を満たす版のみ（check-npm-pin-cooldown.js が機械検査）
  # ... changes job ...
  - run: node scripts/agent/check-npm-pin-cooldown.js
  # ... npm install -g を行う各 job ...
  - run: npm install -g "npm@${NPM_PIN:?NPM_PIN が未定義です}"
  ```

`min-release-age` は素の整数で書く（`.npmrc` の値。引用符・行末コメントは npm 自体は受理し得るが、`check-npm-pin-cooldown.js` のパーサは拒否する＝fail-closed。書式を誤ると cooldown 判定そのものが config エラーで止まる）。

#### NPM_PIN の更新手順

1. 候補版と公開日を確認する: `npm view npm time --json`
2. `NPM_PIN` を更新し、ローカルで検証する: `npm run check:npm-pin`（`NPM_PIN` 環境変数を設定していなければ ci.yml の committed 値を読んで検証する）。
3. **engines.npm を引き上げる場合**（NPM_PIN が現行の `engines.npm` 下限を満たさない等）: `package.json` と `worker/package.json` の両方の `engines.npm` を同時に編集する → `npm run check:npm-pin` で再検証する → cooldown が未達で失敗した場合は、直前に編集した `package.json` / `worker/package.json` の `engines.npm` 変更を revert し、`min-release-age` の経過を待つ（バイパス〔検証 step の一時無効化等〕は設けない）。待機中は `NPM_PIN` の編集も含めて commit せず（半端な状態を push すると cooldown ではなく engines 不整合として失敗し原因表示がずれる）、経過後は本 step 3 を最初から再実行する。

#### semgrep container image の更新手順（tag + digest 照合）

1. 新 tag の digest を registry API で取得する（token 取得 → manifest HEAD → `docker-content-digest`）。

   ```bash
   TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:semgrep/semgrep:pull" | jq -r .token)
   curl -sI \
     -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
     "https://registry-1.docker.io/v2/semgrep/semgrep/manifests/<new-tag>" \
     | grep -i docker-content-digest
   ```

2. `ci.yml` の `container.image` を tag と digest の**両方**同時に差し替える（片側だけの更新は禁止。tag だけ進めて digest が旧版のままだと実際に pull される image が変わらず、digest だけ進めて tag コメントが古いままだと更新履歴が追えなくなる）。
3. 差し替え後、手順1のコマンドを再実行し、取得した digest が `ci.yml` に書いた値と一致することを確認する。

#### pin できない残余

- semgrep が使うルールセット（`p/javascript` / `p/react` / `p/owasp-top-ten`）は `semgrep scan --config p/...` 実行時に semgrep registry から取得され、image と異なりバージョン pin する手段が無い。既知の残余リスクとして記録する（ルールセット自体の改竄・破壊的変更は semgrep 側の信頼に依存する）。

#### pin の失敗時

`check-npm-pin-cooldown.js`（`changes` job で実行）は失敗を3種別で返す。原因・確認・対処は本節を正本とし、スクリプト側のメッセージは種別と本節への導線のみを返す（逐語一致させない）。

| 失敗種別 | 原因 | 確認 | 対処 |
|---------|------|------|------|
| `transient` | registry 到達不能・5xx・429・タイムアウト | 一時的なネットワーク/registry 障害 | 再実行する。再発する場合は registry 側の状態を確認する |
| `value` | `NPM_PIN` の形式不正・許容メジャー範囲外（`NPM_PIN_ALLOWED_MAJORS`）・cooldown 未達・`engines.npm` 不整合・登録されていない版（404） | `NPM_PIN` の値そのものが不適切 | 「NPM_PIN の更新手順」に従って値を選び直す |
| `config` | `.npmrc` / `package.json`（root・worker）側の不備（`min-release-age` の欠落・重複・0以下・小数・`MIN_RELEASE_AGE_FLOOR_DAYS`未満・引用符/行末コメント付き、`engines.npm` の未対応 range、root/worker 間の `min-release-age` 不一致、worker/.npmrc の不在・キー欠落）、`.npmrc` の `registry=` が公式以外、ci.yml 内の `NPM_PIN:` キーが2箇所以上（job/step env での shadow）、registry からの想定外の 4xx | pin の値ではなくリポジトリ側の設定（.npmrc / package.json / ci.yml）が壊れている | 該当ファイル（`.npmrc` / `package.json` / `worker/.npmrc` / `worker/package.json` / `ci.yml`）を修正する（pin 値を変えても直らない） |

semgrep container image の digest を pull できない場合（tag が削除・再構築された等）は「semgrep container image の更新手順」に従って digest を取り直す。

#### NPM_PIN shadow 検出の限界

`resolvePin` の shadow 検出は `^\s*NPM_PIN:`（block style の `NPM_PIN:` 行）だけを見るベストエフォートで、YAML を解釈しない。そのため次は検出できない: flow style（`{NPM_PIN: "..."}` のような1行 mapping）、クォート付きキー（`"NPM_PIN":`）、`echo "NPM_PIN=..." >> "$GITHUB_ENV"` のような `$GITHUB_ENV` 経由の値注入。逆に `run:` のシェルスクリプト内に行頭が `NPM_PIN:`（YAML の mapping key と同じ見た目）の行を書くと、shadow ではないのに検出に引っかかり検証が config で止まる（偽陽性）。ci.yml の変更そのもの（この検出の回避を含む）を機械的に防ぐ手段は無いため、[REVIEW_GUIDELINES.md](REVIEW_GUIDELINES.md) の CI checklist（人間レビュー）が最終防御を担う。

### `pull_request_target` 原則禁止

- CI は `pull_request` を使う。`pull_request_target` は**原則として使用しない**。
- やむを得ず使用する場合は以下を守る。例外を作る場合は本ファイルまたは [REVIEW_GUIDELINES.md](REVIEW_GUIDELINES.md) に理由・制限・レビュー観点を記載する。
  - 外部 PR ブランチの checkout や任意コード実行をしない
  - Secrets を渡す job では外部 PR 由来のコードを実行しない

### OpenSSF Scorecard（判断結果）

- 現時点では**導入しない**。public repo 化と同時に導入を検討する（issue #275 で扱う）。
- それまでは Dependabot（pinned actions/deps の更新検出）+ 本方針の手動運用で代替する。
