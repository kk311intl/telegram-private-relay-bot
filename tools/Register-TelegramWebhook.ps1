#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^https://')]
    [string]$WorkerUrl
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$savedSecretPath = Join-Path $projectRoot 'private-credentials/telegram-webhook-secret.dpapi'
$resolvedWorkerUrl = [Uri]$WorkerUrl
if ($resolvedWorkerUrl.Scheme -ne 'https' -or -not $resolvedWorkerUrl.Host -or
    $resolvedWorkerUrl.UserInfo -or $resolvedWorkerUrl.Query -or $resolvedWorkerUrl.Fragment -or
    $resolvedWorkerUrl.AbsolutePath -ne '/') {
    throw 'WorkerUrl 必須是沒有路徑、帳密、查詢參數或片段的 HTTPS 網站根網址。'
}
if (-not (Test-Path -LiteralPath $savedSecretPath)) {
    throw '找不到本機保存的 WEBHOOK_SECRET。先執行 tools/New-WebhookSecret.ps1。'
}
$botTokenSecure = Read-Host '輸入 Telegram Bot Token（不會顯示）' -AsSecureString
$webhookSecretSecure = ConvertTo-SecureString ((Get-Content -Raw -LiteralPath $savedSecretPath).Trim())
$botCredential = [PSCredential]::new('telegram', $botTokenSecure)
$secretCredential = [PSCredential]::new('webhook', $webhookSecretSecure)

try {
    $botToken = $botCredential.GetNetworkCredential().Password
    $webhookSecret = $secretCredential.GetNetworkCredential().Password
    $uri = "https://api.telegram.org/bot$botToken/setWebhook"
    $body = @{
        url = "$($resolvedWorkerUrl.AbsoluteUri.TrimEnd('/'))/webhook"
        secret_token = $webhookSecret
        allowed_updates = @('message', 'edited_message')
        drop_pending_updates = $false
        max_connections = 10
    } | ConvertTo-Json -Depth 4
    try {
        $result = Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json' -Body $body
    } catch {
        throw 'Telegram Webhook 註冊請求失敗；為避免洩漏 Bot Token，已隱藏原始 URI。'
    }
    if (-not $result.ok) { throw 'Telegram 拒絕註冊 Webhook。' }
    Write-Host 'Webhook 註冊完成。'
} finally {
    $botToken = $null
    $webhookSecret = $null
    $botCredential = $null
    $secretCredential = $null
}
