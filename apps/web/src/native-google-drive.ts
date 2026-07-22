type GoogleDrivePlugin = { signIn(): Promise<{ accessToken: string; email?: string }>; disconnect(): Promise<void> };
type CapacitorWindow = Window & { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: { GoogleDriveBridge?: GoogleDrivePlugin } } };
function plugin(): GoogleDrivePlugin {
  const result = (window as CapacitorWindow).Capacitor?.Plugins?.GoogleDriveBridge;
  if (!result) throw new Error("Google-Drive-Bridge ist in dieser Android-Version nicht verfügbar.");
  return result;
}
export const nativeGoogleDrive = {
  available: () => Boolean((window as CapacitorWindow).Capacitor?.isNativePlatform?.() && (window as CapacitorWindow).Capacitor?.Plugins?.GoogleDriveBridge),
  signIn: () => plugin().signIn(),
  disconnect: () => plugin().disconnect(),
};
