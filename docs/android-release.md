# Android release

Langtut packages the React client with Capacitor. The Fastify API remains a separately
hosted HTTPS service: it owns SQLite/data, provider keys, and any Anki Desktop link.
Never put provider or Anki keys into `VITE_*` variables; those values are compiled into
the Android application.

This is the current delivery state, not the target architecture. The target and the
shared-first platform boundary are defined in `specs/architecture/system.md`; Android
must not be described as autonomous until its local runtime is delivered.

For a hosted API, set `LANGTUT_CORS_ORIGINS=https://localhost` (and any web origin you
intentionally support). `https://localhost` is the Capacitor Android WebView origin.
The current API is a single-user local backend and has no end-user authentication; add
authentication and user-isolated persistence before exposing it publicly.

## Prerequisites

- Node.js 24 and Android Studio with a current Android SDK
- A deployed HTTPS API with CORS restricted to the app origins
- A unique Android signing key kept outside this repository

## Build a debug APK

In PowerShell, configure the API URL for the current terminal, then sync Capacitor and
build:

```powershell
$env:VITE_API_BASE_URL = "https://api.example.com/api/v1"
npm run android:debug
```

The APK is produced at `android/app/build/outputs/apk/debug/app-debug.apk`.

## Install a local-development APK on a USB-connected phone

Start the API on the development computer in one terminal:

```powershell
npm --prefix apps/api run dev
```

Then use a second terminal to build the debug app against that local API, install it,
and launch it:

```powershell
npm run android:debug:local
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p de.langtut.app 1
```

Für den kompletten lokalen Build-, Installations- und Startvorgang auf einem
angeschlossenen Pixel 7 genügt:

```powershell
make androidapp
```

`make androidapp` benötigt für Build und Installation keine laufende API. Die
installierte Debug-App verwendet für ihre Lernfunktionen weiterhin die lokale API.
Wenn diese ebenfalls automatisch gestartet werden soll, verwende:

```powershell
make androidapp-run
```

Bei mehreren ADB-Verbindungen zum selben oder zu mehreren Pixel-7-Geräten kann
das Ziel mit `LANGTUT_ADB_SERIAL` eindeutig gewählt werden.

If the same phone is visible over USB and Wi-Fi, set `LANGTUT_ADB_SERIAL` to the desired
value from `adb devices -l` before running the script.

The script configures `adb reverse tcp:3210 tcp:3210`, so `localhost` inside the phone
is forwarded to the API running on the computer. HTTP is enabled only in the debug
variant; regular Android builds continue to require HTTPS.

## Google Drive OAuth import

In Settings, choose the Google OAuth JSON file under **OAuth-JSON importieren** on
Windows or Android. Langtut reads `installed.client_id` (or `web.client_id`) and, when
present, stores the client secret only in the local API configuration for the desktop
token exchange. It is never synced, logged, or bundled into the Android application.
Android uses the native Google account picker/token flow and therefore does not require
an Android OAuth client for this local debug path.

## Build a Play Store bundle

Copy `android/keystore.properties.example` to `android/keystore.properties`, replace its
values with a real release keystore (both are kept untracked), then run:

```powershell
$env:VITE_API_BASE_URL = "https://api.example.com/api/v1"
npm run android:release
```

Before uploading, set the final application ID/version in Android Studio, provide
adaptive launcher and store icons, test on physical devices, and complete the Play
Console data-safety/privacy declarations. The desktop-only AnkiConnect flow is not
available on Android; use a dedicated AnkiDroid integration or disable that feature in
the mobile product.
