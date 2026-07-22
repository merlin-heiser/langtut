type NativePlugin = { setKey(options: { provider: "openai" | "gemini"; key: string }): Promise<void>; clearKey(options: { provider: "openai" | "gemini" }): Promise<void>; request(options: { provider: "openai" | "gemini"; url: string; body: string }): Promise<{ status: number; body: string }> };
type CapacitorWindow = Window & { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: { ProviderBridge?: NativePlugin } } };

function bridge(): NativePlugin {
  const plugin = (window as CapacitorWindow).Capacitor?.Plugins?.ProviderBridge;
  if (!plugin) throw new Error("Native Provider-Bridge ist in dieser Laufzeit nicht verfügbar.");
  return plugin;
}
export const nativeProvider = {
  available: () => Boolean((window as CapacitorWindow).Capacitor?.isNativePlatform?.() && (window as CapacitorWindow).Capacitor?.Plugins?.ProviderBridge),
  setKey: (provider: "openai" | "gemini", key: string) => bridge().setKey({ provider, key }),
  clearKey: (provider: "openai" | "gemini") => bridge().clearKey({ provider }),
  request: (provider: "openai" | "gemini", url: string, body: unknown) => bridge().request({ provider, url, body: JSON.stringify(body) }),
};
