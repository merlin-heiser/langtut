package de.langtut.app;

import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.UserRecoverableAuthException;
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;
import com.google.android.gms.tasks.Task;

/** Android system-browser/account-picker OAuth for Langtut's private Drive app-data scope. */
@CapacitorPlugin(name = "GoogleDriveBridge")
public class GoogleDriveBridgePlugin extends Plugin {
  private static final String DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
  private GoogleSignInClient client() {
    GoogleSignInOptions options = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
      .requestEmail().requestScopes(new Scope(DRIVE_APPDATA_SCOPE)).build();
    return GoogleSignIn.getClient(getActivity(), options);
  }
  @PluginMethod public void signIn(PluginCall call) { startActivityForResult(call, client().getSignInIntent(), "receiveGoogleSignIn"); }
  @ActivityCallback private void receiveGoogleSignIn(PluginCall call, ActivityResult result) {
    if (call == null) return;
    try {
      Task<GoogleSignInAccount> task = GoogleSignIn.getSignedInAccountFromIntent(result.getData());
      GoogleSignInAccount account = task.getResult(ApiException.class);
      if (account == null || account.getAccount() == null) { call.reject("Google account unavailable"); return; }
      new Thread(() -> {
        try {
          String token = GoogleAuthUtil.getToken(getContext(), account.getAccount(), "oauth2:" + DRIVE_APPDATA_SCOPE);
          JSObject response = new JSObject(); response.put("accessToken", token); response.put("email", account.getEmail()); call.resolve(response);
        } catch (UserRecoverableAuthException recoverable) {
          call.reject("Google authorization needs user confirmation", "google_auth_recovery_required");
        } catch (Exception error) { call.reject(error.getMessage(), error); }
      }).start();
    } catch (ApiException error) { call.reject("Google sign-in failed: " + error.getStatusCode(), error); }
  }
  @PluginMethod public void disconnect(PluginCall call) { client().signOut().addOnCompleteListener(task -> call.resolve()); }
}
