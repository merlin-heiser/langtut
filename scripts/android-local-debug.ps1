$ErrorActionPreference = 'Stop'
$env:VITE_API_BASE_URL = 'http://localhost:3210/api/v1'
$env:LANGTUT_ALLOW_HTTP_API = 'true'
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
$adbArgs = if ($env:LANGTUT_ADB_SERIAL) { @('-s', $env:LANGTUT_ADB_SERIAL) } else { @() }

& adb @adbArgs reverse tcp:3210 tcp:3210
npm run android:sync
Push-Location android
try { .\gradlew.bat assembleDebug --no-daemon --console=plain }
finally { Pop-Location }
