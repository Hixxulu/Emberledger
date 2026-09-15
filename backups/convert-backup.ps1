# Converts a Firestore REST-format backup (typed values) into the app's plain
# character JSON shape, which can be restored by writing each entry back with
# setDoc. Usage: .\convert-backup.ps1 -In firestore-characters-YYYY-MM-DD.json
param([Parameter(Mandatory=$true)][string]$In)

function Convert-Value($v) {
  if ($null -ne $v.stringValue) { return $v.stringValue }
  if ($null -ne $v.integerValue) { return [long]$v.integerValue }
  if ($null -ne $v.doubleValue) { return [double]$v.doubleValue }
  if ($null -ne $v.booleanValue) { return [bool]$v.booleanValue }
  if ($null -ne $v.nullValue) { return $null }
  if ($null -ne $v.mapValue) {
    $o = [ordered]@{}
    if ($v.mapValue.fields) {
      foreach ($p in $v.mapValue.fields.PSObject.Properties) { $o[$p.Name] = Convert-Value $p.Value }
    }
    return $o
  }
  if ($null -ne $v.arrayValue) {
    $arr = @()
    if ($v.arrayValue.values) { foreach ($item in $v.arrayValue.values) { $arr += ,(Convert-Value $item) } }
    return $arr
  }
  return $null
}

$raw = Get-Content (Join-Path $PSScriptRoot $In) -Raw | ConvertFrom-Json
$plain = [ordered]@{}
foreach ($doc in $raw.documents) {
  $slug = $doc.name.Split('/')[-1]
  $o = [ordered]@{}
  foreach ($p in $doc.fields.PSObject.Properties) { $o[$p.Name] = Convert-Value $p.Value }
  $plain[$slug] = $o
}
$outPath = (Join-Path $PSScriptRoot ($In -replace '\.json$', '.plain.json'))
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($outPath, (ConvertTo-Json $plain -Depth 12), $utf8)
Write-Host "wrote $outPath"
