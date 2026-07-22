param([switch]$StartApi)
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serial = $env:LANGTUT_ADB_SERIAL

function Get-AdbDevices {
  @(adb devices -l | Select-Object -Skip 1 | Where-Object { $_ -match '\s+device\s+' } | ForEach-Object {
    $parts = $_ -split '\s+'
    [pscustomobject]@{
      Serial = $parts[0]
      Model = (($parts | Where-Object { $_ -like 'model:*' }) -replace '^model:', '').Replace('_', ' ')
    }
  })
}

$devices = @(Get-AdbDevices)
if ($serial) {
  $device = $devices | Where-Object Serial -eq $serial | Select-Object -First 1
  if (-not $device) { throw "LANGTUT_ADB_SERIAL '$serial' ist nicht als bereitstehendes ADB-Gerät verbunden." }
} else {
  $pixelDevices = @($devices | Where-Object { $_.Model -eq 'Pixel 7' })
  if ($pixelDevices.Count -eq 0) {
    throw "Kein angeschlossenes Pixel 7 gefunden. ADB-Geräte: $($devices.Serial -join ', ')"
  }

  # USB/Wi-Fi bzw. mDNS können dasselbe Telefon mehrfach auflisten. Gruppiere
  # solche Verbindungen über die unveränderliche Android-Seriennummer.
  $physicalDevices = @(
    $pixelDevices |
      ForEach-Object {
        $physicalSerial = (adb -s $_.Serial shell getprop ro.serialno).Trim()
        [pscustomobject]@{ Connection = $_; PhysicalSerial = $physicalSerial }
      } |
      Group-Object PhysicalSerial |
      ForEach-Object { $_.Group[0].Connection }
  )
  if ($physicalDevices.Count -gt 1) {
    $choices = $physicalDevices | ForEach-Object { "$($_.Serial) ($($_.Model))" }
    throw "Mehrere Pixel-7-ADB-Verbindungen gefunden. Setze LANGTUT_ADB_SERIAL auf eine davon: $($choices -join '; ')"
  }
  $device = $physicalDevices[0]
  $serial = $device.Serial
}

Write-Host "Deploy auf $($device.Model) [$serial]" -ForegroundColor Cyan
$env:LANGTUT_ADB_SERIAL = $serial
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

Push-Location $repoRoot
try {
  if ($StartApi) { Write-Warning '-StartApi ist nicht mehr erforderlich; Android führt die Langtut-Runtime lokal aus.' }

  & npm.cmd run android:sync
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $localAssets = 'C:\tmp\langtut-android-assets'
  if (Test-Path -LiteralPath $localAssets) {
    Remove-Item -LiteralPath $localAssets -Recurse -Force
  }
  New-Item -ItemType Directory -Path $localAssets | Out-Null
  Copy-Item -Path (Join-Path $repoRoot 'android/app/src/main/assets/*') -Destination $localAssets -Recurse -Force

  Push-Location (Join-Path $repoRoot 'android')
  try {
    $gradleAssets = $localAssets.Replace('\', '/')
    & .\gradlew.bat clean assembleDebug --no-daemon --console=plain "-PlangtutAssetsDir=$gradleAssets"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    Pop-Location
  }

  $apkCandidates = @(
    (Join-Path $repoRoot 'android/app/build/outputs/apk/debug/app-debug.apk'),
    'C:\tmp\android-studio-builds\android\app\outputs\apk\debug\app-debug.apk'
  ) | Where-Object { Test-Path -LiteralPath $_ }
  $apk = $apkCandidates | Select-Object -First 1
  if (-not $apk) { throw 'Debug-APK wurde nach dem erfolgreichen Gradle-Build nicht gefunden.' }

  & adb -s $serial install -r $apk
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  & adb -s $serial shell monkey -p de.langtut.app 1
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
