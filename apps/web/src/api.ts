import type { LangtutClient } from "@langtut/runtime";

const nativeBundle = import.meta.env.VITE_LANGTUT_NATIVE === "true";
let selected: Promise<LangtutClient> | undefined;
const selectedClient = () => selected ??= nativeBundle
  ? import("./android-runtime.js").then(({ createAndroidClient }) => createAndroidClient())
  : import("./http-client.js").then(({ httpClient }) => httpClient);

export const client = new Proxy({} as LangtutClient, {
  get: (_target, property: keyof LangtutClient) => (...args: unknown[]) => selectedClient().then((value) => (value[property] as (...values: unknown[]) => unknown).apply(value, args)),
});
