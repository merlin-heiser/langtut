package de.langtut.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
  @Override public void onCreate(Bundle savedInstanceState) {
    registerPlugin(ProviderBridgePlugin.class);
    registerPlugin(GoogleDriveBridgePlugin.class);
    super.onCreate(savedInstanceState);
  }
}
