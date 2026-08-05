# 關掉本機伺服器。找不到也算成功 —— 本來就沒開，目的一樣達成。
#
# 只會關掉「回應 /_health 而且自稱 sitelog」的那個行程，
# 不會誤殺剛好佔用同一個埠的其他程式。

[CmdletBinding()]
param(
    [int]$Port = 5178,
    [switch]$Quiet
)

$ErrorActionPreference = 'SilentlyContinue'
function Say($msg) { if (-not $Quiet) { Write-Host $msg } }

$stopped = 0
foreach ($p in $Port..($Port + 10)) {
    $ours = $false
    try { $ours = ((Invoke-RestMethod "http://localhost:$p/_health" -TimeoutSec 2).app -eq 'sitelog') } catch {}
    if (-not $ours) { continue }

    # 先請它自己收工，這樣連線才會乾淨關閉
    try { Invoke-RestMethod "http://localhost:$p/_quit" -TimeoutSec 2 | Out-Null } catch {}
    Start-Sleep -Milliseconds 600

    # 還在的話（例如卡在等待下一個連線）就直接結束那個行程。
    # 不能用連接埠反查 PID —— HttpListener 走 HTTP.SYS，
    # 查出來的擁有者是 System(4)，踢不動也不該踢。改用命令列比對。
    $still = $false
    try { $still = ((Invoke-RestMethod "http://localhost:$p/_health" -TimeoutSec 2).app -eq 'sitelog') } catch {}
    if ($still) {
        Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
            Where-Object { $_.CommandLine -like "*serve.ps1*" -and $_.CommandLine -like "*$p*" } |
            ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
    }
    $stopped++
    Say "已關閉伺服器（埠 $p）。"
}

if (-not $stopped) { Say "伺服器沒有在執行。" }
