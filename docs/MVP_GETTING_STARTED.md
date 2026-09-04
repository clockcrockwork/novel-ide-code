# MVP Alpha 開始ガイド / 操作メモ

> MVP Alpha 本線の確認・実装・レビューで迷わないための操作メモ。
> **MVP 段階定義の正は [docs/MVP_PLAN.md](MVP_PLAN.md)（[#237](https://github.com/clockcrockwork/novel-ide/issues/237)）。** 本書はその利用者向け導線。

## MVP Alpha の目的

MVP Alpha は **ローカルファースト執筆基盤**である。

- **ローカルファースト**：本文の一次保存先は IndexedDB。ネットワークがなくても書ける・保存できる・復元できる。
- **GitHub 主導同期による複数環境テスト**：PC・スマートフォン・別ブラウザなど複数環境で同じテストデータを扱うため、GitHub リポジトリ経由の最低限の手動 Push/Pull を前提に含める。
- **GitHub 未接続は退避モード**：未接続・認証失敗・同期失敗でも、本文を書き始められる安全弁を保証する。これは主導線ではなく、本文喪失・作業不能を避けるためのもの。

> MVP Alpha は「ローカル保存だけで完結する検証」ではない。Local-only を主導線として扱わないこと。

## 初回起動の流れ

1. 空の作品を作る。
2. チャプターを作る。
3. 本文を書き始める。

サンプルデータを使う場合は、**サンプル依存のテストにしない**こと（E2E はサンプルデータに依存しない：[#221](https://github.com/clockcrockwork/novel-ide/issues/221)）。サンプルは動作確認用であり、本線の保証対象ではない。

## 保存の考え方

- **IndexedDB が一次保存**。本文・作品・チャプターはまず IndexedDB に保存される。
- **保存状態表示の見方**：保存中 / 保存済み / 保存失敗 のステータスを確認する（通知ではなくデータ保護の常時表示＝ Level 0。[docs/MVP_PLAN.md の通知レベル](MVP_PLAN.md#通知レベル241)）。
- **リロード後の復元確認**：リロードして本文が復元されることを確認する。

## GitHub 同期の考え方

- **GitHub 接続状態**：接続済み / 未接続 が分かる表示を確認する。
- **手動 Push/Pull**：最低限の手動同期で、複数環境間でテストデータを揃える。
- **同期ステータス**：同期待ち / 同期中 / 同期完了（最終同期時刻）と、失敗時の種別表示を確認する。
  失敗は原因ごとにラベルが変わる（再同期が必要 / 再ログインが必要 / 権限・制限エラー /
  同期データエラー / 同期を中止 / 同期データ破損 / 時間をおいて再試行 / 通信エラー /
  サイズ超過 / 同期失敗 / アプリの更新が必要）。この一覧は `SyncBadge.jsx` の `ERROR_LABEL` と一致していること
  （`SyncBadge.test.jsx` が機械検査する）。
  ラベルと判定入力の対応は [docs/data-model/sync-contract.md](data-model/sync-contract.md) §6。
  最終同期時刻は **snapshot が成立した回だけ**更新される（失敗が残る回は進まない）。
- **GitHub 同期失敗時の退避手順**：同期が失敗しても、本文編集・IndexedDB 保存・退避出力は影響を受けない。失敗時は下記の退避モードへ移れる。

token の取り扱い・Worker の責務は [docs/MVP_PLAN.md の GitHub 同期・Cloudflare Worker 最小責務](MVP_PLAN.md#github-同期cloudflare-worker-最小責務237240) と [docs/ENVIRONMENT.md](ENVIRONMENT.md) を参照。

## GitHub 未接続時の退避モード

- **未接続でも本文を書ける**：GitHub にログインしていなくても通常起動し、作品作成・本文編集・IndexedDB 保存・復元ができる。
- **TXT / Markdown / JSON 退避出力を使う**：
  - 現在チャプターの TXT 出力
  - 現在チャプターの Markdown 出力
  - 作品単位の Markdown 結合出力
  - 全データ JSON バックアップ出力 / JSON からの復元
  - （詳細: [#216](https://github.com/clockcrockwork/novel-ide/issues/216) / 復旧導線: [#219](https://github.com/clockcrockwork/novel-ide/issues/219)）
- **後から GitHub 接続へ戻る**：未接続で書き始めた後に GitHub 接続して同期導線へ復帰できる（[#218](https://github.com/clockcrockwork/novel-ide/issues/218)）。

## モバイル / PWA での確認観点

[docs/MVP_PLAN.md の PWA・モバイル・IME 保証範囲](MVP_PLAN.md#pwaモバイルime-保証範囲239) と矛盾しない範囲で確認する。

- **iOS Safari**：本文入力・保存・復元ができる。白画面・操作不能にならない。
- **IME**：composition（変換確定前）中に writingRules や decoration が過剰干渉しない。
- **仮想キーボード**：表示時にエディタ・footer・ツールバーが致命的に崩れない。
- **オフライン時の扱い**：オフラインでも開いて編集できる（最小キャッシュ方針の範囲）。

## MVP Alpha ではやらないこと

AI エージェント・レビュアーは、以下を Alpha に混ぜないこと（[docs/MVP_PLAN.md の AI エージェントへのガード](MVP_PLAN.md#ai-エージェントへのガード最重要)）。

- 辞書生成
- ローカル校正
- 外部 API 校正
- LLM 校正
- フロータイム実装
- ポモドーロ正式対応
- ブラウザ通知 / 通知音 / Web Push
- Discord / Notion / SNS 連携
- 高度なグラフ分析
