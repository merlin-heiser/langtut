import { useEffect, useState } from "react";
import type { Curriculum, CurriculumModule, Job, SessionPlan } from "@langtut/contracts";
import { api, post } from "./api.js";

type Status = { database: { reachable: boolean }; providers: Record<string, { configured?: boolean }>; anki: { reachable: boolean; dueReviews: number; error?: string } };
type Preview = { deck: { name: string; action: string }; models: Array<{ name: string; action: string; managed: boolean; fields: string[]; changes?: string[]; templates?: Record<string, unknown>; css?: string }> };
type Placement = { id: string; status: string; itemsAnswered: number; maxItems: number; recommendedModuleId?: string; weakTags: string[]; nextItem?: { id: string; prompt: string; level: string; kind: string; choices?: string[] } };
type TutorTurn = { message: string; correction: string; explanation: string; newExample: string };
type TutorReport = { focusTags: string[]; observedErrors: string[]; suggestedReviewItems: string[]; nextSessionSuggestions: string[] };
type TutorSession = { id: string; status: string; moduleId?: string };
type ApiCostSummary = { currency: "USD"; weekCost: number; totalCost: number; weekInputTokens: number; weekOutputTokens: number; totalInputTokens: number; totalOutputTokens: number; weekStartedAt: string; trackedSince: string | null; pricingVersion: string };

