package de.langtut.app;

import android.accounts.Account;
import android.accounts.AccountManager;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.UserRecoverableAuthException;
import android.content.Intent;
import android.content.SharedPreferences;
import java.security.MessageDigest;

/** Android system-browser/account-picker OAuth for Langtut's private Drive app-data scope. */
@CapacitorPlugin(name = "GoogleDriveBridge")
public class GoogleDriveBridgePlugin extends Plugin {
  private static final String DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
  private volatile Account pendingAccount;
  private volatile String currentToken;
  private SharedPreferences preferences() { return getContext().getSharedPreferences("langtut-google-drive", android.content.Context.MODE_PRIVATE); }
  @PluginMethod public void signIn(PluginCall call) {
    String savedAccount = preferences().getString("account_name", null);
    if (savedAccount != null && !savedAccount.isBlank()) { fetchDriveToken(call, new Account(savedAccount, "com.google")); return; }
    Intent intent = AccountManager.get(getContext()).newChooseAccountIntent(
      null, null, new String[] { "com.google" }, null, null, null, null);
    startActivityForResult(call, intent, "receiveGoogleAccount");
  }
  @ActivityCallback private void receiveGoogleAccount(PluginCall call, ActivityResult result) {
    if (call == null) return;
    String accountName = result.getData() == null ? null : result.getData().getStringExtra(AccountManager.KEY_ACCOUNT_NAME);
    if (accountName == null || accountName.isBlank()) { call.reject("Google account unavailable"); return; }
    fetchDriveToken(call, new Account(accountName, "com.google"));
  }
  private void fetchDriveToken(PluginCall call, Account account) {
    pendingAccount = account;
    new Thread(() -> {
      try {
        String token = GoogleAuthUtil.getToken(getContext(), account, "oauth2:" + DRIVE_APPDATA_SCOPE);
        currentToken = token;
        preferences().edit().putString("account_name", account.name).apply();
        JSObject response = new JSObject(); response.put("accessToken", token); response.put("email", account.name); call.resolve(response);
      } catch (UserRecoverableAuthException recoverable) {
        getActivity().runOnUiThread(() -> startActivityForResult(call, recoverable.getIntent(), "receiveGoogleRecovery"));
      } catch (Exception error) { call.reject(actionableAuthError(error), error); }
    }).start();
  }
  @ActivityCallback private void receiveGoogleRecovery(PluginCall call, ActivityResult result) {
    if (call == null || pendingAccount == null) return;
    if (result.getResultCode() != android.app.Activity.RESULT_OK) { call.reject("Google authorization was cancelled"); return; }
    fetchDriveToken(call, pendingAccount);
  }
  @PluginMethod public void disconnect(PluginCall call) {
    String token = currentToken; currentToken = null; pendingAccount = null;
    preferences().edit().remove("account_name").apply();
    if (token == null) { call.resolve(); return; }
    new Thread(() -> { try { GoogleAuthUtil.clearToken(getContext(), token); call.resolve(); } catch (Exception error) { call.reject(error.getMessage(), error); } }).start();
  }

  private String actionableAuthError(Exception error) {
    String message = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    if (!message.contains("UnregisteredOnApiConsole")) return message;
    return "Google OAuth kennt diesen Android-Build nicht. Lege im verwendeten Google-Cloud-Projekt einen OAuth-Client vom Typ Android an: Paket "
      + getContext().getPackageName() + ", SHA-1 " + signingSha1()
      + ". Aktiviere außerdem die Google Drive API und verwende dasselbe Projekt wie für den OAuth-Zustimmungsbildschirm.";
  }

  private String signingSha1() {
    try {
      PackageManager manager = getContext().getPackageManager();
      Signature[] signatures;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        PackageInfo info = manager.getPackageInfo(getContext().getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
        signatures = info.signingInfo == null ? new Signature[0] : info.signingInfo.getApkContentsSigners();
      } else {
        @SuppressWarnings("deprecation") PackageInfo info = manager.getPackageInfo(getContext().getPackageName(), PackageManager.GET_SIGNATURES);
        signatures = info.signatures;
      }
      if (signatures == null || signatures.length == 0) return "unbekannt";
      byte[] digest = MessageDigest.getInstance("SHA-1").digest(signatures[0].toByteArray());
      StringBuilder value = new StringBuilder();
      for (byte part : digest) { if (value.length() > 0) value.append(':'); value.append(String.format("%02X", part)); }
      return value.toString();
    } catch (Exception ignored) { return "unbekannt (mit gradlew signingReport ermitteln)"; }
  }
}
