# Pulls a dated JSON snapshot of the whole characters collection from
# Firestore into this folder. Safe to run any time; keeps the newest 60.
# Convert to the app's plain shape with convert-backup.ps1 if needed.
param([string]$OutDir = $PSScriptRoot)

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$url = 'https://firestore.googleapis.com/v1/projects/emberledger/databases/(default)/documents/characters?key=AIzaSyCmU-kTNMbEEm1Q6d5cr6bYxYfKbLbohPU&pageSize=300'
$out = Join-Path $OutDir "firestore-characters-$stamp.json"

curl.exe -s $url -o $out
if (-not (Test-Path $out)) { Write-Error "Download failed"; exit 1 }

try {
  $json = Get-Content $out -Raw | ConvertFrom-Json
  $count = @($json.documents).Count
} catch { $count = 0 }

if ($count -lt 1) {
  Remove-Item $out -Force
  Write-Error "Backup looked empty or malformed - not kept."
  exit 1
}
Write-Host "Backed up $count documents to $out"

# prune: keep the newest 60 pulls
Get-ChildItem (Join-Path $OutDir 'firestore-characters-*.json') |
  Where-Object { $_.Name -notlike '*.plain.json' } |
  Sort-Object Name -Descending | Select-Object -Skip 60 |
  Remove-Item -Force
