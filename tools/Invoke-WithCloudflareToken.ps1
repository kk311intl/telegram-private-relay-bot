#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory, ValueFromRemainingArguments)]
    [string[]]$WranglerArguments
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$tokenFile = Join-Path $projectRoot 'private-credentials/cloudflare-token.dpapi'
if (-not (Test-Path -LiteralPath $tokenFile)) {
    throw '尚未保存 Cloudflare Token。先執行 tools/Save-CloudflareToken.ps1。'
}

$secureToken = ConvertTo-SecureString ((Get-Content -Raw -LiteralPath $tokenFile).Trim())
$credential = [PSCredential]::new('cloudflare', $secureToken)
$plainToken = $credential.GetNetworkCredential().Password
$oldToken = [Environment]::GetEnvironmentVariable('CLOUDFLARE_API_TOKEN', 'Process')
try {
    [Environment]::SetEnvironmentVariable('CLOUDFLARE_API_TOKEN', $plainToken, 'Process')
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        throw '找不到 Node.js。請先安裝 Node.js 22 以上版本。'
    }
    $wrangler = Join-Path $projectRoot 'node_modules/.bin/wrangler.cmd'
    if (-not (Test-Path -LiteralPath $wrangler)) {
        throw '找不到 Wrangler。請先在工程目錄執行 pnpm install。'
    }
    Push-Location $projectRoot
    try {
        & $wrangler @WranglerArguments
        if ($LASTEXITCODE -ne 0) { throw "Wrangler 結束代碼：$LASTEXITCODE" }
    } finally {
        Pop-Location
    }
} finally {
    [Environment]::SetEnvironmentVariable('CLOUDFLARE_API_TOKEN', $oldToken, 'Process')
    $plainToken = $null
    $credential = $null
    $secureToken = $null
}
