#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][uri]$WorkerUrl,
    [string]$DatabaseBinding = 'BOT_DB',
    [string]$Config = 'wrangler.jsonc'
)

$ErrorActionPreference = 'Stop'
if ($WorkerUrl.Scheme -ne 'https' -or -not $WorkerUrl.Host -or
    $WorkerUrl.UserInfo -or $WorkerUrl.Query -or $WorkerUrl.Fragment -or $WorkerUrl.AbsolutePath -ne '/') {
    throw 'WorkerUrl 必須是沒有路徑、帳密、查詢參數或片段的 HTTPS 網站根網址。'
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$secretFile = Join-Path $projectRoot 'private-credentials/telegram-webhook-secret.dpapi'
$cloudflareInvoker = Join-Path $PSScriptRoot 'Invoke-WithCloudflareToken.ps1'

if (-not (Test-Path -LiteralPath $secretFile)) {
    throw '找不到本機保存的 WEBHOOK_SECRET。先執行 tools/New-WebhookSecret.ps1。'
}
if (-not (Test-Path -LiteralPath $cloudflareInvoker)) {
    throw '找不到 tools/Invoke-WithCloudflareToken.ps1。'
}

function Invoke-ProbeRequest {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][uri]$Uri,
        [hashtable]$Headers = @{},
        [AllowEmptyString()][string]$Body = '',
        [Parameter(Mandatory)][int]$ExpectedStatus
    )

    $parameters = @{
        Method = $Method
        Uri = $Uri
        Headers = $Headers
        SkipHttpErrorCheck = $true
        MaximumRedirection = 0
    }
    if ($Method -ne 'GET') {
        $parameters.ContentType = 'application/json'
        $parameters.Body = $Body
    }

    $response = Invoke-WebRequest @parameters
    if ([int]$response.StatusCode -ne $ExpectedStatus) {
        throw "$Name 失敗：預期 HTTP $ExpectedStatus，實際為 $([int]$response.StatusCode)。"
    }
    [pscustomobject]@{ Test = $Name; Status = [int]$response.StatusCode; Passed = $true }
    return $response
}

$secureSecret = ConvertTo-SecureString ((Get-Content -Raw -LiteralPath $secretFile).Trim())
$credential = [PSCredential]::new('webhook', $secureSecret)
$plainSecret = $credential.GetNetworkCredential().Password
$probeUpdateId = [System.Security.Cryptography.RandomNumberGenerator]::GetInt32(1500000000, 2000000000)
$webhookUri = [uri]::new($WorkerUrl, '/webhook')
$probeWasWritten = $false

try {
    Invoke-ProbeRequest -Name 'health' -Method GET -Uri ([uri]::new($WorkerUrl, '/health')) -ExpectedStatus 200 | Out-Null
    Invoke-ProbeRequest -Name 'ready' -Method GET -Uri ([uri]::new($WorkerUrl, '/ready')) -ExpectedStatus 200 | Out-Null

    $invalidHeaders = @{ 'X-Telegram-Bot-Api-Secret-Token' = "invalid-$([guid]::NewGuid().ToString('N'))" }
    Invoke-ProbeRequest -Name 'wrong webhook secret' -Method POST -Uri $webhookUri -Headers $invalidHeaders -Body '{}' -ExpectedStatus 403 | Out-Null

    $validHeaders = @{ 'X-Telegram-Bot-Api-Secret-Token' = $plainSecret }
    Invoke-ProbeRequest -Name 'invalid JSON' -Method POST -Uri $webhookUri -Headers $validHeaders -Body '{' -ExpectedStatus 400 | Out-Null
    Invoke-ProbeRequest -Name 'oversized body' -Method POST -Uri $webhookUri -Headers $validHeaders -Body ('x' * 1048577) -ExpectedStatus 413 | Out-Null

    # 頻道更新會被 Worker 安全忽略，不會向 Telegram 使用者或管理群組傳送訊息。
    $probeBody = @{
        update_id = $probeUpdateId
        channel_post = @{
            message_id = 1
            chat = @{ id = -1; type = 'channel' }
            text = 'runtime-probe'
        }
    } | ConvertTo-Json -Compress -Depth 5
    Invoke-ProbeRequest -Name 'authorized webhook' -Method POST -Uri $webhookUri -Headers $validHeaders -Body $probeBody -ExpectedStatus 200 | Out-Null
    $probeWasWritten = $true
    Invoke-ProbeRequest -Name 'duplicate webhook' -Method POST -Uri $webhookUri -Headers $validHeaders -Body $probeBody -ExpectedStatus 200 | Out-Null

    Write-Host '正式環境探針全部通過：health、ready、Secret 邊界、JSON/大小限制、授權請求與去重。'
} finally {
    try {
        if ($probeWasWritten) {
            $deleteSql = "DELETE FROM processed_updates WHERE update_id = $probeUpdateId;"
            try {
                Push-Location $projectRoot
                try {
                    & $cloudflareInvoker d1 execute $DatabaseBinding --remote --config $Config --command $deleteSql | Out-Null
                } finally {
                    Pop-Location
                }
            } catch {
                throw "探針資料清理失敗；請人工刪除 processed_updates 的 update_id=$probeUpdateId。原始錯誤：$($_.Exception.Message)"
            }
            Write-Host "已清除本次正式環境探針紀錄（update_id=$probeUpdateId）。"
        }
    } finally {
        $plainSecret = $null
        $credential = $null
        $secureSecret = $null
    }
}