export function App() {
  const [status, setStatus] = useState<Status>();
  const [costs, setCosts] = useState<ApiCostSummary>();
  const [curriculum, setCurriculum] = useState<Curriculum>();
  const [plan, setPlan] = useState<SessionPlan>();
  const [preview, setPreview] = useState<Preview>();
  const [placement, setPlacement] = useState<Placement>();
  const [answer, setAnswer] = useState("");
  const [job, setJob] = useState<Job>();
  const [notice, setNotice] = useState("");
  const [session, setSession] = useState<TutorSession>();
  const [sessionInput, setSessionInput] = useState("");
  const [turns, setTurns] = useState<Array<{ learner: string; tutor: TutorTurn }>>([]);
  const [report, setReport] = useState<TutorReport>();
  const [screen, setScreen] = useState<"dashboard" | "settings">("dashboard");
  const [apiKeyDialog, setApiKeyDialog] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  const reload = async () => {
    const [nextStatus, nextCosts, nextCurriculum, latestPlacement, latestJob] = await Promise.all([
      api<Status>("/status"), api<ApiCostSummary>("/costs/summary"), api<Curriculum>("/curriculum"), api<Placement | null>("/placement-sessions/latest"), api<Job | null>("/jobs/latest"),
    ]);
    setStatus(nextStatus); setCosts(nextCosts); setCurriculum(nextCurriculum); setPlacement(latestPlacement ?? undefined);
    setJob(latestJob && latestJob.status !== "completed" ? latestJob : undefined);
  };
  const refreshCosts = async () => setCosts(await api<ApiCostSummary>("/costs/summary"));
  const handleError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/valid api key must be provided|API_KEY is not configured|api key/i.test(message)) {
      setApiKeyDialog(true);
      return;
    }
    setNotice(message);
  };
  useEffect(() => { reload().catch(handleError); }, []);
  useEffect(() => {
    if (!job || ["completed", "failed"].includes(job.status)) return;
    const timer = window.setInterval(async () => {
      const next = await api<Job>(`/jobs/${job.id}`);
      setJob(next);
      await refreshCosts();
      if (["completed", "failed"].includes(next.status)) {
        window.clearInterval(timer);
        await reload();
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [job]);

  const current = curriculum?.modules.find((module) => ["available", "preparing"].includes(module.status));
  const credited = curriculum?.modules.filter((module) => module.status === "credited").length ?? 0;
  const recoveredAnkiFailure = job?.status === "failed" && status?.anki.reachable && /Anki ist nicht erreichbar|valid api key/i.test(job.error ?? "");

  async function startPlacement() { try { setPlacement(await post<Placement>("/placement-sessions")); } catch (error) { handleError(error); } }
  async function submitAnswer(value = answer) {
    if (!placement?.nextItem || !value.trim()) return;
    try {
      const result = await post<Placement>(`/placement-sessions/${placement.id}/answers`, { itemId: placement.nextItem.id, answer: value });
      setPlacement(result); setAnswer(""); await refreshCosts();
    } catch (error) { handleError(error); }
  }
  async function chooseModule(moduleId: string) {
    if (!placement) return;
    setPlacement(await post<Placement>(`/placement-sessions/${placement.id}/override`, { moduleId }));
    await reload();
  }
  async function prepare(module: CurriculumModule) {
    setJob(await post<Job>(`/modules/${module.id}/prepare`));
  }
  async function startTutor() {
    const activePlan = plan ?? await post<SessionPlan>("/session-plans");
    setPlan(activePlan);
    setSession(await post<TutorSession>("/sessions", { planId: activePlan.id, moduleId: activePlan.primaryModuleId }));
    setTurns([]); setReport(undefined);
  }
  async function sendTurn() {
    if (!session || !sessionInput.trim()) return;
    const learner = sessionInput;
    const tutor = await post<TutorTurn>(`/sessions/${session.id}/turns`, { message: learner });
    setTurns((currentTurns) => [...currentTurns, { learner, tutor }]); setSessionInput(""); await refreshCosts();
  }
  async function completeTutor() {
    if (!session) return;
    setReport(await post<TutorReport>(`/sessions/${session.id}/complete`));
    setSession({ ...session, status: "completed" }); await refreshCosts();
  }
  async function recordMilestone(moduleId: string, milestoneId: string) {
    await post(`/modules/${moduleId}/milestones/${milestoneId}/attempt`);
    setNotice(`Aktiver Versuch für ${milestoneId} protokolliert.`);
    await reload();
  }

  async function saveApiKey() {
    if (!apiKey.trim()) return;
    setSavingKey(true);
    try {
      await post(`/settings/anki-api-key`, { apiKey });
      setApiKey(""); setApiKeyDialog(false); setNotice("API-Schlüssel gespeichert."); await reload();
    } catch (error) { handleError(error); } finally { setSavingKey(false); }
  }

  return <main>
    <header className="hero">
      <div><span className="eyebrow">SLOVENSKÝ TUTOR</span><h1>Dobrý deň.<br /><em>Čo dnes?</em></h1></div>
      <div className="hero-actions"><div className="pulse"><span className={status?.anki.reachable ? "dot on" : "dot"} />{status?.anki.reachable ? "Anki verbunden" : "Anki wartet"}</div><div className="cost-counters" title={costs?.trackedSince ? `Erfasst seit ${new Date(costs.trackedSince).toLocaleString("de-DE")}` : "Erfassung beginnt mit dem ersten neuen API-Aufruf"}><span><small>WOCHE</small><b>{formatUsd(costs?.weekCost)}</b></span><span><small>GESAMT</small><b>{formatUsd(costs?.totalCost)}</b></span></div><button className="settings-button" aria-label="Einstellungen öffnen" title="Einstellungen" onClick={() => setScreen(screen === "settings" ? "dashboard" : "settings")}>⚙</button></div>
    </header>

    {notice && <aside className="notice">{notice}</aside>}

    {screen === "settings" && <section className="settings-page"><div className="section-title"><span>⚙</span><h2>Einstellungen</h2></div><article className="settings-card"><div><small>ANKI CONNECT</small><h3>API-Schlüssel</h3><p>Der Schlüssel wird lokal gespeichert und nicht an die Oberfläche zurückgegeben.</p></div><div className="settings-form"><label>Anki-Connect-Schlüssel<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Optionaler Anki-Key" autoComplete="off" /></label><button className="primary" disabled={!apiKey.trim() || savingKey} onClick={() => saveApiKey()}>{savingKey ? "Speichert …" : "Schlüssel speichern"}</button></div></article></section>}

    {screen === "dashboard" && <><section className="today">
      <div className="section-title"><span>01</span><h2>Heute</h2></div>
      <div className="today-grid">
        <article className="mode-card">
          <small>SESSIONMODUS</small><strong>{plan?.mode ?? "NOCH OFFEN"}</strong>
          <p>{plan?.reasons[0] ?? "Der deterministische Planner entscheidet aus Reviewlast und Lernstand."}</p>
          <button disabled={placement?.status !== "completed"} onClick={() => post<SessionPlan>("/session-plans").then(setPlan).catch(handleError)}>Tag planen <span>→</span></button>
        </article>
        <article className="metric"><b>{status?.anki.dueReviews ?? "–"}</b><span>fällige Langtut-Reviews</span></article>
        <article className="metric"><b>{credited}</b><span>angerechnete Module</span></article>
        <article className="metric accent"><b>{current?.displayLevel ?? "–"}</b><span>{current?.title ?? "Placement ausstehend"}</span></article>
      </div>
    </section>

    <section>
      <div className="section-title"><span>02</span><h2>Einstieg</h2></div>
      {!placement && <article className="wide-card"><div><small>ADAPTIVES PLACEMENT</small><h3>Finde deinen sinnvollen Startpunkt.</h3><p>Bis zu 20 Aufgaben, früher Stopp bei stabiler Einstufung. Die Empfehlung bleibt überschreibbar.</p></div><button onClick={startPlacement}>Placement starten</button></article>}
      {placement?.status === "active" && <article className="placement"><div className="progress"><i style={{ width: `${placement.itemsAnswered / placement.maxItems * 100}%` }} /></div><small>{placement.nextItem?.level} · Aufgabe {placement.itemsAnswered + 1}</small><h3>{placement.nextItem?.prompt}</h3>{placement.nextItem?.choices?.length ? <div className="choices">{placement.nextItem.choices.map((choice) => <button key={choice} onClick={() => submitAnswer(choice)}>{choice}</button>)}</div> : <div className="answer"><input value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitAnswer()} placeholder="Antwort auf Slowakisch" /><button onClick={() => submitAnswer()}>Prüfen</button></div>}</article>}
      {placement?.status === "completed" && <article className="placement"><small>PLACEMENT ABGESCHLOSSEN · {placement.itemsAnswered} AUFGABEN</small><h3>{placement.recommendedModuleId}</h3><p>Schwache Bereiche: {placement.weakTags.join(", ") || "keine auffälligen Tags"}</p><label>Startmodul bewusst wählen<select value={placement.recommendedModuleId} onChange={(e) => chooseModule(e.target.value)}>{curriculum?.modules.map((module) => <option value={module.id} key={module.id}>{module.displayLevel} · {module.title}</option>)}</select></label></article>}
    </section>

    <section>
      <div className="section-title"><span>03</span><h2>Curriculum</h2></div>
      <div className="roadmap">{curriculum?.modules.map((module, index) => <article className={`module ${module.status}`} key={module.id}>
        <div className="module-index">{String(index + 1).padStart(2, "0")}</div><div><small>{module.displayLevel} · {module.status}</small><h3>{module.title}</h3><p>Ziel: {module.vocabTarget} Vokabeln · {module.grammarMilestones.length} Grammatikziele</p><div className="tags">{module.focusTags.map((tag) => <span key={tag}>{tag.replace(/^(topic_|func_|grammar_|case_|verb_|syntax_)/, "")}</span>)}</div>{module.status === "preparing" && <details className="milestones"><summary>Aktive Milestone-Aufgaben</summary>{module.grammarMilestones.map((milestone) => <button key={milestone.id} onClick={() => recordMilestone(module.id, milestone.id).catch(handleError)}>{milestone.description} · Versuch protokollieren</button>)}</details>}</div>
        {["available", "preparing"].includes(module.status) && <button className="prepare" disabled={placement?.status !== "completed" || (job?.moduleId === module.id && ["queued", "running"].includes(job.status))} onClick={() => prepare(module)}>{module.status === "preparing" ? "Vorbereitung fortsetzen" : "Vorbereiten"}</button>}
      </article>)}</div>
      {job && <aside className={`job ${job.status}`}><b>{recoveredAnkiFailure ? "Früherer Versuch fehlgeschlagen. Anki ist jetzt verbunden – Vorbereitung fortsetzen." : job.message}</b><div><i style={{ width: `${job.progress * 100}%` }} /></div>{job.error && !recoveredAnkiFailure && <p>{job.error}</p>}</aside>}
    </section>

    <section>
      <div className="section-title"><span>04</span><h2>Tutor-Session</h2></div>
      {!session && <article className="wide-card"><div><small>GEFÜHRTE PRAXIS</small><h3>Aktiv anwenden, gezielt korrigieren.</h3><p>Die Session nutzt den deterministischen Tagesplan. Das Modell sieht Lernziele und Verlauf, entscheidet aber nicht über Progression.</p></div><button disabled={placement?.status !== "completed"} onClick={() => startTutor().catch(handleError)}>Session starten</button></article>}
      {session && <article className="tutor"><div className="dialogue">{turns.length === 0 && <p className="empty">Schreibe deinen ersten slowakischen Satz.</p>}{turns.map((turn, index) => <div className="exchange" key={index}><p className="learner">{turn.learner}</p><div className="tutor-answer"><b>{turn.tutor.message}</b>{turn.tutor.correction && <p>Korrektur: {turn.tutor.correction}</p>}{turn.tutor.explanation && <small>{turn.tutor.explanation}</small>}</div></div>)}</div>{session.status === "active" && <><div className="answer"><input value={sessionInput} onChange={(e) => setSessionInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendTurn()} placeholder="Napíš niečo po slovensky …" /><button onClick={() => sendTurn().catch(handleError)}>Senden</button></div><button className="finish" onClick={() => completeTutor().catch(handleError)}>Session abschließen</button></>}{report && <div className="report"><small>SESSIONBERICHT</small><h3>Beobachtete Lernsignale</h3><p>{report.observedErrors.join(" · ") || "Keine belastbaren Fehler beobachtet."}</p><div className="tags">{report.focusTags.map((tag) => <span key={tag}>{tag}</span>)}</div><p>Nächster Schritt: {report.nextSessionSuggestions.join(" · ")}</p></div>}</article>}
    </section>

    <section>
      <div className="section-title"><span>05</span><h2>Einrichtung</h2></div>
      <article className="setup"><div><h3>Anki-Modelle</h3><p>Beim Vorbereiten des ersten Moduls richtet Langtut seine eigenen Modelle automatisch ein. Der optionale Diff zeigt vorab Felder, Karten und CSS; fremde Modelle bleiben unangetastet.</p></div><div className="setup-actions"><button onClick={() => post<Preview>("/integrations/anki/setup/preview").then(setPreview).catch(handleError)}>Optionalen Diff ansehen</button>{preview && preview.models.some(({ action }) => action !== "none") && <button className="primary" onClick={() => post<Preview>("/integrations/anki/setup/apply", { confirm: true }).then(setPreview).catch(handleError)}>Jetzt sicher einrichten</button>}</div></article>
      {preview && <div className="diff"><p>Deck <b>{preview.deck.name}</b>: {setupActionLabel(preview.deck.action)}</p>{preview.models.map((model) => <details key={model.name} open={model.action !== "none"}><summary>{model.name}: <b>{setupActionLabel(model.action)}</b> {model.changes?.join(" · ")}</summary><p>Felder: {model.fields.join(", ")}</p><p>Templates: {Object.keys(model.templates ?? {}).join(", ")}</p><pre>{model.css}</pre></details>)}</div>}
    </section></>}

    {apiKeyDialog && <div className="modal-backdrop" role="presentation"><div className="api-key-modal" role="dialog" aria-modal="true" aria-labelledby="api-key-title"><button className="modal-close" aria-label="Dialog schließen" onClick={() => setApiKeyDialog(false)}>×</button><small>ANKI CONNECT-AUTHENTIFIZIERUNG</small><h2 id="api-key-title">Anki-API-Key angeben</h2><p>Anki Connect verlangt für diese Funktion einen gültigen API-Key. Du kannst ihn hier hinterlegen oder später in den Einstellungen ändern.</p><div className="settings-form"><label>Anki-Connect-Schlüssel<input autoFocus type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveApiKey()} placeholder="Anki-Connect-Key" autoComplete="off" /></label><div className="modal-actions"><button onClick={() => setApiKeyDialog(false)}>Später</button><button className="primary" disabled={!apiKey.trim() || savingKey} onClick={() => saveApiKey()}>{savingKey ? "Speichert …" : "Speichern"}</button></div></div></div></div>}
    <footer><span>Langtut / lokale Lernumgebung</span><span>Curriculum {curriculum?.version}</span></footer>
  </main>;
}

function setupActionLabel(action: string) {
  return ({ none: "bereit", create: "wird angelegt", update: "wird aktualisiert", conflict: "Konflikt – bleibt unverändert" } as Record<string, string>)[action] ?? action;
}

function formatUsd(value?: number) {
  if (value === undefined) return "–";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(value);
}
