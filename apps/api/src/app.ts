import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { LearnerProfile, LexiconLookupRequest, LexiconStagingRequest, PlacementEvaluation, SessionAnalysis, TutorReport, TutorTurn } from "@langtut/contracts";
import {
  DEFAULT_PACKAGE_ID, LearningPackageRepository, applyProgress, createSessionPlan, deriveModuleStatus,
  nextAvailableModule, preparationComplete, recomputeLocks, renderPackagePrompt, evaluateExercise, type LearningActivity, type LoadedLearningPackage,
  type PlacementItemDefinition,
} from "@langtut/domain";
import { AnkiClient, type AnkiGateway } from "./anki.js";
import { loadConfig } from "./config.js";
import { ContentPipeline } from "./content-pipeline.js";
import { Store } from "./database.js";
import { GoogleDriveSync } from "./drive-sync.js";
import { LexiconService } from "./lexicon.js";
import { LocalMtClient, type LocalMtGateway } from "./local-mt.js";
import { newPlacement, placementShouldComplete, recommendation, scoreAnswer } from "./placement.js";
import { ModelRouter, modelChoices, type ModelGateway } from "./providers.js";
import { aggregateErrorTags, aggregateLearningSignals, buildLearnerContext, readRapport, transcriptFromEvents, writeRapportAtomic } from "./rapport.js";
import { emptyTutorTurn, normalizeTutorTurn, rolesAfterLearner, rolesBeforeLearner } from "@langtut/runtime";
export { normalizeTutorTurn, rolesAfterLearner, rolesBeforeLearner } from "@langtut/runtime";

type PlacementState = ReturnType<typeof newPlacement> & { packageId: string; answers: Array<{ itemId: string; correct: boolean }>; recommendedModuleId?: string };
type ActivityTurn = { roleId: string; roleLabel: string; turn: TutorTurn };
type ActivityOutcome = { turns: ActivityTurn[]; shouldComplete: boolean };

