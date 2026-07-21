import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import YAML from "yaml";
import type { PlacementEvaluation, TutorReport, TutorTurn } from "@langtut/contracts";
import { createSessionPlan, deriveModuleStatus, loadCurriculum, nextAvailableModule, recomputeLocks } from "@langtut/domain";
import { AnkiClient, type AnkiGateway } from "./anki.js";
import { loadConfig } from "./config.js";
import { ContentPipeline } from "./content-pipeline.js";
import { Store } from "./database.js";
import { newPlacement, placementItems, recommendation, scoreAnswer } from "./placement.js";
import { ModelRouter, modelChoices, type ModelGateway } from "./providers.js";

type PlacementState = ReturnType<typeof newPlacement> & { answers: Array<{ itemId: string; correct: boolean }>; recommendedModuleId?: string };

export async function buildApp(root = process.cwd(), overrides: { models?: ModelGateway; anki?: AnkiGateway } = {}) {
  const config = await loadConfig(root);
  const store = await Store.open(config.dbPath, root);
  const models = overrides.models ?? await ModelRouter.load(root, config.modelTasksPath, (event) => store.recordApiUsage(event));
  const savedModelSelection = store.getSetting<{ openai: string; gemini: string }>("models.selection");
  if (savedModelSelection && models instanceof ModelRouter) models.setModelSelection(savedModelSelection);
  const anki = overrides.anki ?? new AnkiClient(config.anki.url, config.anki.deck, config.anki.key);
  const savedAnkiKey = store.getSetting<string>("anki.connect_api_key");
  if (savedAnkiKey && anki instanceof AnkiClient) {
    anki.configureKey(savedAnkiKey);
    const keyedStatus = await anki.metrics();
    if (!keyedStatus.reachable && /valid api key/i.test(keyedStatus.error ?? "")) {
      anki.configureKey(undefined);
      const keylessStatus = await anki.metrics();
      if (keylessStatus.reachable) store.deleteSetting("anki.connect_api_key");
      else anki.configureKey(savedAnkiKey);
    }
  }
  const tagsDocument = YAML.parse(await readFile(path.join(root, "slowakisch_ai_tutor_recovery_bundle/tag_schema.yaml"), "utf8")) as { categories: Record<string, string[]> };
  const allowedTags = new Set(Object.values(tagsDocument.categories).flat());
  const pipeline = new ContentPipeline(store, anki, models, allowedTags, path.join(path.dirname(config.dbPath), "diagnostics/content-pipeline.jsonl"));
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  async function refreshCurriculum() {
    const base = await loadCurriculum(root, store.getProgress());
    const progress = recomputeLocks(base, store.getProgress());
    for (const module of base.modules) store.setStatus(module.id, progress[module.id]);
    return loadCurriculum(root, progress);
  }

  await refreshCurriculum();
  app.addHook("onClose", async () => store.close());

  app.get("/api/v1/status", async () => {
    const [curriculum, ankiStatus] = await Promise.all([refreshCurriculum(), anki.metrics()]);
    return { database: { reachable: true }, curriculum: { version: curriculum.version, modules: curriculum.modules.length }, providers: models.status(), anki: ankiStatus };
  });
  app.get("/api/v1/costs/summary", async () => store.getApiCostSummary(new Date(), models.pricingVersion?.() ?? "untracked"));

  app.get("/api/v1/settings", async () => ({
    anki: { configured: Boolean(store.getSetting("anki.connect_api_key") || config.anki.key) },
    models: {
      selection: models instanceof ModelRouter ? models.modelSelection() : undefined,
      choices: modelChoices,
    },
  }));
  app.post<{ Body: { openai?: string; gemini?: string } }>("/api/v1/settings/models", async (request, reply) => {
    if (!(models instanceof ModelRouter)) return reply.code(409).send({ error: "runtime_model_configuration_unavailable" });
    const current = models.modelSelection();
    const selection = { openai: request.body?.openai ?? current.openai, gemini: request.body?.gemini ?? current.gemini };
    try {
      models.setModelSelection(selection);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    store.setSetting("models.selection", selection);
    return { models: { selection, choices: modelChoices } };
  });
  app.post<{ Body: { apiKey?: string } }>("/api/v1/settings/anki-api-key", async (request, reply) => {
    const apiKey = request.body?.apiKey?.trim();
    if (!apiKey) return reply.code(400).send({ error: "anki_api_key_required" });
    if (!(anki instanceof AnkiClient)) return reply.code(409).send({ error: "runtime_anki_configuration_unavailable" });
    const previous = store.getSetting<string>("anki.connect_api_key") ?? config.anki.key;
    anki.configureKey(apiKey);
    const validation = await anki.metrics();
    if (!validation.reachable) {
      anki.configureKey(previous);
      return reply.code(400).send({ error: `anki_api_key_rejected: ${validation.error ?? "AnkiConnect nicht erreichbar"}` });
    }
    store.setSetting("anki.connect_api_key", apiKey);
    return { anki: { configured: true } };
  });

  app.get("/api/v1/curriculum", async () => refreshCurriculum());
  app.get("/api/v1/curriculum/next", async () => nextAvailableModule(await refreshCurriculum()));

  app.post("/api/v1/session-plans", async (_request, reply) => {
    const curriculum = await refreshCurriculum();
    const plan = createSessionPlan(await anki.metrics(), nextAvailableModule(curriculum), config.planner);
    store.savePlan(plan);
    return reply.code(201).send(plan);
  });

  app.post<{ Params: { id: string } }>("/api/v1/modules/:id/prepare", async (request, reply) => {
    const module = (await refreshCurriculum()).modules.find((candidate) => candidate.id === request.params.id);
    if (!module) return reply.code(404).send({ error: "unknown_module" });
    if (module.status === "locked" || module.status === "credited") return reply.code(409).send({ error: `module_${module.status}` });
    return reply.code(202).send(pipeline.start(module));
  });

  app.post<{ Params: { id: string; milestoneId: string } }>("/api/v1/modules/:id/milestones/:milestoneId/attempt", async (request, reply) => {
    const curriculum = await refreshCurriculum();
    const module = curriculum.modules.find((candidate) => candidate.id === request.params.id);
    if (!module) return reply.code(404).send({ error: "unknown_module" });
    if (!module.grammarMilestones.some((milestone) => milestone.id === request.params.milestoneId)) return reply.code(400).send({ error: "unknown_milestone" });
    const evidence = store.getEvidence(module.id);
    evidence.attemptedMilestones = [...new Set([...evidence.attemptedMilestones, request.params.milestoneId])];
    const status = deriveModuleStatus(module.status, module, evidence);
    store.saveEvidence(module.id, evidence, status);
    return { moduleId: module.id, status, evidence };
  });

  app.get("/api/v1/jobs/latest", async () => store.getLatestJob());
  app.get<{ Params: { id: string } }>("/api/v1/jobs/:id", async (request, reply) => store.getJob(request.params.id) ?? reply.code(404).send({ error: "unknown_job" }));
  app.get("/api/v1/quarantine", async () => store.listQuarantine());
  app.get("/api/v1/export.jsonl", async (_request, reply) => reply.type("application/x-ndjson; charset=utf-8").send(store.exportJsonl()));

  app.get("/api/v1/integrations/anki/status", async () => anki.metrics());
  app.post("/api/v1/integrations/anki/setup/preview", async (_request, reply) => {
    try { return await anki.setupPreview(); } catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post<{ Body: { confirm?: boolean } }>("/api/v1/integrations/anki/setup/apply", async (request, reply) => {
    if (request.body?.confirm !== true) return reply.code(400).send({ error: "explicit_confirmation_required" });
    try { return await anki.applySetup(); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/v1/placement-sessions", async (_request, reply) => {
    const placement: PlacementState = { ...newPlacement(), answers: [] };
    store.savePlacement(placement);
    return reply.code(201).send({ ...publicPlacement(placement), nextItem: publicPlacementItem(placementItems[0]) });
  });

  app.get("/api/v1/placement-sessions/latest", async () => {
    const placement = store.getLatestPlacement<PlacementState>();
    if (!placement) return null;
    return publicPlacementWithNext(placement);
  });

  app.post<{ Params: { id: string }; Body: { itemId: string; answer: string } }>("/api/v1/placement-sessions/:id/answers", async (request, reply) => {
    const placement = store.getPlacement<PlacementState>(request.params.id);
    if (!placement || placement.status !== "active") return reply.code(404).send({ error: "active_placement_not_found" });
    const item = placementItems.find((candidate) => candidate.id === request.body?.itemId);
    if (!item || placement.answers.some((answer) => answer.itemId === item.id)) return reply.code(400).send({ error: "invalid_or_duplicate_item" });
    let correct: boolean;
    let rubric: PlacementEvaluation | undefined;
    if (item.kind === "open") {
      rubric = await models.structured<PlacementEvaluation>("placement_open_response", `Bewerte diese freie slowakische Placement-Antwort auf Aufgabenerfüllung, Verständlichkeit und sprachliche Kontrolle. Niveauziel: ${item.level}. Verwende nur bekannte Tags. Aufgabe: ${item.prompt}\nAntwort: ${request.body.answer}`, "PlacementEvaluation");
      correct = rubric.score >= 0.6;
    } else correct = scoreAnswer(item, request.body.answer);
    placement.answers.push({ itemId: item.id, correct });
    placement.itemsAnswered = placement.answers.length;
    placement.score = placement.answers.filter((answer) => answer.correct).length;
    if (!correct) placement.weakTags = [...new Set([...placement.weakTags, item.tag, ...(rubric?.weakTags ?? [])])];
    const stableHigh = placement.itemsAnswered >= 9 && placement.score / placement.itemsAnswered >= 0.78;
    const stableLow = placement.itemsAnswered >= 6 && placement.score / placement.itemsAnswered <= 0.34;
    const elapsedMinutes = (Date.now() - Date.parse(placement.startedAt)) / 60_000;
    const complete = stableHigh || stableLow || elapsedMinutes >= 15 || placement.itemsAnswered >= placementItems.length || placement.itemsAnswered >= placement.maxItems;
    if (complete) {
      placement.status = "completed";
      placement.recommendedModuleId = recommendation(placement.score, placement.itemsAnswered);
      await applyPlacementStart(placement.recommendedModuleId);
    }
    store.savePlacement(placement);
    const nextItem = complete ? undefined : publicPlacementItem(placementItems[placement.itemsAnswered]);
    return { ...publicPlacement(placement), correct, rubric, nextItem };
  });

  app.post<{ Params: { id: string }; Body: { moduleId: string } }>("/api/v1/placement-sessions/:id/override", async (request, reply) => {
    const placement = store.getPlacement<PlacementState>(request.params.id);
    const curriculum = await refreshCurriculum();
    const index = curriculum.modules.findIndex((module) => module.id === request.body?.moduleId);
    if (!placement || placement.status !== "completed" || index < 0) return reply.code(400).send({ error: "invalid_placement_or_module" });
    curriculum.modules.forEach((module, moduleIndex) => store.setStatus(module.id, moduleIndex < index ? "credited" : moduleIndex === index ? "available" : "locked"));
    placement.recommendedModuleId = request.body.moduleId;
    store.savePlacement(placement);
    return { ...publicPlacement(placement), selectedModuleId: request.body.moduleId };
  });

  app.post<{ Body: { planId?: string; moduleId?: string } }>("/api/v1/sessions", async (request, reply) => {
    const id = randomUUID();
    store.createSession(id, request.body?.planId ?? null, request.body?.moduleId ?? null);
    return reply.code(201).send(store.getSession(id));
  });

  app.post<{ Params: { id: string }; Body: { message: string } }>("/api/v1/sessions/:id/turns", async (request, reply) => {
    const session = store.getSession(request.params.id);
    if (!session || session.status !== "active") return reply.code(404).send({ error: "active_session_not_found" });
    const history = store.getSessionEvents(request.params.id);
    const module = (await refreshCurriculum()).modules.find(({ id }) => id === session.moduleId);
    const prompt = `Du bist ein geduldiger Slowakisch-Tutor. Antworte primär auf Slowakisch, erkläre knapp auf Deutsch. Korrigiere nur den wichtigsten Fehler.
Aktives Modul: ${module?.title ?? "freie Wiederholung"}. Funktionen: ${module?.functions.join(", ") ?? "keine"}. Grammatikziele: ${module?.grammarMilestones.map(({ description }) => description).join(" | ") ?? "keine"}.
Bisher: ${JSON.stringify(history)}\nLernereingabe: ${request.body?.message ?? ""}`;
    const rawTurn = await models.structured<TutorTurn>("tutor_conversation", `${prompt}
Behandle Meta-Kommentare über deine vorherige Aufgabe als Gesprächsbeitrag. Interpretiere zitierten Text nicht automatisch als Übersetzungsauftrag; frage bei echter Mehrdeutigkeit kurz nach.
Gib keine Markdown-Syntax aus. message enthält nur die slowakische Tutorreaktion, explanation nur die deutsche Erklärung.`, "TutorTurn");
    const turn = normalizeTutorTurn(rawTurn);
    store.appendSessionEvent(request.params.id, "learner_turn", { message: request.body.message });
    store.appendSessionEvent(request.params.id, "tutor_turn", turn);
    return turn;
  });

  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/complete", async (request, reply) => {
    const session = store.getSession(request.params.id);
    if (!session || session.status !== "active") return reply.code(404).send({ error: "active_session_not_found" });
    const events = store.getSessionEvents(request.params.id);
    const report = await models.structured<TutorReport>("session_report", `Erstelle einen strukturierten, evidenzbasierten Bericht. Erfinde keine Fehler. Erlaubte Tags: ${[...allowedTags].join(", ")}.\n${JSON.stringify(events)}`, "TutorReport");
    store.completeSession(request.params.id, report);
    return report;
  });

  app.get("/health", async () => ({ ok: true }));

  async function applyPlacementStart(moduleId: string) {
    const curriculum = await refreshCurriculum();
    const index = curriculum.modules.findIndex((module) => module.id === moduleId);
    if (index < 0) return;
    curriculum.modules.forEach((module, moduleIndex) => store.setStatus(module.id, moduleIndex < index ? "credited" : moduleIndex === index ? "available" : "locked"));
  }

  return app;
}

function publicPlacement(placement: PlacementState) {
  return { id: placement.id, status: placement.status, startedAt: placement.startedAt, itemsAnswered: placement.itemsAnswered, maxItems: placement.maxItems, recommendedModuleId: placement.recommendedModuleId, weakTags: placement.weakTags };
}

function publicPlacementItem(item: (typeof placementItems)[number]) {
  return { id: item.id, level: item.level, prompt: item.prompt, kind: item.kind ?? "production", choices: item.choices };
}

function publicPlacementWithNext(placement: PlacementState) {
  return {
    ...publicPlacement(placement),
    ...(placement.status === "active" && placementItems[placement.itemsAnswered]
      ? { nextItem: publicPlacementItem(placementItems[placement.itemsAnswered]) }
      : {}),
  };
}

export function normalizeTutorTurn(turn: TutorTurn): TutorTurn {
  const plain = (value: string) => value.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  let message = plain(turn.message);
  let explanation = plain(turn.explanation);
  const german = message.match(/\s*Deutsch:\s*(.+)$/i);
  if (german?.index !== undefined) {
    message = message.slice(0, german.index).trim();
    explanation = [plain(german[1]), explanation].filter(Boolean).join(" ");
  }
  return { message, correction: plain(turn.correction), explanation, newExample: plain(turn.newExample) };
}
