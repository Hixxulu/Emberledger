# Dev-only static file server (the deployed app is just static files on GitHub Pages).
param([int]$Port = 8321)

$root = Split-Path -Parent $PSScriptRoot
$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".ico"  = "image/x-icon"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$Port/"

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
  if ($path -eq "/") { $path = "/index.html" }
  $file = Join-Path $root ($path -replace "/", "\")
  $fullRoot = (Resolve-Path $root).Path
  try {
    $fullFile = (Resolve-Path $file -ErrorAction Stop).Path
  } catch { $fullFile = $null }
  if ($fullFile -and $fullFile.StartsWith($fullRoot) -and (Test-Path $fullFile -PathType Leaf)) {
    $ext = [System.IO.Path]::GetExtension($fullFile).ToLower()
    $type = $mime[$ext]; if (-not $type) { $type = "application/octet-stream" }
    $bytes = [System.IO.File]::ReadAllBytes($fullFile)
    $ctx.Response.ContentType = $type
    $ctx.Response.Headers.Add("Cache-Control", "no-cache")
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $ctx.Response.StatusCode = 404
    $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
    $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
  }
  $ctx.Response.Close()
}
