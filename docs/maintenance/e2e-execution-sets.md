# E2E execution sets

> Issue #431 の実行集合の正本。性能最適化（workers / sharding / browser cache）は #358 で実測して決める。

## 集合

| 集合 | 意味 | 実行 |
|---|---|---|
| `@smoke` | 起動・主要UI・基本操作の最小集合 | `npm run test:e2e:smoke` |
| `@editor-critical` | Tiptap本文・保存・復元・入力経路など、MVP Alpha の執筆継続性を守る集合 | `npm run test:e2e:editor-critical` |
| `@heavy` | 大量データ・長時間ケース | `npm run test:e2e:heavy` |
| `@perf` | 性能計測・閾値依存 | `npm run test:e2e:perf` |
| `@ime` | 専用のIME composition挙動 | `npm run test:e2e:ime` |
| `all-only` | smoke/editor-criticalへ無理に含めない拡張回帰。full実行またはpath指定で実行 | `npm run test:e2e:all` / path指定 |

`all-only` は「未分類」ではない。全 spec の判断は `e2e/classification.json` に列挙し、
`node scripts/check-e2e-classification.js` が tracked spec と runtime tag の一致を fail-closed で検査する。

## 互換用 `test:e2e`

既存の path 指定（例: `npm run test:e2e -- e2e/mobile/`）を壊さないため、
`test:e2e` は smoke の別名にはしない。standard non-special suite として

```text
playwright test --grep-invert "@heavy|@perf|@ime"
```

を実行する。これにより既存の通常回帰は維持しつつ、従来 `@perf` 単独だった
`e2e/performance/preview-perf.spec.js` が通常 `test:e2e` へ混入する穴を閉じる。

## overlap policy

- `@smoke` は単独分類。heavy / perf / IME / editor-critical と重複させない。
- `@editor-critical` も単独分類。通常PRへ載せる条件を独立に測れるようにする。
- `@heavy + @perf`、`@heavy + @ime` は許可する。
- tagless spec は禁止ではないが、必ず manifest で `all-only` と明示する。

## current classification

### smoke

- `e2e/core/file-ops.spec.js`
- `e2e/core/mode-switch.spec.js`
- `e2e/editor/settings-modal.spec.js`

### editor-critical

- `e2e/core/github-disconnected.spec.js`
- `e2e/core/write-persist.spec.js`
- `e2e/editor/find-replace.spec.js`
- `e2e/editor/inline-comment.spec.js`
- `e2e/mobile/new-paragraph-button.spec.js`
- `e2e/security/clipboard-paste.spec.js`

### special

- `e2e/editor/input-latency.spec.js`: `@heavy + @perf`
- `e2e/ime/composition.spec.js`: `@heavy + @ime`
- `e2e/performance/preview-perf.spec.js`: `@perf`

残り13 specは `all-only`。一覧の機械正本は manifest を参照する。

## CI policy

分類PRではE2Eをrequiredへ追加しない。次段の #358 で public runner 上の
browser install時間、各集合のwall clock、flake、project別コストを測り、
smokeを非required観測へ載せるか、editor-criticalをどの条件で実行するかを決める。
