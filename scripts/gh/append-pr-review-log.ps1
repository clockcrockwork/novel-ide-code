# append-pr-review-log.ps1 -PrNumber <PR番号> [-CommitHash <ハッシュ>]
# docs/pr/PR-{番号}.md に新しいラウンドセクション（ヘッダー + テーブル骨格）を末尾追記する。
# ファイルが存在しない場合は docs/pr/TEMPLATE.md から新規作成する。
#
# 使用例:
#   pwsh scripts/gh/append-pr-review-log.ps1 -PrNumber 207
#   pwsh scripts/gh/append-pr-review-log.ps1 -PrNumber 207 -CommitHash abc1234

param(
    [Parameter(Mandatory)][int]$PrNumber,
    [string]$CommitHash = ""
)

$repoRoot = git rev-parse --show-toplevel
$logDir   = Join-Path $repoRoot "docs/pr"
$logFile  = Join-Path $logDir "PR-$PrNumber.md"
$template = Join-Path $logDir "TEMPLATE.md"

# コミットハッシュ: 引数省略時は HEAD の短縮ハッシュ
if (-not $CommitHash) {
    $CommitHash = git rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -ne 0) { $CommitHash = "(コミット後に記入)" }
}

$today = Get-Date -Format "yyyy-MM-dd"

# 新規作成: TEMPLATE.md をコピーして PR タイトルを埋め込む
if (-not (Test-Path $logFile)) {
    if (-not (Test-Path $template)) {
        Write-Error "テンプレートファイルが見つかりません: $template"
        exit 1
    }
    $repo     = gh repo view --json nameWithOwner -q .nameWithOwner 2>$null
    $prTitle  = gh pr view $PrNumber --repo $repo --json title -q .title 2>$null
    if (-not $prTitle) { $prTitle = "(PR タイトルをここに記入)" }

    $content = Get-Content $template -Raw
    $content = $content -replace '\{番号\}', $PrNumber
    $content = $content -replace '\{PRタイトル\}', $prTitle
    $content = $content -replace '\{関連issue番号\}', "(関連 issue 番号)"
    Set-Content -Path $logFile -Value $content.TrimEnd() -Encoding UTF8
    Write-Host "新規作成: $logFile"
}

# 追記するセクション
$section = @"


### $today | commit: ``$CommitHash``

| # | レビュアー | コメント要旨 | 判断 | 理由 | 対応内容 |
|---|-----------|------------|------|------|---------|
| 1 | ...       | ...        | ❓   | [要入力] | [要入力] |
"@

Add-Content -Path $logFile -Value $section -Encoding UTF8
Write-Host "追記完了: $logFile"
Write-Host "  セクション: ### $today | commit: ``$CommitHash``"
Write-Host ""
Write-Host "次のステップ: テーブル行を編集してトリアージを記録してください。"
