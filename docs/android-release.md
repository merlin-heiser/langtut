# Android standalone release

Langtut bundles the React UI and the shared TypeScript learning runtime in the
Capacitor application. Android does not connect to Fastify or another Langtut backend.
Its only network peers are the explicitly configured LLM providers and Google Drive;
cards and review data remain in AnkiDroid.

## Prerequisites

- Node.js 24 and Android Studio with Android SDK 36
- AnkiDroid installed on the target device with collection access granted
- OpenAI and/or Gemini keys entered inside Langtut settings
- A Google account when Drive synchronization is wanted
- A signing key outside this repository for release builds

Provider keys are encrypted with an Android-Keystore-backed preference store. Google
tokens are acquired natively and passed only transiently to the in-process runtime.
Neither is written to IndexedDB, the web bundle, logs or Drive events.

## Google OAuth registration

Native Drive authorization requires an OAuth 2.0 client of type **Android** in the
same Google Cloud project as the consent screen. Enable the Google Drive API and
register:

- package name: `de.langtut.app`
- SHA-1: the fingerprint of the certificate that signed the installed APK/AAB

For the local debug keystore, print the current fingerprint with:

```powershell
cd android
.\gradlew.bat signingReport
```

Release and Play-App-Signing certificates have different fingerprints and each needs
its own Android OAuth client. `UnregisteredOnApiConsole` means the package/fingerprint
pair of the installed build is missing from that project. If the consent screen is in
testing mode, add the Google account as a test user as well.

## Build and install

`VITE_API_BASE_URL` must be unset; the build fails when it is present.

```powershell
Remove-Item Env:VITE_API_BASE_URL -ErrorAction SilentlyContinue
npm run android:debug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

For a connected Pixel 7, `make androidapp` builds, installs and launches the same
standalone artifact. No API process or `adb reverse` rule is required.

For a signed bundle, configure the ignored `android/keystore.properties` and run:

```powershell
npm run android:release
```

## Upgrade from API-backed builds

Before upgrading, run Drive synchronization once in the previously configured runtime
if it contains changes that exist nowhere else. The standalone app creates its local
IndexedDB snapshot and rebuilds shared state from Drive. Provider keys must be entered
again because credentials are intentionally never migrated through Drive.
