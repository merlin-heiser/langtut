$ErrorActionPreference = 'Stop'
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
$adbArgs = if ($env:LANGTUT_ADB_SERIAL) { @('-s', $env:LANGTUT_ADB_SERIAL) } else { @() }

npm run android:sync
Push-Location android
try { .\gradlew.bat assembleDebug --no-daemon --console=plain }
finally { Pop-Location }
