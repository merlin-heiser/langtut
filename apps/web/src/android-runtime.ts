import { createLocalLangtutClient, type LangtutClient, type RuntimeAnkiBridge, type RuntimePersistence, type RuntimeProviderBridge, type RuntimeState } from "@langtut/runtime";
import contractsSchema from "../../../specs/schemas/contracts.schema.json";
import modelTasksYaml from "../../../config/model_tasks.yaml?raw";
import modelPricingYaml from "../../../config/model_pricing.yaml?raw";
import packageYaml from "../../../learning-packages/slowakisch-deutsch/package.yaml?raw";
import curriculumYaml from "../../../learning-packages/slowakisch-deutsch/curriculum.yaml?raw";
import promptsYaml from "../../../learning-packages/slowakisch-deutsch/prompts.yaml?raw";
import activitiesYaml from "../../../learning-packages/slowakisch-deutsch/activities.yaml?raw";
import placementYaml from "../../../learning-packages/slowakisch-deutsch/placement.yaml?raw";

type NativePlugins = {
  ProviderBridge?: { status(): Promise<{ openai: boolean; gemini: boolean }>; setKey(options: { provider: "openai" | "gemini"; key: string }): Promise<void>; request(options: { provider: "openai" | "gemini"; url: string; body: string }): Promise<{ status: number; body: string }> };
  AnkiDroidBridge?: { metrics(options: { packageId: string }): Promise<any>; setupPreview(options: { packageId: string; deck: string }): Promise<any>; applySetup(options: { packageId: string; deck: string }): Promise<any>; addItems(options: { packageId: string; deck: string; items: unknown[] }): Promise<{ noteIds: Array<number | null> }>; syncModuleAvailability(options: { packageId: string; learningModuleIds: string[] }): Promise<void>; removeNotes(options: { noteIds: number[] }): Promise<void> };
};
type CapacitorWindow = Window & { Capacitor?: { Plugins?: NativePlugins } };

class IndexedDbPersistence implements RuntimePersistence {
  private db?: Promise<IDBDatabase>;
  private open() { return this.db ??= new Promise((resolve, reject) => { const request = indexedDB.open("langtut-runtime", 1); request.onupgradeneeded = () => request.result.createObjectStore("state"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
  async load() { const db = await this.open(); return new Promise<RuntimeState | undefined>((resolve, reject) => { const request = db.transaction("state").objectStore("state").get("current"); request.onsuccess = () => resolve(request.result as RuntimeState | undefined); request.onerror = () => reject(request.error); }); }
  async save(state: RuntimeState) { const db = await this.open(); await new Promise<void>((resolve, reject) => { const transaction = db.transaction("state", "readwrite"); transaction.objectStore("state").put(structuredClone(state), "current"); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); }); }
}

function plugins(): NativePlugins { return (window as CapacitorWindow).Capacitor?.Plugins ?? {}; }
const providers: RuntimeProviderBridge = {
  status: async () => { const bridge = plugins().ProviderBridge; if (!bridge) return { openai: false, gemini: false }; return bridge.status(); },
  setKey: async (provider, key) => { const bridge = plugins().ProviderBridge; if (!bridge) throw new Error("Provider-Bridge fehlt"); await bridge.setKey({ provider, key }); },
  request: async (provider, url, body) => { const bridge = plugins().ProviderBridge; if (!bridge) throw new Error("Provider-Bridge fehlt"); return bridge.request({ provider, url, body: JSON.stringify(body) }); },
};
const anki: RuntimeAnkiBridge = {
  metrics: async (packageId) => { const bridge = plugins().AnkiDroidBridge; if (!bridge) return { reachable: false, dueReviews: 0, newCards: 0, leeches: 0, lapses7d: 0, error: "AnkiDroid-Bridge fehlt" }; return bridge.metrics({ packageId }); },
  setupPreview: async (packageId, deck) => { const bridge = plugins().AnkiDroidBridge; if (!bridge) throw new Error("AnkiDroid-Bridge fehlt"); return bridge.setupPreview({ packageId, deck }); },
  applySetup: async (packageId, deck) => { const bridge = plugins().AnkiDroidBridge; if (!bridge) throw new Error("AnkiDroid-Bridge fehlt"); return bridge.applySetup({ packageId, deck }); },
  addItems: async (packageId, deck, items) => { const bridge = plugins().AnkiDroidBridge; if (!bridge) throw new Error("AnkiDroid-Bridge fehlt"); return (await bridge.addItems({ packageId, deck, items })).noteIds; },
  removeNotes: async (noteIds) => { const bridge = plugins().AnkiDroidBridge; if (!bridge) throw new Error("AnkiDroid-Bridge fehlt"); await bridge.removeNotes({ noteIds }); },
  syncModuleAvailability: async (packageId, learningModuleIds) => { const bridge = plugins().AnkiDroidBridge; if (!bridge) throw new Error("AnkiDroid-Bridge fehlt"); await bridge.syncModuleAvailability({ packageId, learningModuleIds }); },
};

export function createAndroidClient(): Promise<LangtutClient> {
  return createLocalLangtutClient({ builtInPackage: { package: packageYaml, curriculum: curriculumYaml, prompts: promptsYaml, activities: activitiesYaml, placement: placementYaml }, modelTasksYaml, modelPricingYaml, contractsSchema, persistence: new IndexedDbPersistence(), providers, anki });
}
