package de.langtut.app;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Native HTTP bridge: provider keys stay in Android app storage and never enter the web bundle or Drive events. */
@CapacitorPlugin(name = "ProviderBridge")
public class ProviderBridgePlugin extends Plugin {
  private SharedPreferences preferences() {
    try {
      MasterKey key = new MasterKey.Builder(getContext()).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
      return EncryptedSharedPreferences.create(getContext(), "langtut-provider-keys", key, EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    } catch (Exception error) { throw new IllegalStateException("Secure provider storage unavailable", error); }
  }
  @PluginMethod public void status(PluginCall call) {
    JSObject result = new JSObject(); result.put("openai", preferences().contains("openai")); result.put("gemini", preferences().contains("gemini")); call.resolve(result);
  }
  @PluginMethod public void setKey(PluginCall call) {
    String provider = call.getString("provider"); String key = call.getString("key");
    if (!"openai".equals(provider) && !"gemini".equals(provider)) { call.reject("Unsupported provider"); return; }
    if (key == null || key.trim().isEmpty()) { call.reject("API key required"); return; }
    preferences().edit().putString(provider, key.trim()).apply(); call.resolve();
  }
  @PluginMethod public void clearKey(PluginCall call) {
    String provider = call.getString("provider"); preferences().edit().remove(provider).apply(); call.resolve();
  }
  @PluginMethod public void request(PluginCall call) {
    String provider = call.getString("provider"); String url = call.getString("url"); String body = call.getString("body", "{}");
    String key = preferences().getString(provider, null);
    if (key == null) { call.reject("No API key configured for " + provider); return; }
    if (!allowed(provider, url)) { call.reject("Provider URL is not allowed"); return; }
    new Thread(() -> {
      try {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setConnectTimeout(30000); connection.setReadTimeout(90000);
        connection.setRequestProperty("Content-Type", "application/json");
        if ("openai".equals(provider)) connection.setRequestProperty("Authorization", "Bearer " + key);
        else connection.setRequestProperty("x-goog-api-key", key);
        try (OutputStream output = connection.getOutputStream()) { output.write(body.getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
        int status = connection.getResponseCode(); BufferedReader input = new BufferedReader(new InputStreamReader(status < 400 ? connection.getInputStream() : connection.getErrorStream()));
        StringBuilder response = new StringBuilder(); String line; while ((line = input.readLine()) != null) response.append(line); input.close();
        JSObject result = new JSObject(); result.put("status", status); result.put("body", response.toString());
        if (status >= 200 && status < 300) call.resolve(result); else call.reject("Provider HTTP " + status, "provider_http_error", result);
      } catch (Exception error) { call.reject(error.getMessage(), error); }
    }).start();
  }
  private boolean allowed(String provider, String url) {
    return ("openai".equals(provider) && url != null && url.startsWith("https://api.openai.com/")) ||
      ("gemini".equals(provider) && url != null && url.startsWith("https://generativelanguage.googleapis.com/"));
  }
}
