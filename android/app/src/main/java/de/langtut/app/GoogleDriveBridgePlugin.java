package de.langtut.app;

import android.accounts.Account;
import android.accounts.AccountManager;
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

/** Android system-browser/account-picker OAuth for Langtut's private Drive app-data scope. */
@CapacitorPlugin(name = "GoogleDriveBridge")
public class GoogleDriveBridgePlugin extends Plugin {
  private static final String DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
  @PluginMethod public void signIn(PluginCall call) {
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
    new Thread(() -> {
      try {
        String token = GoogleAuthUtil.getToken(getContext(), account, "oauth2:" + DRIVE_APPDATA_SCOPE);
        JSObject response = new JSObject(); response.put("accessToken", token); response.put("email", account.name); call.resolve(response);
      } catch (UserRecoverableAuthException recoverable) {
        call.reject("Google authorization needs user confirmation", "google_auth_recovery_required");
      } catch (Exception error) { call.reject(error.getMessage(), error); }
    }).start();
  }
  @PluginMethod public void disconnect(PluginCall call) { call.resolve(); }
}
