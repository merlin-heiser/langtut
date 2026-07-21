param(
  [switch]$Force,
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$repoNeedle = $repoRoot.ToLowerInvariant()

function Get-LangtutDevProcesses {
  $all = @(Get-CimInstance Win32_Process)
  $byId = @{}
  foreach ($process in $all) { $byId[[int]$process.ProcessId] = $process }

  $seeds = @($all | Where-Object {
    $command = [string]$_.CommandLine
    $lower = $command.ToLowerInvariant()
    $lower.Contains($repoNeedle) -and ($lower -match "[\\/]vite[\\/]bin[\\/]vite\.js" -or $lower -match "[\\/]tsx[\\/]dist[\\/]cli\.mjs.*watch\s+src/server\.ts")
  })

  $selected = [ordered]@{}
  foreach ($seed in $seeds) {
    $current = $seed
    while ($current) {
      $id = [int]$current.ProcessId
      $key = [string]$id
      if (-not $selected.Contains($key)) { $selected[$key] = $current }
      $parentId = [int]$current.ParentProcessId
      if (-not $byId.ContainsKey($parentId)) { break }
      $parent = $byId[$parentId]
      $parentCommand = [string]$parent.CommandLine
      if ($parentCommand -notmatch "(?i)(npm-cli\.js.*run\s+dev|concurrently|cmd\.exe.*(?:vite|tsx)|node(?:\.exe)?.*(?:vite|tsx))") { break }
      $current = $parent
    }
  }
  return @($selected.Values)
}

$existing = @(Get-LangtutDevProcesses)
if ($existing.Count -gt 0 -and -not $Force) {
  & node (Join-Path $repoRoot "scripts/restart-safety.mjs")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($CheckOnly) {
  Write-Host "Erkannte Langtut-Dev-Prozesse: $($existing.Count). Neustartschutz: $($(if ($Force) { 'übersprungen' } else { 'bestanden' }))."
  exit 0
}

if ($existing.Count -gt 0) {
  if ($Force) {
    Write-Host "Harter Neustart: Beende $($existing.Count) Langtut-Dev-Prozess(e), Schutzprüfung wurde bewusst übersprungen." -ForegroundColor Yellow
  } else {
    Write-Host "Sanfter Neustart: Beende die vorhandene Langtut-Instanz." -ForegroundColor Cyan
  }
  foreach ($process in $existing) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
  }

  $deadline = (Get-Date).AddSeconds(8)
  do {
    Start-Sleep -Milliseconds 200
    $remaining = @(Get-LangtutDevProcesses)
  } while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
  if ($remaining.Count -gt 0) {
    $ids = ($remaining | ForEach-Object ProcessId) -join ", "
    throw "Vorhandene Langtut-Prozesse konnten nicht vollständig beendet werden: $ids"
  }
} else {
  Write-Host "Keine laufende Langtut-Instanz gefunden; starte eine neue." -ForegroundColor Cyan
}

Set-Location -LiteralPath $repoRoot
Write-Host "Starte genau eine Langtut-Instanz. Beenden mit Ctrl+C." -ForegroundColor Green
& npm.cmd run dev
exit $LASTEXITCODE
