import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { LearnerProfile, PlacementEvaluation, SessionAnalysis, TutorReport, TutorTurn } from "@langtut/contracts";
import {
  DEFAULT_PACKAGE_ID, LearningPackageRepository, applyProgress, createSessionPlan, deriveModuleStatus,
  nextAvailableModule, preparationComplete, recomputeLocks, renderPackagePrompt, type LearningActivity, type LoadedLearningPackage,
  type PlacementItemDefinition,
} from "@langtut/domain";
import { AnkiClient, type AnkiGateway } from "./anki.js";
import { loadConfig } from "./config.js";
import { ContentPipeline } from "./content-pipeline.js";
import { Store } from "./database.js";
import { newPlacement, recommendation, scoreAnswer } from "./placement.js";
import { ModelRouter, modelChoices, type ModelGateway } from "./providers.js";
import { aggregateErrorTags, aggregateLearningSignals, buildLearnerContext, readRapport, transcriptFromEvents, writeRapportAtomic } from "./rapport.js";

type PlacementState = ReturnType<typeof newPlacement> & { packageId: string; answers: Array<{ itemId: string; correct: boolean }>; recommendedModuleId?: string };
type ActivityTurn = { roleId: string; roleLabel: string; turn: TutorTurn };
type ActivityOutcome = { turns: ActivityTurn[]; shouldComplete: boolean };

