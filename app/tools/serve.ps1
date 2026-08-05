# 圖說紀錄產生器 —— 本機靜態檔案伺服器
#
# 這支程式只做一件事：把上層資料夾裡的檔案，透過 http://localhost:<Port>/ 發出去。
# 不上傳、不連外、不寫入任何檔案。之所以需要它，是因為部分瀏覽器在 file://
# 底下會擋掉 IndexedDB，自動存檔就會失效；改用 http://localhost 就一切正常。
#
# 由 tools\start.ps1 在背景叫起來，一般不需要自己執行。

[CmdletBinding()]
param(
    [int]$Port = 5178
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.gif'  = 'image/gif'
    '.webp' = 'image/webp'
    '.ico'  = 'image/x-icon'
    '.pdf'  = 'application/pdf'
    '.txt'  = 'text/plain; charset=utf-8'
    '.md'   = 'text/plain; charset=utf-8'
    '.woff' = 'font/woff'
    '.woff2'= 'font/woff2'
    '.pptx' = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()

while ($listener.IsListening) {
    try { $ctx = $listener.GetContext() } catch { break }
    $req = $ctx.Request
    $res = $ctx.Response
    try {
        $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)

        # start.ps1 用這個確認「佔用這個埠的確實是我們自己」，而不是別的程式
        if ($rel -eq '/_health') {
            $body = [System.Text.Encoding]::UTF8.GetBytes('{"ok":true,"app":"sitelog"}')
            $res.ContentType = 'application/json'
            $res.ContentLength64 = $body.Length
            $res.OutputStream.Write($body, 0, $body.Length)
            $res.Close()
            continue
        }
        # 關閉用：收到就結束迴圈，讓行程自己退出
        if ($rel -eq '/_quit') {
            $body = [System.Text.Encoding]::UTF8.GetBytes('bye')
            $res.ContentLength64 = $body.Length
            $res.OutputStream.Write($body, 0, $body.Length)
            $res.Close()
            break
        }

        if ($rel -eq '/' -or $rel -eq '') { $rel = '/index.html' }
        $path = Join-Path $Root ($rel.TrimStart('/').Replace('/', '\'))
        $full = [System.IO.Path]::GetFullPath($path)

        # 路徑逃逸防護：只發送 Root 底下的檔案
        if (-not $full.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
            $res.StatusCode = 403; $res.Close(); continue
        }
        if (Test-Path -LiteralPath $full -PathType Container) {
            $full = Join-Path $full 'index.html'
        }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            $res.StatusCode = 404
            $body = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
            $res.OutputStream.Write($body, 0, $body.Length)
            $res.Close(); continue
        }

        $ext = [System.IO.Path]::GetExtension($full).ToLower()
        $ct = $mime[$ext]
        if (-not $ct) { $ct = 'application/octet-stream' }
        $bytes = [System.IO.File]::ReadAllBytes($full)
        $res.ContentType = $ct
        $res.ContentLength64 = $bytes.Length
        $res.Headers.Add('Cache-Control', 'no-cache')
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
        $res.Close()
    } catch {
        try { $res.StatusCode = 500; $res.Close() } catch {}
    }
}

try { $listener.Stop(); $listener.Close() } catch {}