export async function buildApp(root = process.cwd(), overrides: { models?: ModelGateway; anki?: AnkiGateway; localMt?: LocalMtGateway } = {}) {
  const config = await loadConfig(root);
  const store = await Store.open(config.dbPath, root);
  const refreshGoogleToken = async () => {
    const refreshToken = store.getSetting<string>("google_drive.refresh_token");
    const clientId = store.getSetting<string>("google_drive.oauth_client_id") ?? config.googleOAuthClientId;
    const clientSecret = store.getSetting<string>("google_drive.oauth_client_secret") ?? config.googleOAuthClientSecret;
    if (!refreshToken || !clientId) return undefined;
    const form = new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, grant_type: "refresh_token" });
    if (clientSecret) form.set("client_secret", clientSecret);
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    const token = await response.json() as { access_token?: string };
    if (!response.ok || !token.access_token) return undefined;
    store.setSetting("google_drive.access_token", token.access_token);
    store.deleteSetting("google_drive.last_error");
    return token.access_token;
  };
  const driveSync = new GoogleDriveSync(store, refreshGoogleToken);
  // Jobs run in-process. After a restart there is no worker that can resume them,
  // so leaving them running would permanently block a new preparation.
  store.failInterruptedJobs();
  const packages = new LearningPackageRepository(root);
  await packages.loadAll();
  let activePackageId = store.getSetting<string>("packages.active") ?? DEFAULT_PACKAGE_ID;
  if (!packages.get(activePackageId)) activePackageId = DEFAULT_PACKAGE_ID;
  store.setSetting("packages.active", activePackageId);
  const models = overrides.models ?? await ModelRouter.load(root, config.modelTasksPath, (event) => store.recordApiUsage(event));
  const savedModelSelection = store.getSetting<{ openai: string; gemini: string }>("models.selection");
  if (savedModelSelection && models instanceof ModelRouter) models.setModelSelection(savedModelSelection);
  if (models instanceof ModelRouter) for (const provider of ["openai", "gemini"] as const) {
    const key = store.getSetting<string>(`provider.${provider}.api_key`); if (key) models.configure(provider, key);
  }
  const anki = overrides.anki ?? new AnkiClient(config.anki.url, config.anki.deck, config.anki.key);
  const dataRoot = path.dirname(config.dbPath);
  const localMtSettings = store.getSetting<{ enabled: boolean; cloudFallback: boolean }>("local_mt.settings") ?? { enabled: false, cloudFallback: true };
  const localMt = overrides.localMt ?? await LocalMtClient.load(root, dataRoot, store, localMtSettings);

  function active(): LoadedLearningPackage {
    const pkg = packages.require(activePackageId);
    anki.configurePackage?.(pkg.manifest.id, pkg.manifest.ankiDeck ?? `Langtut::${pkg.manifest.name}`);
    return pkg;
  }
  active();
  const savedAnkiKey = store.getSetting<string>("anki.connect_api_key");
  if (savedAnkiKey && anki instanceof AnkiClient) {
    anki.configureKey(savedAnkiKey);
    const keyedStatus = await anki.metrics();
    if (!keyedStatus.reachable && /valid api key/i.test(keyedStatus.error ?? "")) {
      anki.configureKey(undefined);
      const keylessStatus = await anki.metrics();
      if (keylessStatus.reachable) store.deleteSetting("anki.connect_api_key"); else anki.configureKey(savedAnkiKey);
    }
  }

  const app = Fastify({ logger: true });
  const allowedOrigins = process.env.LANGTUT_CORS_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean);
  await app.register(cors, { origin: allowedOrigins?.length ? allowedOrigins : true });
  await app.register(multipart, { limits: { files: 1, fileSize: 50 * 1024 * 1024 } });

  async function refreshCurriculum() {
    const pkg = active();
    const base = applyProgress(pkg.curriculum, store.getProgress(pkg.manifest.id));
    const progress = recomputeLocks(base, store.getProgress(pkg.manifest.id));
    for (const module of base.modules) store.setStatus(pkg.manifest.id, module.id, progress[module.id]);
    await anki.syncModuleAvailability?.(pkg.manifest.id, Object.entries(progress).filter(([, status]) => status === "learning").map(([moduleId]) => moduleId)).catch(() => undefined);
    return applyProgress(pkg.curriculum, progress);
  }
  function pipeline() { return new ContentPipeline(store, anki, models, active(), path.join(path.dirname(config.dbPath), "diagnostics", `${activePackageId}.jsonl`), localMt); }
  function lexicon() { return new LexiconService(store, models, active(), localMt); }
  function packageList() { return packages.list(activePackageId).map((pkg) => { const progress = store.getProgress(pkg.id); return { ...pkg, progress: { started: Object.values(progress).filter((status) => ["preparing", "learning", "credited"].includes(status)).length, completed: Object.values(progress).filter((status) => ["learning", "credited"].includes(status)).length, total: pkg.modules } }; }); }

  await refreshCurriculum();
  app.addHook("onClose", async () => { await localMt.close?.(); store.close(); });

  app.get("/api/v1/packages", async () => ({ activePackageId, packages: packageList() }));
  app.get<{ Params: { id: string } }>("/api/v1/packages/:id", async (request, reply) => {
    const pkg = packages.get(request.params.id);
    if (!pkg) return reply.code(404).send({ error: "unknown_package" });
    return { ...packageList().find(({ id }) => id === pkg.manifest.id), activities: pkg.activities };
  });
  app.post("/api/v1/packages/import", async (request, reply) => {
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: "zip_file_required" });
    const temp = path.join(path.dirname(config.dbPath), `.package-${randomUUID()}.zip`);
    try {
      await writeFile(temp, await upload.toBuffer());
      const pkg = await packages.importZip(temp);
      return reply.code(201).send({ ...pkg.manifest, modules: pkg.curriculum.modules.length, capabilities: pkg.capabilities });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    } finally { await rm(temp, { force: true }); }
  });
  app.post<{ Params: { id: string } }>("/api/v1/packages/:id/activate", async (request, reply) => {
    if (!packages.get(request.params.id)) return reply.code(404).send({ error: "unknown_package" });
    if (request.params.id !== activePackageId && store.hasActiveWork(activePackageId)) return reply.code(409).send({ error: "active_package_has_running_work" });
    activePackageId = request.params.id;
    store.setSetting("packages.active", activePackageId);
    active(); await refreshCurriculum();
    return { activePackageId, package: packageList().find((pkg) => pkg.id === activePackageId) };
  });

  app.get("/api/v1/status", async () => {
    const [curriculum, ankiStatus, localMtStatus] = await Promise.all([refreshCurriculum(), anki.metrics(), localMt.status?.()]);
    return { packageId: activePackageId, database: { reachable: true }, curriculum: { version: curriculum.version, modules: curriculum.modules.length }, providers: { ...models.status(), local_mt: localMtStatus }, anki: ankiStatus };
  });
  app.get("/api/v1/costs/summary", async () => store.getApiCostSummary(new Date(), models.pricingVersion?.() ?? "untracked"));
  app.get("/api/v1/settings", async () => ({
    anki: { configured: Boolean(store.getSetting("anki.connect_api_key") || config.anki.key), mode: "anki-connect" },
    models: { selection: models instanceof ModelRouter ? models.modelSelection() : undefined, choices: modelChoices },
    localMt: { ...(localMt.settings?.() ?? localMtSettings), status: await localMt.status?.() },
    sync: { ...driveSync.status(), googleOAuthClientId: store.getSetting<string>("google_drive.oauth_client_id") ?? config.googleOAuthClientId },
  }));
  app.get("/api/v1/sync/status", async () => driveSync.status());
  app.post<{ Body: { clientId?: string; clientSecret?: string } }>("/api/v1/sync/google/client", async (request, reply) => {
    const clientId = request.body?.clientId?.trim();
    if (!clientId?.endsWith(".apps.googleusercontent.com")) return reply.code(400).send({ error: "google_oauth_client_id_required" });
    store.setSetting("google_drive.oauth_client_id", clientId);
    const clientSecret = request.body?.clientSecret?.trim();
    if (clientSecret) store.setSetting("google_drive.oauth_client_secret", clientSecret);
    return { googleOAuthClientId: clientId };
  });
  app.get("/api/v1/sync/google/authorize", async (_request, reply) => {
    const clientId = store.getSetting<string>("google_drive.oauth_client_id") ?? config.googleOAuthClientId;
    if (!clientId) return reply.code(409).send({ error: "google_oauth_client_id_required" });
    const state = randomUUID(); const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = `http://127.0.0.1:${config.port}/api/v1/sync/google/callback`;
    store.setSetting("google_drive.oauth_pending", { state, verifier, redirectUri, createdAt: new Date().toISOString() });
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "https://www.googleapis.com/auth/drive.appdata", code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent" });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${query}`);
  });
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/v1/sync/google/callback", async (request, reply) => {
    const pending = store.getSetting<{ state: string; verifier: string; redirectUri: string }>("google_drive.oauth_pending");
    if (request.query.error || !request.query.code || !pending || request.query.state !== pending.state) return reply.code(400).type("text/html").send("<h1>Google-Anmeldung fehlgeschlagen</h1><p>Bitte dieses Fenster schließen und Langtut erneut öffnen.</p>");
    const clientId = store.getSetting<string>("google_drive.oauth_client_id") ?? config.googleOAuthClientId;
    const clientSecret = store.getSetting<string>("google_drive.oauth_client_secret") ?? config.googleOAuthClientSecret;
    const form = new URLSearchParams({ code: request.query.code, client_id: clientId!, redirect_uri: pending.redirectUri, grant_type: "authorization_code", code_verifier: pending.verifier });
    if (clientSecret) form.set("client_secret", clientSecret);
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    const token = await tokenResponse.json() as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
    store.deleteSetting("google_drive.oauth_pending");
    if (!tokenResponse.ok || !token.access_token) return reply.code(400).type("text/html").send(`<h1>Google-Anmeldung fehlgeschlagen</h1><p>${escapeHtml(token.error_description ?? token.error ?? "Unbekannter Fehler")}</p>`);
    driveSync.configureAccessToken(token.access_token, token.refresh_token); const result = await driveSync.sync();
    return reply.type("text/html").send(result.error ? `<h1>Google verbunden, Sync fehlgeschlagen</h1><p>${escapeHtml(result.error)}</p>` : "<h1>Google Drive verbunden</h1><p>Du kannst dieses Fenster schließen und zu Langtut zurückkehren.</p>");
  });
  // Native clients can also obtain OAuth tokens through their own system-browser flow.
  app.post<{ Body: { accessToken?: string } }>("/api/v1/sync/google/token", async (request, reply) => {
    const token = request.body?.accessToken?.trim(); if (!token) return reply.code(400).send({ error: "google_access_token_required" });
    driveSync.configureAccessToken(token); const result = await driveSync.sync();
    return result.connected ? result : reply.code(400).send(result);
  });
  app.post("/api/v1/sync/google/disconnect", async () => { driveSync.disconnect(); return driveSync.status(); });
  app.post("/api/v1/sync/now", async () => driveSync.sync());
  app.delete<{ Params: { id: string } }>("/api/v1/sessions/:id/transcript", async (request, reply) => {
    if (!store.getSession(request.params.id)) return reply.code(404).send({ error: "session_not_found" });
    const result = await driveSync.deleteTranscript(request.params.id);
    return result.error ? reply.code(503).send(result) : result;
  });
  app.post<{ Body: { openai?: string; gemini?: string } }>("/api/v1/settings/models", async (request, reply) => {
    if (!(models instanceof ModelRouter)) return reply.code(409).send({ error: "runtime_model_configuration_unavailable" });
    const current = models.modelSelection();
    const selection = { openai: request.body?.openai ?? current.openai, gemini: request.body?.gemini ?? current.gemini };
    try { models.setModelSelection(selection); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    store.setSetting("models.selection", selection);
    return { models: { selection, choices: modelChoices } };
  });
  app.post<{ Body: { enabled?: boolean; cloudFallback?: boolean } }>("/api/v1/settings/local-mt", async (request, reply) => {
    if (!localMt.configure || !localMt.settings) return reply.code(409).send({ error: "runtime_local_mt_configuration_unavailable" });
    const current = localMt.settings();
    const settings = { enabled: request.body?.enabled ?? current.enabled, cloudFallback: request.body?.cloudFallback ?? current.cloudFallback };
    localMt.configure(settings); await localMt.refresh?.(); store.setSetting("local_mt.settings", settings);
    return { localMt: { ...settings, status: await localMt.status?.() } };
  });
  app.post<{ Params: { key: string } }>("/api/v1/settings/local-mt/models/:key/install", async (request, reply) => {
    if (!localMt.install) return reply.code(409).send({ error: "runtime_local_mt_installation_unavailable" });
    try { await localMt.install(request.params.key); return reply.code(201).send({ localMt: { ...(localMt.settings?.() ?? localMtSettings), status: await localMt.status?.() } }); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post<{ Body: { apiKey?: string } }>("/api/v1/settings/anki-api-key", async (request, reply) => {
    const apiKey = request.body?.apiKey?.trim();
    if (!apiKey) return reply.code(400).send({ error: "anki_api_key_required" });
    if (!(anki instanceof AnkiClient)) return reply.code(409).send({ error: "runtime_anki_configuration_unavailable" });
    const previous = store.getSetting<string>("anki.connect_api_key") ?? config.anki.key;
    anki.configureKey(apiKey); const validation = await anki.metrics();
    if (!validation.reachable) { anki.configureKey(previous); return reply.code(400).send({ error: `anki_api_key_rejected: ${validation.error ?? "AnkiConnect nicht erreichbar"}` }); }
    store.setSetting("anki.connect_api_key", apiKey); return { anki: { configured: true } };
  });
  app.post<{ Params: { provider: "openai" | "gemini" }; Body: { apiKey?: string } }>("/api/v1/settings/providers/:provider/key", async (request, reply) => {
    const provider = request.params.provider; const apiKey = request.body?.apiKey?.trim();
    if (!apiKey || !["openai", "gemini"].includes(provider)) return reply.code(400).send({ error: "provider_api_key_required" });
    if (!(models instanceof ModelRouter)) return reply.code(409).send({ error: "runtime_model_configuration_unavailable" });
    models.configure(provider, apiKey); store.setSetting(`provider.${provider}.api_key`, apiKey);
    return { provider, configured: true };
  });

  app.get("/api/v1/curriculum", async () => refreshCurriculum());
  app.get("/api/v1/modules/progress", async () => {
    const curriculum = await refreshCurriculum();
    return {
      modules: Object.fromEntries(curriculum.modules.map((module) => {
        const evidence = store.getEvidence(activePackageId, module.id);
        return [module.id, {
          materialPrepared: preparationComplete(module, evidence),
          attemptedMilestoneIds: evidence.attemptedMilestones,
        }];
      })),
    };
  });
  app.get("/api/v1/curriculum/next", async () => nextAvailableModule(await refreshCurriculum()));
  app.get("/api/v1/activities", async () => ({ packageId: activePackageId, activities: active().activities.map(publicActivity) }));
  app.post("/api/v1/session-plans", async (_request, reply) => {
    const curriculum = await refreshCurriculum();
    const plan = createSessionPlan(await anki.metrics(), nextAvailableModule(curriculum), config.planner, activePackageId);
    store.savePlan(plan); return reply.code(201).send(plan);
  });
  app.post<{ Params: { id: string } }>("/api/v1/modules/:id/prepare", async (request, reply) => {
    const module = (await refreshCurriculum()).modules.find((candidate) => candidate.id === request.params.id);
    if (!module) return reply.code(404).send({ error: "unknown_module" });
    if (module.status === "locked" || module.status === "credited") return reply.code(409).send({ error: `module_${module.status}` });
    return reply.code(202).send(pipeline().start(module));
  });
  app.post<{ Params: { id: string; milestoneId: string } }>("/api/v1/modules/:id/milestones/:milestoneId/attempt", async (request, reply) => {
    const module = (await refreshCurriculum()).modules.find((candidate) => candidate.id === request.params.id);
    if (!module) return reply.code(404).send({ error: "unknown_module" });
    if (!module.grammarMilestones.some((milestone) => milestone.id === request.params.milestoneId)) return reply.code(400).send({ error: "unknown_milestone" });
    const evidence = store.getEvidence(activePackageId, module.id);
    evidence.attemptedMilestones = [...new Set([...evidence.attemptedMilestones, request.params.milestoneId])];
    const status = deriveModuleStatus(module.status, module, evidence);
    store.saveEvidence(activePackageId, module.id, evidence, status);
    await anki.syncModuleAvailability?.(activePackageId, Object.entries(store.getProgress(activePackageId)).filter(([, value]) => value === "learning").map(([moduleId]) => moduleId)).catch(() => undefined);
    return { packageId: activePackageId, moduleId: module.id, status, evidence };
  });

  app.get("/api/v1/jobs/latest", async () => store.getLatestJob(activePackageId));
  app.get<{ Params: { id: string } }>("/api/v1/jobs/:id", async (request, reply) => {
    const job = store.getJob(request.params.id); return job?.packageId === activePackageId ? job : reply.code(404).send({ error: "unknown_job" });
  });
  app.get("/api/v1/quarantine", async () => store.listQuarantine(activePackageId));
  app.post<{ Body: LexiconLookupRequest }>("/api/v1/lexicon/lookup", async (request, reply) => {
    const pkg = active(); const body = request.body;
    if (!body?.text?.trim() || !body?.surface?.trim()) return reply.code(400).send({ error: "text_and_surface_required" });
    if (body.targetLanguageCode !== pkg.manifest.targetLanguage.code || body.sourceLanguageCode !== pkg.manifest.sourceLanguage.code) return reply.code(400).send({ error: "language_pair_mismatch" });
    if (body.sessionId) { const session = store.getSession(body.sessionId); if (!session || session.packageId !== activePackageId) return reply.code(404).send({ error: "session_not_found" }); }
    return lexicon().lookup(body);
  });
  app.post<{ Body: LexiconStagingRequest }>("/api/v1/lexicon/staging", async (request, reply) => {
    const pkg = active(); const body = request.body;
    if (!body?.surface?.trim() || !body?.lemma?.trim() || !body?.pos?.trim() || !body?.translation?.trim()) return reply.code(400).send({ error: "incomplete_lexicon_candidate" });
    if (body.targetLanguageCode !== pkg.manifest.targetLanguage.code || body.sourceLanguageCode !== pkg.manifest.sourceLanguage.code) return reply.code(400).send({ error: "language_pair_mismatch" });
    if (body.sessionId) { const session = store.getSession(body.sessionId); if (!session || session.packageId !== activePackageId) return reply.code(404).send({ error: "session_not_found" }); }
    const id = store.stageLexicon(activePackageId, { sessionId: body.sessionId, languageCode: body.targetLanguageCode, sourceLanguageCode: body.sourceLanguageCode, surface: body.surface, lemma: body.lemma, pos: body.pos, translation: body.translation, context: body.context, payload: body });
    return reply.code(201).send({ id, status: "pending" });
  });
  app.get("/api/v1/export.jsonl", async (_request, reply) => reply.type("application/x-ndjson; charset=utf-8").send(store.exportJsonl()));
  app.get("/api/v1/integrations/anki/status", async () => anki.metrics());
  app.post("/api/v1/integrations/anki/setup/preview", async (_request, reply) => { try { return await anki.setupPreview(); } catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post<{ Body: { confirm?: boolean } }>("/api/v1/integrations/anki/setup/apply", async (request, reply) => {
    if (request.body?.confirm !== true) return reply.code(400).send({ error: "explicit_confirmation_required" });
    try { return await anki.applySetup(); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/v1/placement-sessions", async (_request, reply) => {
    const items = active().placement;
    const placement: PlacementState = { ...newPlacement(), packageId: activePackageId, answers: [] };
    if (!items.length) { placement.status = "completed"; placement.recommendedModuleId = (await refreshCurriculum()).modules[0]?.id; await applyPlacementStart(placement.recommendedModuleId ?? ""); }
    store.savePlacement(placement);
    return reply.code(201).send({ ...publicPlacement(placement), ...(items[0] && placement.status === "active" ? { nextItem: publicPlacementItem(items[0]) } : {}) });
  });
  app.get("/api/v1/placement-sessions/latest", async () => {
    const placement = store.getLatestPlacement<PlacementState>(activePackageId);
    return placement ? publicPlacementWithNext(placement, active().placement) : null;
  });
  app.post<{ Params: { id: string }; Body: { itemId: string; answer: string } }>("/api/v1/placement-sessions/:id/answers", async (request, reply) => {
    const pkg = active(); const items = pkg.placement;
    const placement = store.getPlacement<PlacementState>(activePackageId, request.params.id);
    if (!placement || placement.status !== "active") return reply.code(404).send({ error: "active_placement_not_found" });
    const item = items.find((candidate) => candidate.id === request.body?.itemId);
    if (!item || placement.answers.some((answer) => answer.itemId === item.id)) return reply.code(400).send({ error: "invalid_or_duplicate_item" });
    let correct: boolean; let rubric: PlacementEvaluation | undefined;
    if (item.kind === "open") {
      const prompt = `${renderPackagePrompt(pkg.prompts.placement_open_response, pkg)} Niveauziel: ${item.level}. Aufgabe: ${item.prompt}\nAntwort: ${request.body.answer}`;
      rubric = await models.structured<PlacementEvaluation>("placement_open_response", prompt, "PlacementEvaluation"); correct = rubric.score >= 0.6;
    } else correct = scoreAnswer(item, request.body.answer, pkg.manifest.targetLanguage.code);
    placement.answers.push({ itemId: item.id, correct }); placement.itemsAnswered = placement.answers.length; placement.score = placement.answers.filter((answer) => answer.correct).length;
    if (!correct) placement.weakTags = [...new Set([...placement.weakTags, item.tag, ...(rubric?.weakTags ?? [])])];
    const complete = placementShouldComplete(placement, items.length);
    if (complete) { placement.status = "completed"; placement.recommendedModuleId = recommendation(placement.score, placement.itemsAnswered, (await refreshCurriculum()).modules); await applyPlacementStart(placement.recommendedModuleId); }
    store.savePlacement(placement);
    return { ...publicPlacement(placement), correct, rubric, ...(!complete && items[placement.itemsAnswered] ? { nextItem: publicPlacementItem(items[placement.itemsAnswered]) } : {}) };
  });
  app.post<{ Params: { id: string }; Body: { moduleId: string } }>("/api/v1/placement-sessions/:id/override", async (request, reply) => {
    const placement = store.getPlacement<PlacementState>(activePackageId, request.params.id); const curriculum = await refreshCurriculum();
    const index = curriculum.modules.findIndex((module) => module.id === request.body?.moduleId);
    if (!placement || placement.status !== "completed" || index < 0) return reply.code(400).send({ error: "invalid_placement_or_module" });
    await applyPlacementStart(request.body.moduleId); placement.recommendedModuleId = request.body.moduleId; store.savePlacement(placement);
    return { ...publicPlacement(placement), selectedModuleId: request.body.moduleId };
  });

  app.post<{ Body: { planId?: string; moduleId?: string; activityId?: string } }>("/api/v1/sessions", async (request, reply) => {
    const pkg = active(); const activity = request.body?.activityId ? pkg.activities.find(({ id }) => id === request.body.activityId) : pkg.activities[0];
    if (request.body?.activityId && !activity) return reply.code(400).send({ error: "unknown_activity" });
    const module = (await refreshCurriculum()).modules.find(({ id }) => id === request.body?.moduleId);
    if (activity && module?.activityIds?.length && !module.activityIds.includes(activity.id)) return reply.code(400).send({ error: "activity_not_available_for_module" });
    const id = randomUUID(); store.createSession(activePackageId, id, request.body?.planId ?? null, request.body?.moduleId ?? null, activity?.id);
    let initialTurns: ActivityTurn[] = [];
    try { if (activity?.type === "roleplay") initialTurns = await executeOpeningTurns(id, activity, module); }
    catch (error) {
      store.completeSession(id, fallbackTutorReport(module?.focusTags ?? activity?.focusTags ?? [], {}, { languageSwitches: 0, goalCompletionPercent: 0 }));
      request.log.warn({ err: error }, "Roleplay opening failed");
      return reply.code(502).send({ error: "roleplay_opening_failed" });
    }
    return reply.code(201).send({ ...store.getSession(id), activityId: activity?.id, activity: activity ? publicActivity(activity) : undefined, initialTurns });
  });
  app.post<{ Params: { id: string }; Body: { answer?: string } }>("/api/v1/sessions/:id/exercise-attempts", async (request, reply) => {
    const session = store.getSession(request.params.id); if (!session || session.packageId !== activePackageId || session.status !== "active") return reply.code(404).send({ error: "active_exercise_not_found" });
    const start = store.getSessionEvents(request.params.id).find(({ eventType }) => eventType === "session_started")?.payload as { activityId?: string } | undefined;
    const activity = active().activities.find(({ id }) => id === start?.activityId);
    if (!activity?.exercise || activity.type === "roleplay") return reply.code(409).send({ error: "session_is_not_an_exercise" });
    const result = evaluateExercise(request.body?.answer ?? "", activity.exercise);
    store.appendSessionEvent(request.params.id, "exercise_attempt", { activityId: activity.id, outcome: result.outcome });
    if (result.outcome === "correct") store.completeSession(request.params.id, fallbackTutorReport(activity.focusTags ?? [], {}, { languageSwitches: 0, goalCompletionPercent: 100 }));
    return { ...result, completed: result.outcome === "correct" };
  });
  app.post<{ Params: { id: string }; Body: { message: string } }>("/api/v1/sessions/:id/activity-turns", async (request, reply) => {
    const session = store.getSession(request.params.id);
    if (!session || session.packageId !== activePackageId || session.status !== "active") return reply.code(404).send({ error: "active_session_not_found" });
    try {
      const outcome = await executeActivityTurn(request.params.id, request.body?.message ?? "", session.moduleId as string | undefined);
      const report = outcome.shouldComplete ? await completeActiveSession(request.params.id, session, request.log) : undefined;
      return { turns: outcome.turns, completed: outcome.shouldComplete, report };
    }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post<{ Params: { id: string }; Body: { message: string } }>("/api/v1/sessions/:id/turns", async (request, reply) => {
    const session = store.getSession(request.params.id);
    if (!session || session.packageId !== activePackageId || session.status !== "active") return reply.code(404).send({ error: "active_session_not_found" });
    let outcome: ActivityOutcome; try { outcome = await executeActivityTurn(request.params.id, request.body?.message ?? "", session.moduleId as string | undefined); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
    if (outcome.shouldComplete) await completeActiveSession(request.params.id, session, request.log);
    return outcome.turns[0]?.turn ?? emptyTutorTurn();
  });
  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/complete", async (request, reply) => {
    const session = store.getSession(request.params.id);
    if (!session || session.packageId !== activePackageId || session.status !== "active") return reply.code(404).send({ error: "active_session_not_found" });
    return completeActiveSession(request.params.id, session, request.log);
  });

  async function completeActiveSession(sessionId: string, session: Record<string, unknown>, logger: { warn: (...args: any[]) => void }): Promise<TutorReport> {
    const pkg = active(); const events = store.getSessionEvents(sessionId);
    const start = events.find(({ eventType }) => eventType === "session_started")?.payload as { activityId?: string } | undefined;
    const activity = pkg.activities.find(({ id }) => id === start?.activityId) ?? pkg.activities[0] ?? fallbackActivity();
    const module = (await refreshCurriculum()).modules.find(({ id }) => id === session.moduleId);
    const plan = session.planId ? store.getPlan(String(session.planId)) : null;
    const transcript = transcriptFromEvents(events, activity);
    const errorCounts = aggregateErrorTags(events);
    const learningSignals = aggregateLearningSignals(events);
    const previousRapport = await readRapport(dataRoot, pkg.manifest.id);
    const fallback = fallbackTutorReport(module?.focusTags ?? activity.focusTags ?? [], errorCounts, learningSignals);
    try {
      const prompt = `${renderPackagePrompt(pkg.prompts.session_report, pkg)}
Aktualisiere das Lernrapport ausschließlich anhand belastbarer Beobachtungen. Keine Quellen, Daten, Sitzungsnummern oder Dialogzitate. Erhalte weiterhin relevante ältere Erkenntnisse, entferne überholte Annahmen und schreibe ein kompaktes vollständiges Markdown-Dokument mit den Abschnitten Interessen und Präferenzen, Stärken, Schwierigkeiten, Hilfreiche Unterstützung und Aktuelle Prioritäten.
Erlaubte fachliche Tags: ${[...pkg.allowedTags].join(", ")}.
Bisheriges Rapport:\n${previousRapport || "Noch kein Rapport."}
Metadaten: ${JSON.stringify({ module: module?.title ?? null, activity: activity.title, sessionMode: plan?.mode ?? null, topics: module?.focusTags ?? activity.focusTags ?? [], functions: module?.functions ?? [], turns: events.filter(({ eventType }) => ["learner_turn", "activity_turn"].includes(eventType)).length, errorCounts, learningSignals })}
Gesamtdialog:\n${transcript || "Kein gesprochener Inhalt."}`;
      const analysis = await models.structured<SessionAnalysis>("session_report", prompt, "SessionAnalysis");
      await writeRapportAtomic(dataRoot, pkg.manifest.id, analysis.rapportMarkdown);
      store.setSetting(`rapport.profile.${pkg.manifest.id}`, analysis.profile);
      const report = { ...analysis.report, languageSwitches: learningSignals.languageSwitches, goalCompletionPercent: learningSignals.goalCompletionPercent };
      store.completeSession(sessionId, report);
      return report;
    } catch (error) {
      store.completeSession(sessionId, fallback);
      logger.warn({ err: error }, "Session completed without rapport update");
      return fallback;
    }
  }

  app.get("/health", async () => ({ ok: true }));

  async function executeActivityTurn(sessionId: string, message: string, moduleId?: string): Promise<ActivityOutcome> {
    const pkg = active(); const history = store.getSessionEvents(sessionId); const start = history.find(({ eventType }) => eventType === "session_started")?.payload as { activityId?: string } | undefined;
    const activity = pkg.activities.find(({ id }) => id === start?.activityId) ?? pkg.activities[0] ?? fallbackActivity();
    const completedLearnerTurns = history.filter(({ eventType }) => eventType === "learner_turn").length;
    if (completedLearnerTurns >= activity.rounds) throw new Error("activity_round_limit_reached");
    const round = completedLearnerTurns + 1;
    const module = (await refreshCurriculum()).modules.find(({ id }) => id === moduleId);
    store.appendSessionEvent(sessionId, "learner_turn", { roleId: activity.roles.find(({ controller }) => controller === "learner")?.id ?? "learner", message });
    const results: ActivityTurn[] = [];
    for (const roleId of rolesAfterLearner(activity)) {
      const role = activity.roles.find(({ id }) => id === roleId)!;
      if (role.controller === "fixed") {
        const turn = { ...emptyTutorTurn(), message: role.message ?? "", conversationState: round >= activity.rounds ? "completed" as const : "continue" as const };
        results.push({ roleId, roleLabel: role.label, turn }); store.appendSessionEvent(sessionId, "activity_turn", { roleId, turn, evaluatesLearner: true }); continue;
      }
      if (role.controller !== "llm") continue;
      const roleTemplate = pkg.prompts[role.prompt ?? "tutor_conversation"] ?? pkg.prompts.tutor_conversation;
      const learnerContext = currentLearnerContext(pkg, module, activity);
      const recentDialogue = transcriptFromEvents(history, activity).split("\n").slice(-8).join("\n");
      const endingInstruction = round >= activity.rounds
        ? "Dies ist der letzte erlaubte Lernendenzug. Binde die Situation jetzt natürlich ab, verabschiede dich situationsgerecht und setze conversationState auf completed."
        : round === activity.rounds - 1
          ? "Führe die Situation auf einen natürlichen Abschluss hin. Setze conversationState auf closing; falls der Lernende sich bereits verabschiedet hat, antworte mit einer passenden Verabschiedung und setze completed."
          : "Wenn der Lernende sich erkennbar verabschiedet oder die Situation natürlich beendet, verabschiede dich passend und setze conversationState auf completed; sonst continue.";
      const prompt = `${renderPackagePrompt(roleTemplate, pkg)}\nRolle: ${role.label}. Aktivität: ${activity.title}. Runde ${round} von maximal ${activity.rounds}.\nAktives Modul: ${module?.title ?? "freie Wiederholung"}. Funktionen: ${module?.functions.join(", ") ?? "keine"}. Lernziele: ${module?.grammarMilestones.map(({ description }) => description).join(" | ") ?? "keine"}.\nRelevanter Lernenden-Kontext:\n${learnerContext}\nJüngster Dialog:\n${recentDialogue || "Noch kein Dialog."}\nLernereingabe: ${message}\nReagiere in message ausschließlich als Gesprächspartner mit natürlichem Konversationstext in ${pkg.manifest.targetLanguage.name}: greife die beabsichtigte, gedanklich korrigierte Bedeutung auf und führe die Szene weiter. Verlange niemals, dass der Lernende eine Korrektur wiederholt. Keine Korrektur, Erklärung, Bewertung, Anführungszeichen oder Metakommentare in message. correction enthält bei Fehlern oder Sprachwechsel ausschließlich eine natürliche korrigierte Gesamtfassung der Lernereingabe in ${pkg.manifest.targetLanguage.name}, sonst einen leeren String. explanation enthält nur bei tatsächlichem Korrekturbedarf eine knappe, nutzergerichtete Erklärung in ${pkg.manifest.sourceLanguage.name}; kein internes Reasoning und kein Lob für korrekte Antworten. Erkenne Antworten in ${pkg.manifest.sourceLanguage.name} als targetLanguageUse=source und gemischte Antworten als mixed; füge dann error_language_switch hinzu und ziehe dies über goalProgress=not_met oder partial von der Lernzielerfüllung ab. errorTags enthält höchstens drei kurze fachliche Tags. ${endingInstruction}\nBleibe in der Rolle und erwähne das Lernprofil nicht. Gib keine Markdown-Syntax aus.`;
      let turn = normalizeTutorTurn(await models.structured<TutorTurn>("tutor_conversation", prompt, "TutorTurn"), pkg.manifest.sourceLanguage.name);
      if (round >= activity.rounds) turn = { ...turn, conversationState: "completed" };
      results.push({ roleId, roleLabel: role.label, turn }); store.appendSessionEvent(sessionId, "activity_turn", { roleId, turn, evaluatesLearner: true });
    }
    return { turns: results, shouldComplete: round >= activity.rounds || results.some(({ turn }) => turn.conversationState === "completed") };
  }
  async function executeOpeningTurns(sessionId: string, activity: LearningActivity, module?: Awaited<ReturnType<typeof refreshCurriculum>>["modules"][number]): Promise<ActivityTurn[]> {
    const pkg = active(); const results: ActivityTurn[] = [];
    for (const roleId of rolesBeforeLearner(activity)) {
      const role = activity.roles.find(({ id }) => id === roleId)!;
      if (role.controller === "fixed") {
        const turn = { ...emptyTutorTurn(), message: role.message ?? "" };
        results.push({ roleId, roleLabel: role.label, turn }); store.appendSessionEvent(sessionId, "activity_turn", { roleId, turn, evaluatesLearner: false }); continue;
      }
      if (role.controller !== "llm") continue;
      const roleTemplate = pkg.prompts[role.prompt ?? "tutor_conversation"] ?? pkg.prompts.tutor_conversation;
      const prompt = `${renderPackagePrompt(roleTemplate, pkg)}\nRolle: ${role.label}. Eröffne dieses Rollenspiel mit genau einem natürlichen, kurzen Gesprächszug auf ${pkg.manifest.targetLanguage.name}.\nSzenario: ${activity.scenarioTarget}\nAktives Modul: ${module?.title ?? "freie Wiederholung"}. Funktionen: ${module?.functions.join(", ") ?? "keine"}.\nRelevanter Lernenden-Kontext:\n${currentLearnerContext(pkg, module, activity)}\nErkläre noch nichts, erwähne das Lernprofil nicht und gib keine Markdown-Syntax aus. correction, explanation, newExample und errorTags bleiben leer; targetLanguageUse=target, goalProgress=partial und conversationState=continue.`;
      const turn = normalizeTutorTurn(await models.structured<TutorTurn>("tutor_conversation", prompt, "TutorTurn"), pkg.manifest.sourceLanguage.name);
      results.push({ roleId, roleLabel: role.label, turn }); store.appendSessionEvent(sessionId, "activity_turn", { roleId, turn, evaluatesLearner: false });
    }
    return results;
  }
  function currentLearnerContext(pkg: LoadedLearningPackage, module: Awaited<ReturnType<typeof refreshCurriculum>>["modules"][number] | undefined, activity: LearningActivity): string {
    const profile = store.getSetting<LearnerProfile>(`rapport.profile.${pkg.manifest.id}`);
    return buildLearnerContext(profile, [activity.title, ...(activity.focusTags ?? []), module?.title ?? "", ...(module?.focusTags ?? []), ...(module?.functions ?? [])]);
  }
  async function applyPlacementStart(moduleId: string) {
    const curriculum = await refreshCurriculum(); const index = curriculum.modules.findIndex((module) => module.id === moduleId); if (index < 0) return;
    curriculum.modules.forEach((module, moduleIndex) => store.setStatus(activePackageId, module.id, moduleIndex < index ? "credited" : moduleIndex === index ? "available" : "locked"));
  }
  return app;
}

function fallbackActivity(): LearningActivity { return { id: "conversation", title: "Konversation", roles: [{ id: "learner", label: "Lernender", controller: "learner" }, { id: "tutor", label: "Tutor", controller: "llm", prompt: "tutor_conversation" }], turnOrder: ["learner", "tutor"], rounds: 8 }; }
function publicActivity(activity: LearningActivity) { const { exercise, ...value } = activity; return exercise ? { ...value, exercise: { prompt: exercise.prompt, tokens: exercise.tokens, hint: exercise.hint } } : value; }
function publicPlacement(placement: PlacementState) { return { id: placement.id, packageId: placement.packageId, status: placement.status, startedAt: placement.startedAt, itemsAnswered: placement.itemsAnswered, maxItems: placement.maxItems, recommendedModuleId: placement.recommendedModuleId, weakTags: placement.weakTags }; }
function publicPlacementItem(item: PlacementItemDefinition) { return { id: item.id, level: item.level, prompt: item.prompt, kind: item.kind ?? "production", choices: item.choices }; }
function publicPlacementWithNext(placement: PlacementState, items: PlacementItemDefinition[]) { return { ...publicPlacement(placement), ...(placement.status === "active" && items[placement.itemsAnswered] ? { nextItem: publicPlacementItem(items[placement.itemsAnswered]) } : {}) }; }

function fallbackTutorReport(focusTags: string[], errorCounts: Record<string, number>, signals: { languageSwitches: number; goalCompletionPercent: number }): TutorReport { return { focusTags, observedErrors: Object.entries(errorCounts).map(([tag, count]) => `${tag} (${count})`), observedStrengths: [], languageSwitches: signals.languageSwitches, goalCompletionPercent: signals.goalCompletionPercent, suggestedReviewItems: [], suggestedNewCards: [], nextSessionSuggestions: [] }; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
