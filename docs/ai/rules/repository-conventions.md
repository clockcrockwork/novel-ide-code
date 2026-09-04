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