export async function buildApp(root = process.cwd(), overrides: { models?: ModelGateway; anki?: AnkiGateway } = {}) {
  const config = await loadConfig(root);
  const store = await Store.open(config.dbPath, root);
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
  const anki = overrides.anki ?? new AnkiClient(config.anki.url, config.anki.deck, config.anki.key);
  const dataRoot = path.dirname(config.dbPath);

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
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { files: 1, fileSize: 50 * 1024 * 1024 } });

  async function refreshCurriculum() {
    const pkg = active();
    const base = applyProgress(pkg.curriculum, store.getProgress(pkg.manifest.id));
    const progress = recomputeLocks(base, store.getProgress(pkg.manifest.id));
    for (const module of base.modules) store.setStatus(pkg.manifest.id, module.id, progress[module.id]);
    return applyProgress(pkg.curriculum, progress);
  }
  function pipeline() { return new ContentPipeline(store, anki, models, active(), path.join(path.dirname(config.dbPath), "diagnostics", `${activePackageId}.jsonl`)); }
  function packageList() { return packages.list(activePackageId).map((pkg) => { const progress = store.getProgress(pkg.id); return { ...pkg, progress: { started: Object.values(progress).filter((status) => ["preparing", "learning", "credited"].includes(status)).length, completed: Object.values(progress).filter((status) => ["learning", "credited"].includes(status)).length, total: pkg.modules } }; }); }

  await refreshCurriculum();
  app.addHook("onClose", async () => store.close());

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
    const [curriculum, ankiStatus] = await Promise.all([refreshCurriculum(), anki.metrics()]);
    return { packageId: activePackageId, database: { reachable: true }, curriculum: { version: curriculum.version, modules: curriculum.modules.length }, providers: models.status(), anki: ankiStatus };
  });
  app.get("/api/v1/costs/summary", async () => store.getApiCostSummary(new Date(), models.pricingVersion?.() ?? "untracked"));
  app.get("/api/v1/settings", async () => ({
    anki: { configured: Boolean(store.getSetting("anki.connect_api_key") || config.anki.key) },
    models: { selection: models instanceof ModelRouter ? models.modelSelection() : undefined, choices: modelChoices },
  }));
  app.post<{ Body: { openai?: string; gemini?: string } }>("/api/v1/settings/models", async (request, reply) => {
    if (!(models instanceof ModelRouter)) return reply.code(409).send({ error: "runtime_model_configuration_unavailable" });
    const current = models.modelSelection();
    const selection = { openai: request.body?.openai ?? current.openai, gemini: request.body?.gemini ?? current.gemini };
    try { models.setModelSelection(selection); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    store.setSetting("models.selection", selection);
    return { models: { selection, choices: modelChoices } };
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
  app.get("/api/v1/activities", async () => ({ packageId: activePackageId, activities: active().activities }));
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
    return { packageId: activePackageId, moduleId: module.id, status, evidence };
  });

  app.get("/api/v1/jobs/latest", async () => store.getLatestJob(activePackageId));
  app.get<{ Params: { id: string } }>("/api/v1/jobs/:id", async (request, reply) => {
    const job = store.getJob(request.params.id); return job?.packageId === activePackageId ? job : reply.code(404).send({ error: "unknown_job" });
  });
  app.get("/api/v1/quarantine", async () => store.listQuarantine(activePackageId));
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
    const stableHigh = placement.itemsAnswered >= 9 && placement.score / placement.itemsAnswered >= 0.78;
    const stableLow = placement.itemsAnswered >= 6 && placement.score / placement.itemsAnswered <= 0.34;
    const complete = stableHigh || stableLow || (Date.now() - Date.parse(placement.startedAt)) / 60_000 >= 15 || placement.itemsAnswered >= items.length || placement.itemsAnswered >= placement.maxItems;
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
    return reply.code(201).send({ ...store.getSession(id), activityId: activity?.id, activity, initialTurns });
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
export function rolesBeforeLearner(activity: LearningActivity): string[] { const learnerIndex = activity.turnOrder.findIndex((id) => activity.roles.find((role) => role.id === id)?.controller === "learner"); return learnerIndex < 0 ? [] : activity.turnOrder.slice(0, learnerIndex); }
export function rolesAfterLearner(activity: LearningActivity): string[] { const learnerIndex = activity.turnOrder.findIndex((id) => activity.roles.find((role) => role.id === id)?.controller === "learner"); const rotated = [...activity.turnOrder.slice(learnerIndex + 1), ...activity.turnOrder.slice(0, learnerIndex)]; const nextLearner = rotated.findIndex((id) => activity.roles.find((role) => role.id === id)?.controller === "learner"); return nextLearner < 0 ? rotated : rotated.slice(0, nextLearner); }
function publicPlacement(placement: PlacementState) { return { id: placement.id, packageId: placement.packageId, status: placement.status, startedAt: placement.startedAt, itemsAnswered: placement.itemsAnswered, maxItems: placement.maxItems, recommendedModuleId: placement.recommendedModuleId, weakTags: placement.weakTags }; }
function publicPlacementItem(item: PlacementItemDefinition) { return { id: item.id, level: item.level, prompt: item.prompt, kind: item.kind ?? "production", choices: item.choices }; }
function publicPlacementWithNext(placement: PlacementState, items: PlacementItemDefinition[]) { return { ...publicPlacement(placement), ...(placement.status === "active" && items[placement.itemsAnswered] ? { nextItem: publicPlacementItem(items[placement.itemsAnswered]) } : {}) }; }

export function normalizeTutorTurn(turn: TutorTurn, sourceLanguageName = "Deutsch"): TutorTurn {
  const plain = (value: string) => value.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  let message = plain(turn.message); let explanation = plain(turn.explanation);
  const translated = message.match(new RegExp(`\\s*${escapeRegExp(sourceLanguageName)}:\\s*(.+)$`, "i"));
  if (translated?.index !== undefined) { message = message.slice(0, translated.index).trim(); explanation = [plain(translated[1]), explanation].filter(Boolean).join(" "); }
  return {
    message, correction: plain(turn.correction), explanation, newExample: plain(turn.newExample),
    errorTags: [...new Set((turn.errorTags ?? []).map(plain).filter(Boolean))].slice(0, 3),
    targetLanguageUse: turn.targetLanguageUse ?? "target",
    goalProgress: turn.goalProgress ?? "partial",
    conversationState: turn.conversationState ?? "continue",
  };
}
function emptyTutorTurn(): TutorTurn { return { message: "", correction: "", explanation: "", newExample: "", errorTags: [], targetLanguageUse: "target", goalProgress: "partial", conversationState: "continue" }; }
function fallbackTutorReport(focusTags: string[], errorCounts: Record<string, number>, signals: { languageSwitches: number; goalCompletionPercent: number }): TutorReport { return { focusTags, observedErrors: Object.entries(errorCounts).map(([tag, count]) => `${tag} (${count})`), observedStrengths: [], languageSwitches: signals.languageSwitches, goalCompletionPercent: signals.goalCompletionPercent, suggestedReviewItems: [], suggestedNewCards: [], nextSessionSuggestions: [] }; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
