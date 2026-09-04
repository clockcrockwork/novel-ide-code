# フロータイム仕様

## 位置づけ

フロータイムは、単なる「エディタを開いていた時間」ではなく、ユーザーが実際に執筆・校正・構成・差分確認などの創作作業に関与していたと推定できる作業セッションとして扱う。

MVP段階では必須機能に含めないが、ポモドーロタイマー、通常タイマー、進捗グラフ、作業時間分析、AIによる執筆リズム提案へ接続する基礎データとして、仕様方針を先に固定する。

> **MVP 段階での扱いは [docs/MVP_PLAN.md](MVP_PLAN.md) が正。** フロータイムは **MVP Alpha では実装しない**。**MVP Beta** で最小実装として扱う（[#243](https://github.com/clockcrockwork/novel-ide/issues/243)）。ポモドーロ正式対応は介入型タイマー + 通知 UX が必要なため **MVP Gamma**。詳細は本書末尾「[MVPでの扱い](#mvpでの扱い)」を参照。

## 基本方針

- フロータイムは編集対象ファイル単位で記録する。
- 作品単位・ファイル単位・ビュー種別単位で集計できるようにする。
- ポモドーロタイマーや通常タイマーとは別データとして保持する。
- ただし、同時に動作していたポモドーロ/通常タイマーとは関連IDで紐づけられるようにする。
- 将来的にAI分析へ渡すため、個別操作ログそのものではなく、集計済みサマリを生成できるようにする。
- 常時ポーリング主体ではなく、イベント駆動 + 低頻度の状態遷移判定で実装する。

## ビュー種別とフロー分類

フロータイムは「作業していたか」だけでなく、「どのビューで、何のために活動していたか」を持つ。

```ts
type FlowContext =
  | "writing"       // 執筆ビュー
  | "proofreading"  // プレビュー・校正ビュー
  | "structuring"   // 構成ビュー
  | "diff";         // 差分ビュー
```

### 執筆ビュー

本文入力・削除・貼り付け・ルビ入力・コメント付与など、本文そのものを編集する作業を中心に扱う。

- 入力・削除・貼り付け: `edit`
- カーソル移動・選択・スクロール: `read` または `thinking`
- ルビ、コメント、マーカー操作: `annotate`

### プレビュー・校正ビュー

プレビューでは、スクロールして読み返している時間も校正作業時間として扱う。単なる低価値なスクロールとして除外しない。

- スクロール・読解: `read`
- コメント・マーカー追加: `annotate`
- 校正候補の採用・修正: `applyProof`

### 構成ビュー

構成ビューでは、読んでから段落・章・見出しを入れ替える作業が自然に発生するため、スクロールや見出し選択も構成検討時間として扱う。

- スクロール・読解: `read`
- 見出し・段落選択: `navigate`
- 並び替え: `reorder`

### 差分ビュー

差分ビューでは、編集量だけで作業時間を判断しない。差分を読んで比較する時間自体を作業時間として扱う。

- 差分スクロール・比較: `compare`
- 差分選択: `compare`
- 採用・破棄・マージ: `edit`
- 処理済み差分数: `resolvedDiffCount`

## 活動種別

```ts
type ActivityKind =
  | "edit"
  | "read"
  | "navigate"
  | "reorder"
  | "annotate"
  | "applyProof"
  | "compare"
  | "thinking"
  | "idleCandidate";
```

イベント単体で価値を決めない。たとえば `scroll` は、執筆ビューでは読み返しや思考候補になり、プレビュー・校正ビューでは校正読解になり、構成ビューでは構成検討になり、差分ビューでは比較作業になる。

## セッション状態

```ts
type FlowSessionState =
  | "active"
  | "thinking"
  | "idle"
  | "background";
```

### active

入力・削除・貼り付け・並び替え・校正候補適用など、明確な操作が発生している状態。

### thinking

入力はないが、スクロール・選択・カーソル移動・差分閲覧など、作業継続とみなせる活動がある状態。

### idle

一定時間以上、操作がない状態。

### background

タブ非表示、pagehide、blur、freeze などにより、作業継続とみなせない状態。

## 時間判定の初期値

初期値は以下を目安にする。ユーザー設定で調整できる余地を残す。

```txt
0〜5分無操作:
  フロータイムに含める

5〜15分無操作:
  思考時間候補として扱う

15分以上無操作:
  放置として除外
```

小説執筆では、入力していない時間も作業である可能性が高い。そのため、無操作時間を即時除外しない。

## スマホ・タブレットでの扱い

スマホでは、PCと同じイベント解釈にしない。

### 基本方針

- `touchmove` の連続発火を直接集計しない。
- `touchstart` / `pointerdown` を主な活動開始イベントとして扱う。
- スクロールは throttle して扱う。
- VisualViewport resize や仮想キーボード開閉は活動扱いしない。
- `visibilitychange` / `pagehide` / `blur` / `freeze` を監視し、バックグラウンド化を検知する。
- iOS Safari のタブ凍結・復帰を考慮し、復帰時に経過時間を再評価する。

### スクロールの扱い

スマホでは慣性スクロールが発生するため、スクロールイベントの回数を活動量として使わない。

```txt
scroll event count を使わない
最後にスクロール活動があった時刻のみ更新する
```

### 仮想キーボードの扱い

仮想キーボード表示に伴う viewport resize は、作業活動ではなくUI環境変化として扱う。

```txt
viewport resize = activity にしない
keyboard open/close = activity にしない
```

ただし、キーボード表示中の入力・選択・貼り付けは通常通り活動として扱う。

## パフォーマンス方針

### ポーリング主体にしない

フロータイム計測は、常時高頻度ポーリングで実装しない。

避ける例:

```txt
100msごとに状態監視
mousemove/touchmoveを全件集計
scroll座標を常時計測
React stateに高頻度更新を流す
```

### 推奨実装

```txt
ユーザー操作イベント
  ↓
activity timestamp 更新
  ↓
10〜30秒間隔で状態遷移判定
  ↓
session buffer 更新
  ↓
一定間隔またはセッション終了時に IndexedDB へ flush
```

### 実装上の注意

- 高頻度イベントは debounce/throttle する。
- React state / Jotai 等のUI状態管理に細かい活動更新を流さない。
- module singleton、service class、または必要に応じて worker に分離する。
- UI表示は集計済み状態だけを購読する。

## データモデル案

```ts
type FlowSession = {
  id: string;

  workId: string;
  fileId: string;
  chapterId?: string;

  context: FlowContext;

  startedAt: string;
  endedAt: string;

  activeMs: number;
  thinkingMs: number;
  idleExcludedMs: number;

  pomodoroSessionId?: string;
  timerSessionId?: string;

  activityBreakdown: {
    editMs?: number;
    readMs?: number;
    navigateMs?: number;
    reorderMs?: number;
    annotateMs?: number;
    applyProofMs?: number;
    compareMs?: number;
  };

  metrics: {
    inputCharCount?: number;
    deletedCharCount?: number;
    netCharCount?: number;
    reorderCount?: number;
    annotationCount?: number;
    appliedProofCount?: number;
    resolvedDiffCount?: number;
  };

  source: "auto" | "pomodoro" | "timer" | "manual";
  status: "active" | "completed" | "discarded" | "edited";

  note?: string;

  createdAt: string;
  updatedAt: string;
};
```

## ポモドーロ・通常タイマーとの関係

ポモドーロタイマーや通常タイマーは、ユーザーが明示的に開始する時間管理である。フロータイムは、実際の活動から推定される作業時間である。

```txt
ポモドーロ時間 = 宣言した作業枠
フロータイム = 実際に作業していた推定時間
```

例:

```txt
25分ポモドーロ
  実フロー: 17分
  思考候補: 4分
  放置除外: 4分
  集中低下: 開始18分後付近
```

この比較により、将来的に以下のような提案が可能になる。

- 25分より18分集中 + 3分休憩の方が合いそう
- 校正時は30分でも集中が維持できる
- 構成作業は12〜15分で切れやすい
- 夜は入力効率が落ちるが、校正作業は続けやすい

## AI分析用サマリ

AIに共有する場合は、生ログではなく集計済みサマリを渡す。

```ts
type FlowTimeSummaryForAI = {
  period: {
    from: string;
    to: string;
  };

  byContext: {
    writingMs: number;
    proofreadingMs: number;
    structuringMs: number;
    diffMs: number;
  };

  pomodoroComparison: {
    plannedMs: number;
    actualFlowMs: number;
    matchRate: number;
    averageBreakPointMs: number;
    interruptionCount: number;
  };

  tendencies: {
    bestContext?: string;
    weakestContext?: string;
    averageFocusDurationMs: number;
    suggestedPomodoroWorkMs?: number;
    suggestedBreakMs?: number;
  };
};
```

## 将来の表示・活用

将来的には以下の表示を想定する。

- 作品別フロータイム
- ファイル別フロータイム
- ビュー種別別フロータイム
- 執筆/校正/構成/差分確認の比率
- ポモドーロ予定時間と実フロー時間の一致率
- 集中が切れやすい時間帯
- 作業種別ごとの得意/不得意傾向
- AIによるポモドーロ時間・休憩時間提案

## MVPでの扱い

MVP 段階定義の正は [docs/MVP_PLAN.md](MVP_PLAN.md)。本節はそれに従う（[#243](https://github.com/clockcrockwork/novel-ide/issues/243)）。

### MVP Alpha：実装しない

MVP Alpha ではフロータイムを実装対象に含めない。

ただし、以下は将来実装を阻害しないために考慮する（設計配慮のみで、計測機能そのものは作らない）。

- ファイルIDを安定して持つ。
- ビュー種別をアプリ状態として明確に管理する。
- ポモドーロ/通常タイマーのセッションIDを設計しておく。
- 進捗・作業時間グラフが、将来的にフロータイムを取り込める構造にする。

### MVP Beta：最小実装

本質は「ユーザー体験を損なわずに計測し、蓄積し、将来の可視化に使えるデータ形式として保持する」こと。

- 執筆中の集中の波を邪魔しない（低干渉な自動計測、または明示的な開始/終了）。
- WritingSession を保存し、文字数差分・対象ファイルを記録する。
- 将来の可視化・分析に使える形式（上記「データモデル案」`FlowSession`）で保存する。
- **保存先・同期方針の分離**：作業中（`active` / `paused`）は IndexedDB のみ、`completed` のみ Git 同期する方向で検討する。
- 通知は無操作確認など最低限に留める（通知レベル Level 1＝アプリ内通知。[MVP_PLAN.md「通知レベル」](MVP_PLAN.md#通知レベル241) / [#241](https://github.com/clockcrockwork/novel-ide/issues/241) と矛盾させない）。

### `FlowSession` と `WritingSession`・ポモドーロとの関係

- フロータイムは「実際の活動から推定される作業時間」、ポモドーロは「ユーザーが明示的に開始する宣言した作業枠」。両者は別物として扱い、関連 ID で紐づける（本書「ポモドーロ・通常タイマーとの関係」参照）。
- `FlowSession` と `WritingSession` を別データにするか、`mode: flow | pomodoro` で統合するかは Beta 実装時に決める。
- ポモドーロ正式対応（介入型タイマー + ブラウザ通知/通知音）は **MVP Gamma**。フロータイムより後の段階で整理する。
- ポモドーロとの比較・AI 提案・詳細グラフは後続フェーズへ送る。
