# 啟動本機伺服器（沒開才開）然後打開瀏覽器。
#
# 重複執行是安全的：已經在跑的就直接沿用，不會再開第二個 ——
# 兩個行程搶同一個埠，輸的那個會靜靜地死掉，反而更難查。
#
# 完全不需要 Python 或 Node，用的是 Windows 內建的 .NET HttpListener。

[CmdletBinding()]
param(
    [int]$Port = 5178,
    [switch]$NoBrowser,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$serve = Join-Path $PSScriptRoot 'serve.ps1'

function Say($msg) { if (-not $Quiet) { Write-Host $msg } }

# 是不是我們自己的伺服器在這個埠上？（別的程式剛好佔用時不能亂踢）
function Test-Ours([int]$p) {
    try {
        $r = Invoke-RestMethod "http://localhost:$p/_health" -TimeoutSec 2
        return ($r.app -eq 'sitelog')
    } catch { return $false }
}

function Test-Busy([int]$p) {
    $null -ne (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

# 專案可能放在網路磁碟機上，開機自動執行時未必已經掛好
for ($i = 0; $i -lt 15 -and -not (Test-Path -LiteralPath $root); $i++) { Start-Sleep -Seconds 2 }
if (-not (Test-Path -LiteralPath $root)) {
    Say "找不到程式資料夾：$root"
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'index.html'))) {
    Say "這個資料夾裡沒有 index.html，請確認 tools 資料夾沒有被單獨搬走。"
    exit 1
}

# 找一個可用的埠：本來就是我們的 → 直接用；被別人佔住 → 往後找
$chosen = 0
foreach ($p in $Port..($Port + 10)) {
    if (Test-Busy $p) {
        if (Test-Ours $p) { $chosen = $p; Say "伺服器已在執行中（埠 $p）。"; break }
        continue
    }
    $chosen = $p
    Say "啟動本機伺服器（埠 $p）…"
    Start-Process -FilePath 'powershell' `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
                      '-File', "`"$serve`"", '-Port', $p `
        -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(30)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 400
        if (Test-Ours $p) { $ready = $true; break }
    }
    if (-not $ready) { $chosen = 0 }
    break
}

if ($chosen -gt 0) {
    $url = "http://localhost:$chosen/"
    if (-not $NoBrowser) { Say "開啟 $url"; Start-Process $url }
    exit 0
}

# 伺服器起不來（例如公司政策擋掉 PowerShell 或監聽）時，
# 直接用 file:// 開 —— 功能全部照常，只是部分瀏覽器會擋掉自動存檔，
# 這時介面左下角會提醒要自己「匯出紀錄檔」。
Say "無法啟動本機伺服器，改用直接開啟檔案的方式。"
Say "（自動存檔可能會被瀏覽器擋掉，請記得按「匯出紀錄檔」保存）"
if (-not $NoBrowser) { Start-Process (Join-Path $root 'index.html') }
exit 0
