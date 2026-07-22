import { useEffect, useState } from "react";
import type { Curriculum, CurriculumModule, Job, LexiconLookupResult, LexiconSenseCandidate, SessionPlan } from "@langtut/contracts";
import type { ActivityTurnView as ActivityTurn, ActivityView as Activity, ApiCostSummary, LearningPackageView as LearningPackage, LocalMtSettings, ModuleProgress, PackageShelf, PlacementView as Placement, RuntimeSettings as Settings, RuntimeStatus as Status, SetupPreview as Preview, TutorReportView as TutorReport, TutorSessionView as TutorSession } from "@langtut/runtime";
import { client } from "./api.js";
import { nativeGoogleDrive } from "./native-google-drive.js";
import { readGoogleOAuthClientFile } from "./google-oauth.js";

type ModelSettingsResponse = Pick<Settings, "models">;
type ConversationExchange = { id: string; learner: string; responses: ActivityTurn[]; status: "pending" | "complete" };

export function App() {
  const [status, setStatus] = useState<Status>();
  const [costs, setCosts] = useState<ApiCostSummary>();
  const [curriculum, setCurriculum] = useState<Curriculum>();
  const [moduleProgress, setModuleProgress] = useState<ModuleProgress["modules"]>({});
  const [plan, setPlan] = useState<SessionPlan>();
  const [preview, setPreview] = useState<Preview>();
  const [placement, setPlacement] = useState<Placement>();
  const [answer, setAnswer] = useState("");
  const [job, setJob] = useState<Job>();
  const [notice, setNotice] = useState("");
  const [session, setSession] = useState<TutorSession>();
  const [sessionInput, setSessionInput] = useState("");
  const [turns, setTurns] = useState<ConversationExchange[]>([]);
  const [sending, setSending] = useState(false);
  const [report, setReport] = useState<TutorReport>();
  const [screen, setScreen] = useState<"dashboard" | "settings">("dashboard");
  const [apiKeyDialog, setApiKeyDialog] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [providerKeys, setProviderKeys] = useState({ openai: "", gemini: "" });
  const [savingProvider, setSavingProvider] = useState<"openai" | "gemini">();
  const [settings, setSettings] = useState<Settings>();
  const [savingModels, setSavingModels] = useState(false);
  const [savingLocalMt, setSavingLocalMt] = useState(false);
  const [installingLocalMt, setInstallingLocalMt] = useState<string>();
  const [packageShelf, setPackageShelf] = useState<PackageShelf>();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activityId, setActivityId] = useState<string>();
  const [importingPackage, setImportingPackage] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [googleClientId, setGoogleClientId] = useState("");
  const [importingGoogleOAuth, setImportingGoogleOAuth] = useState(false);

  const reload = async () => {
    const [nextStatus, nextCosts, nextCurriculum, nextModuleProgress, latestPlacement, latestJob, nextSettings, nextPackages, nextActivities] = await Promise.all([
      client.status(), client.costs(), client.curriculum(), client.moduleProgress(), client.latestPlacement(), client.latestJob(), client.settings(), client.packages(), client.activities(),
    ]);
    setStatus(nextStatus); setCosts(nextCosts); setCurriculum(nextCurriculum); setPlacement(latestPlacement ?? undefined);
    setModuleProgress(nextModuleProgress.modules);
    setJob(latestJob && latestJob.status !== "completed" ? latestJob : undefined);
    setSettings(nextSettings);
    setPackageShelf(nextPackages); setActivities(nextActivities.activities); setActivityId((selected) => nextActivities.activities.some(({ id }) => id === selected) ? selected : nextActivities.activities[0]?.id);
  };
  const refreshCosts = async () => setCosts(await client.costs());
  const handleError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/valid api key must be provided|anki.?connect.*api.?key/i.test(message)) {
      setApiKeyDialog(true);
      return;
    }
    setNotice(message);
  };
  useEffect(() => { reload().catch(handleError); }, []);
  useEffect(() => {
    if (!job || ["completed", "failed"].includes(job.status)) return;
    const timer = window.setInterval(async () => {
      const next = await client.job(job.id);
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
  const availableActivities = current?.activityIds?.length ? activities.filter(({ id }) => current.activityIds?.includes(id)) : activities;
  const credited = curriculum?.modules.filter((module) => module.status === "credited").length ?? 0;
  const recoveredAnkiFailure = job?.status === "failed" && status?.anki.reachable && /Anki ist nicht erreichbar|valid api key/i.test(job.error ?? "");

  async function startPlacement() { try { setPlacement(await client.startPlacement()); } catch (error) { handleError(error); } }
  async function submitAnswer(value = answer) {
    if (!placement?.nextItem || !value.trim()) return;
    try {
      const result = await client.answerPlacement(placement.id, placement.nextItem.id, value);
      setPlacement(result); setAnswer(""); await refreshCosts();
    } catch (error) { handleError(error); }
  }
  async function chooseModule(moduleId: string) {
    if (!placement) return;
    setPlacement(await client.overridePlacement(placement.id, moduleId));
    await reload();
  }
  async function prepare(module: CurriculumModule) {
    setJob(await client.prepareModule(module.id));
  }
  async function startTutor() {
    const activePlan = plan ?? await client.createSessionPlan();
    setPlan(activePlan);
    const selectedActivityId = availableActivities.some(({ id }) => id === activityId) ? activityId : availableActivities[0]?.id;
    setSession(await client.startSession({ planId: activePlan.id, moduleId: activePlan.primaryModuleId ?? undefined, activityId: selectedActivityId }));
    setTurns([]); setReport(undefined); setSending(false); setSessionInput("");
  }
  async function sendTurn() {
    const learner = sessionInput.trim();
    if (!session || !learner || sending || session.status !== "active") return;
    const exchangeId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setSessionInput("");
    setSending(true);
    setTurns((currentTurns) => [...currentTurns, { id: exchangeId, learner, responses: [], status: "pending" }]);
    try {
      const result = await client.activityTurn(session.id, learner);
      setTurns((currentTurns) => currentTurns.map((turn) => turn.id === exchangeId ? { ...turn, responses: result.turns, status: "complete" } : turn));
      if (result.completed) {
        setSession((currentSession) => currentSession ? { ...currentSession, status: "completed" } : currentSession);
        setReport(result.report);
      }
      void refreshCosts().catch(handleError);
    } catch (error) {
      setTurns((currentTurns) => currentTurns.filter((turn) => turn.id !== exchangeId));
      setSessionInput((currentInput) => currentInput || learner);
      handleError(error);
    } finally {
      setSending(false);
    }
  }
  async function recordMilestone(moduleId: string, milestoneId: string) {
    await client.recordMilestone(moduleId, milestoneId);
    setNotice(`Aktiver Versuch für ${milestoneId} protokolliert.`);
    await reload();
  }

  async function saveApiKey() {
    if (!apiKey.trim()) return;
    setSavingKey(true);
    try {
      await client.saveAnkiKey(apiKey);
      setApiKey(""); setApiKeyDialog(false); setNotice("API-Schlüssel gespeichert."); await reload();
    } catch (error) { handleError(error); } finally { setSavingKey(false); }
  }

  async function saveProviderKey(provider: "openai" | "gemini") {
    const apiKey = providerKeys[provider].trim(); if (!apiKey) return;
    setSavingProvider(provider);
    try { await client.saveProviderKey(provider, apiKey); setProviderKeys((current) => ({ ...current, [provider]: "" })); setNotice(`${provider === "openai" ? "OpenAI" : "Gemini"}-Schlüssel lokal gespeichert.`); await reload(); }
    catch (error) { handleError(error); } finally { setSavingProvider(undefined); }
  }

  async function saveModels(selection: Settings["models"]["selection"]) {
    setSavingModels(true);
    try {
      const result: ModelSettingsResponse = await client.saveModels(selection);
      if (settings) setSettings({ ...settings, models: result.models });
      setNotice("Modellauswahl gespeichert.");
    } catch (error) { handleError(error); } finally { setSavingModels(false); }
  }

  async function saveLocalMt(selection: Pick<LocalMtSettings, "enabled" | "cloudFallback">) {
    setSavingLocalMt(true);
    try {
      const result = await client.saveLocalMt(selection);
      if (settings) setSettings({ ...settings, localMt: result.localMt });
      setNotice("Lokale Übersetzungseinstellungen gespeichert.");
    } catch (error) { handleError(error); } finally { setSavingLocalMt(false); }
  }

  async function installLocalMt(key: string) {
    setInstallingLocalMt(key);
    try {
      const result = await client.installLocalMt(key);
      if (settings) setSettings({ ...settings, localMt: result.localMt });
      setNotice("Lokales Übersetzungsmodell installiert.");
    } catch (error) { handleError(error); } finally { setInstallingLocalMt(undefined); }
  }
  async function syncNow() {
    setSyncing(true); try { const sync = await client.syncNow(); if (settings) setSettings({ ...settings, sync }); setNotice(sync.error ?? "Google Drive abgeglichen."); }
    catch (error) { handleError(error); } finally { setSyncing(false); }
  }
  async function connectGoogle() {
    try {
      if (nativeGoogleDrive.available()) {
        const { accessToken } = await nativeGoogleDrive.signIn();
        const sync = await client.acceptGoogleToken(accessToken);
        if (settings) setSettings({ ...settings, sync });
        setNotice("Google Drive verbunden."); return;
      }
      const clientId = googleClientId.trim() || settings?.sync?.googleOAuthClientId;
      if (!clientId) { setNotice("Bitte zuerst die OAuth-Client-ID aus der Google Cloud Console eintragen."); return; }
      await client.configureGoogle({ clientId });
      await client.authorizeGoogle();
    } catch (error) { handleError(error); }
  }
  async function importGoogleOAuth(file?: File) {
    if (!file) return;
    setImportingGoogleOAuth(true);
    try {
      const oauth = await readGoogleOAuthClientFile(file);
      await client.configureGoogle(oauth);
      setGoogleClientId(oauth.clientId);
      setSettings((current) => current ? { ...current, sync: { ...(current.sync ?? { connected: false, pendingEvents: 0 }), configured: true, googleOAuthClientId: oauth.clientId } } : current);
      setNotice("Google-OAuth-Konfiguration importiert. Nur die Client-ID wurde übernommen.");
    } catch (error) { handleError(error); }
    finally { setImportingGoogleOAuth(false); }
  }

  async function activatePackage(id: string) {
    try { await client.activatePackage(id); setPlan(undefined); setSession(undefined); setTurns([]); setReport(undefined); setPlacement(undefined); await reload(); }
    catch (error) { handleError(error); }
  }
  async function importPackage(file?: File) {
    if (!file) return; setImportingPackage(true);
    try { await client.importPackage(file); setNotice("Lernpaket installiert."); await reload(); }
    catch (error) { handleError(error); } finally { setImportingPackage(false); }
  }

  const activePackage = packageShelf?.packages.find(({ active }) => active);

  return <main>
    <header className="hero">
      <div><span className="eyebrow">LANGTUT · LERNPAKET-PLAYER</span><h1>{activePackage?.targetLanguage.name ?? "Sprache"}.<br /><em>{activePackage?.sourceLanguage.name ?? "Lernen"}.</em></h1></div>
      <div className="hero-actions"><div className="pulse"><span className={status?.anki.reachable ? "dot on" : "dot"} />{status?.anki.reachable ? "Anki verbunden" : "Anki wartet"}</div><div className="cost-counters" title={costs?.trackedSince ? `Erfasst seit ${new Date(costs.trackedSince).toLocaleString("de-DE")}` : "Erfassung beginnt mit dem ersten neuen API-Aufruf"}><span><small>WOCHE</small><b>{formatUsd(costs?.weekCost)}</b></span><span><small>GESAMT</small><b>{formatUsd(costs?.totalCost)}</b></span></div><button className="settings-button" aria-label="Einstellungen öffnen" title="Einstellungen" onClick={() => setScreen(screen === "settings" ? "dashboard" : "settings")}>⚙</button></div>
    </header>

    {notice && <aside className="notice">{notice}</aside>}
    {screen === "settings" && !settings?.sync?.connected && <section className="settings-card"><div><small>GOOGLE OAUTH</small><h3>Google Drive verbinden</h3><p>{nativeGoogleDrive.available() ? "Android verwendet die native Google-Kontoauswahl. Es wird keine OAuth-Datei und kein Langtut-Server benötigt." : "Eine Google-OAuth-JSON-Datei kann importiert werden. Langtut übernimmt daraus nur die Client-ID; das Client-Secret bleibt lokal."}</p></div><div className="settings-form">{!nativeGoogleDrive.available() && <><label>OAuth Client-ID<input value={googleClientId} onChange={(event) => setGoogleClientId(event.target.value)} placeholder={settings?.sync?.googleOAuthClientId ?? "…apps.googleusercontent.com"} autoComplete="off" /></label><label>OAuth-JSON importieren<input type="file" accept="application/json,.json" disabled={importingGoogleOAuth} onChange={(event) => { void importGoogleOAuth(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label></>}<button className="primary" onClick={() => void connectGoogle()}>Mit Google verbinden</button></div></section>}

    {screen === "settings" && <section className="settings-page">
      <div className="section-title"><span>⚙</span><h2>Einstellungen</h2></div>
      <article className="settings-card"><div><small>GOOGLE DRIVE</small><h3>Lernstand synchronisieren</h3><p>{settings?.sync?.connected ? `Verbunden · ${settings.sync.pendingEvents} lokale Änderungen ausstehend${settings.sync.lastSyncAt ? ` · letzter Abgleich ${new Date(settings.sync.lastSyncAt).toLocaleString("de-DE")}` : ""}` : "Die Google-Anmeldung erfolgt über den Systembrowser. Drive speichert nur Langtut-Ereignisse im privaten App-Datenbereich."}</p>{settings?.sync?.error && <p className="runtime-warning">{settings.sync.error}</p>}</div><div className="settings-form"><button className="primary" disabled={!settings?.sync?.configured || syncing} onClick={() => void syncNow()}>{syncing ? "Gleicht ab …" : "Jetzt abgleichen"}</button></div></article>
      <article className="settings-card"><div><small>LLM-DIENSTE</small><h3>Provider-Schlüssel</h3><p>Schlüssel bleiben im lokalen Plattform-Speicher und werden nie an JavaScript oder Drive zurückgegeben.</p></div><div className="settings-form"><label>OpenAI-Schlüssel<input type="password" value={providerKeys.openai} onChange={(event) => setProviderKeys({ ...providerKeys, openai: event.target.value })} autoComplete="off" /></label><button className="primary" disabled={!providerKeys.openai.trim() || savingProvider === "openai"} onClick={() => void saveProviderKey("openai")}>OpenAI speichern</button><label>Gemini-Schlüssel<input type="password" value={providerKeys.gemini} onChange={(event) => setProviderKeys({ ...providerKeys, gemini: event.target.value })} autoComplete="off" /></label><button className="primary" disabled={!providerKeys.gemini.trim() || savingProvider === "gemini"} onClick={() => void saveProviderKey("gemini")}>Gemini speichern</button></div></article>
      {settings?.anki.mode !== "ankidroid" && <article className="settings-card"><div><small>ANKI CONNECT</small><h3>API-Schlüssel</h3><p>Der Schlüssel wird lokal gespeichert und nicht an die Oberfläche zurückgegeben.</p></div><div className="settings-form"><label>Anki-Connect-Schlüssel<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Optionaler Anki-Key" autoComplete="off" /></label><button className="primary" disabled={!apiKey.trim() || savingKey} onClick={() => saveApiKey()}>{savingKey ? "Speichert …" : "Schlüssel speichern"}</button></div></article>}
      <article className="settings-card model-settings"><div><small>MODELLWAHL</small><h3>Günstiger starten</h3><p>Wähle je Provider ein Modell. Die Auswahl gilt sofort für alle Aufgaben dieses Providers und wird lokal gespeichert.</p></div><div className="settings-form">{settings?.models && <><label>OpenAI-Modell<select value={settings.models.selection.openai} onChange={(e) => setSettings({ ...settings, models: { ...settings.models, selection: { ...settings.models.selection, openai: e.target.value } } })}>{settings.models.choices.openai.map((model) => <option key={model}>{model}</option>)}</select></label><label>Gemini-Modell<select value={settings.models.selection.gemini} onChange={(e) => setSettings({ ...settings, models: { ...settings.models, selection: { ...settings.models.selection, gemini: e.target.value } } })}>{settings.models.choices.gemini.map((model) => <option key={model}>{model}</option>)}</select></label><button className="primary" disabled={savingModels} onClick={() => saveModels(settings.models.selection)}>{savingModels ? "Speichert …" : "Modellauswahl speichern"}</button></>}</div></article>
      {settings?.localMt && <LocalMtSettingsCard value={settings.localMt} saving={savingLocalMt} installing={installingLocalMt} onChange={(localMt) => setSettings({ ...settings, localMt })} onSave={saveLocalMt} onInstall={installLocalMt} />}
    </section>}

    {screen === "dashboard" && <><section className="package-shelf">
      <div className="section-title"><span>00</span><h2>Paketablage</h2></div>
      <div className="package-grid">{packageShelf?.packages.map((pkg) => <article className={`package-card ${pkg.active ? "active" : ""}`} key={pkg.id}><small>{pkg.targetLanguage.name} → {pkg.sourceLanguage.name}</small><h3>{pkg.name}</h3><p>Version {pkg.version} · {pkg.progress.completed}/{pkg.progress.total} Module erschlossen{pkg.capabilities.activities ? " · eigene Lernmethoden" : ""}</p><button disabled={pkg.active} onClick={() => activatePackage(pkg.id)}>{pkg.active ? "Eingelegt" : "Einlegen"}</button></article>)}</div>
      <label className="package-upload">{importingPackage ? "Installiert …" : "Lernpaket als ZIP hinzufügen"}<input type="file" accept=".zip,application/zip" disabled={importingPackage} onChange={(event) => { const file = event.target.files?.[0]; void importPackage(file); event.target.value = ""; }} /></label>
    </section><section className="today">
      <div className="section-title"><span>01</span><h2>Heute</h2></div>
      <div className="today-grid">
        <article className="mode-card">
          <small>SESSIONMODUS</small><strong>{plan?.mode ?? "NOCH OFFEN"}</strong>
          <p>{plan?.reasons[0] ?? "Der deterministische Planner entscheidet aus Reviewlast und Lernstand."}</p>
          <button disabled={placement?.status !== "completed"} onClick={() => client.createSessionPlan().then(setPlan).catch(handleError)}>Tag planen <span>→</span></button>
        </article>
        <article className="metric"><b>{status?.anki.dueReviews ?? "–"}</b><span>fällige Langtut-Reviews</span></article>
        <article className="metric"><b>{credited}</b><span>angerechnete Module</span></article>
        <article className="metric accent"><b>{current?.displayLevel ?? "–"}</b><span>{current?.title ?? "Placement ausstehend"}</span></article>
      </div>
    </section>

    <section>
      <div className="section-title"><span>02</span><h2>Einstieg</h2></div>
      {!placement && <article className="wide-card"><div><small>ADAPTIVES PLACEMENT</small><h3>Finde deinen sinnvollen Startpunkt.</h3><p>Bis zu 20 Aufgaben, früher Stopp bei stabiler Einstufung. Die Empfehlung bleibt überschreibbar.</p></div><button onClick={startPlacement}>Placement starten</button></article>}
      {placement?.status === "active" && <article className="placement"><div className="progress"><i style={{ width: `${placement.itemsAnswered / placement.maxItems * 100}%` }} /></div><small>{placement.nextItem?.level} · Aufgabe {placement.itemsAnswered + 1}</small><h3>{placement.nextItem?.prompt}</h3>{placement.nextItem?.choices?.length ? <div className="choices">{placement.nextItem.choices.map((choice) => <button key={choice} onClick={() => submitAnswer(choice)}>{choice}</button>)}</div> : <div className="answer"><input value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitAnswer()} placeholder={`Antwort auf ${activePackage?.targetLanguage.name ?? "der Zielsprache"}`} /><button onClick={() => submitAnswer()}>Prüfen</button></div>}</article>}
      {placement?.status === "completed" && <article className="placement"><small>PLACEMENT ABGESCHLOSSEN · {placement.itemsAnswered} AUFGABEN</small><h3>{placement.recommendedModuleId}</h3><p>Schwache Bereiche: {placement.weakTags.join(", ") || "keine auffälligen Tags"}</p><label>Startmodul bewusst wählen<select value={placement.recommendedModuleId} onChange={(e) => chooseModule(e.target.value)}>{curriculum?.modules.map((module) => <option value={module.id} key={module.id}>{module.displayLevel} · {module.title}</option>)}</select></label></article>}
    </section>

    <section>
      <div className="section-title"><span>03</span><h2>Curriculum</h2></div>
      <div className="roadmap">{curriculum?.modules.map((module, index) => {
        const progress = moduleProgress[module.id];
        const milestoneWorkReady = module.status === "preparing" && progress?.materialPrepared;
        const attempted = new Set(progress?.attemptedMilestoneIds ?? []);
        const pendingMilestones = module.grammarMilestones.filter(({ id }) => !attempted.has(id));
        return <article className={`module ${module.status}`} key={module.id}>
          <div className="module-index">{String(index + 1).padStart(2, "0")}</div><div><small>{module.displayLevel} · {module.status}</small><h3>{module.title}</h3><p>Ziel: {module.vocabTarget} Vokabeln · {module.grammarMilestones.length} Grammatikziele</p><div className="tags">{module.focusTags.map((tag) => <span key={tag}>{tag.replace(/^(topic_|func_|grammar_|case_|verb_|syntax_)/, "")}</span>)}</div>{milestoneWorkReady && <details className="milestones" open><summary>Milestone-Aufgaben · {pendingMilestones.length} offen</summary>{pendingMilestones.map((milestone) => <button key={milestone.id} onClick={() => recordMilestone(module.id, milestone.id).catch(handleError)}>{milestone.description} · Versuch protokollieren</button>)}</details>}</div>
          {(module.status === "available" || (module.status === "preparing" && !progress?.materialPrepared)) && <button className="prepare" disabled={placement?.status !== "completed" || (job?.moduleId === module.id && ["queued", "running"].includes(job.status))} onClick={() => prepare(module)}>{module.status === "preparing" ? "Vorbereitung fortsetzen" : "Vorbereiten"}</button>}
        </article>;
      })}</div>
      {job && <aside className={`job ${job.status}`}><b>{recoveredAnkiFailure ? "Früherer Versuch fehlgeschlagen. Anki ist jetzt verbunden – Vorbereitung fortsetzen." : job.message}</b><div><i style={{ width: `${job.progress * 100}%` }} /></div>{job.error && !recoveredAnkiFailure && <p>{job.error}</p>}</aside>}
    </section>

    <section>
      <div className="section-title"><span>04</span><h2>Tutor-Session</h2></div>
      {!session && <article className="wide-card"><div><small>GEFÜHRTE PRAXIS</small><h3>Aktiv anwenden, gezielt korrigieren.</h3><p>Das Lernpaket bestimmt Rollen und Ablauf; der Player führt die Methode sicher aus.</p>{availableActivities.length > 0 && <label className="activity-picker">Lernmethode<select value={availableActivities.some(({ id }) => id === activityId) ? activityId : availableActivities[0]?.id} onChange={(event) => setActivityId(event.target.value)}>{availableActivities.map((activity) => <option key={activity.id} value={activity.id}>{activity.title} · {activity.roles.length} Rollen</option>)}</select></label>}</div><button disabled={placement?.status !== "completed"} onClick={() => startTutor().catch(handleError)}>Session starten</button></article>}
      {session && <article className="tutor">
        {session.activity?.type === "roleplay" && <div className="scenario"><small>ROLLENSPIEL</small><h3>{session.activity.title}</h3><p lang={activePackage?.targetLanguage.code}>{session.activity.scenarioTarget}</p><details><summary>Deutsche Erklärung anzeigen</summary><p lang={activePackage?.sourceLanguage.code}>{session.activity.scenarioSource}</p></details></div>}
        <div className="dialogue" aria-busy={sending}>
          {session.initialTurns?.map((response) => <PartnerMessage response={response} sessionId={session.id} targetLanguageCode={activePackage?.targetLanguage.code} sourceLanguageCode={activePackage?.sourceLanguage.code} key={response.roleId} />)}
          {turns.length === 0 && !(session.initialTurns?.length) && <p className="empty">Schreibe deinen ersten Satz auf {activePackage?.targetLanguage.name ?? "der Zielsprache"}.</p>}
          {turns.map((turn) => <div className="turn-stack" key={turn.id}>
            <LearnerMessage message={turn.learner} responses={turn.responses} />
            {turn.status === "pending" ? <TypingIndicator /> : turn.responses.map((response) => <PartnerMessage response={response} sessionId={session.id} targetLanguageCode={activePackage?.targetLanguage.code} sourceLanguageCode={activePackage?.sourceLanguage.code} key={response.roleId} />)}
          </div>)}
        </div>
        {session.status === "active" ? <>
          <div className="answer chat-input">
            <input disabled={sending} value={sessionInput} onChange={(e) => setSessionInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && sendTurn()} placeholder={sending ? "Antwort wird geschrieben …" : `Nachricht auf ${activePackage?.targetLanguage.name ?? "der Zielsprache"} …`} />
            <button disabled={sending || !sessionInput.trim()} onClick={() => sendTurn()}>{sending ? "Sendet …" : "Senden"}</button>
          </div>
          <p className="closing-hint">Verabschiede dich situationsgerecht, wenn du das Gespräch früher beenden möchtest.</p>
        </> : <div className="answer chat-input completed-input"><input disabled placeholder="Konversation abgeschlossen" /><button disabled>Senden</button></div>}
        {report && <div className="report"><small>SESSIONBERICHT</small><h3>Beobachtete Lernsignale</h3><p className="goal-score">Lernzielerfüllung: <b>{report.goalCompletionPercent}%</b>{report.languageSwitches > 0 && <> · Sprachwechsel: <b>{report.languageSwitches}</b></>}</p><p>{report.observedErrors.join(" · ") || "Keine belastbaren Fehler beobachtet."}</p>{report.observedStrengths.length > 0 && <p>Stärken: {report.observedStrengths.join(" · ")}</p>}<div className="tags">{report.focusTags.map((tag) => <span key={tag}>{tag}</span>)}</div><p>Nächster Schritt: {report.nextSessionSuggestions.join(" · ")}</p></div>}
      </article>}
    </section>

    <section>
      <div className="section-title"><span>05</span><h2>Einrichtung</h2></div>
      <article className="setup"><div><h3>Anki-Modelle</h3><p>Beim Vorbereiten des ersten Moduls richtet Langtut seine eigenen Modelle automatisch ein. Der optionale Diff zeigt vorab Felder, Karten und CSS; fremde Modelle bleiben unangetastet.</p></div><div className="setup-actions"><button onClick={() => client.previewAnkiSetup().then(setPreview).catch(handleError)}>Optionalen Diff ansehen</button>{preview && preview.models.some(({ action }) => action !== "none") && <button className="primary" onClick={() => client.applyAnkiSetup().then(setPreview).catch(handleError)}>Jetzt sicher einrichten</button>}</div></article>
      {preview && <div className="diff"><p>Deck <b>{preview.deck.name}</b>: {setupActionLabel(preview.deck.action)}</p>{preview.models.map((model) => <details key={model.name} open={model.action !== "none"}><summary>{model.name}: <b>{setupActionLabel(model.action)}</b> {model.changes?.join(" · ")}</summary><p>Felder: {model.fields.join(", ")}</p><p>Templates: {Object.keys(model.templates ?? {}).join(", ")}</p><pre>{model.css}</pre></details>)}</div>}
    </section></>}

    {apiKeyDialog && <div className="modal-backdrop" role="presentation"><div className="api-key-modal" role="dialog" aria-modal="true" aria-labelledby="api-key-title"><button className="modal-close" aria-label="Dialog schließen" onClick={() => setApiKeyDialog(false)}>×</button><small>ANKI CONNECT-AUTHENTIFIZIERUNG</small><h2 id="api-key-title">Anki-API-Key angeben</h2><p>Anki Connect verlangt für diese Funktion einen gültigen API-Key. Du kannst ihn hier hinterlegen oder später in den Einstellungen ändern.</p><div className="settings-form"><label>Anki-Connect-Schlüssel<input autoFocus type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveApiKey()} placeholder="Anki-Connect-Key" autoComplete="off" /></label><div className="modal-actions"><button onClick={() => setApiKeyDialog(false)}>Später</button><button className="primary" disabled={!apiKey.trim() || savingKey} onClick={() => saveApiKey()}>{savingKey ? "Speichert …" : "Speichern"}</button></div></div></div></div>}
    <footer><span>Langtut / Lernpaket-Player</span><span>{activePackage?.name} · Curriculum {curriculum?.version}</span></footer>
  </main>;
}

function LocalMtSettingsCard({ value, saving, installing, onChange, onSave, onInstall }: {
  value: LocalMtSettings; saving: boolean; installing?: string;
  onChange: (value: LocalMtSettings) => void;
  onSave: (value: Pick<LocalMtSettings, "enabled" | "cloudFallback">) => Promise<void>;
  onInstall: (key: string) => Promise<void>;
}) {
  const runtime = value.status?.runtime;
  return <article className="settings-card local-mt-settings"><div><small>LOKALE ÜBERSETZUNG</small><h3>Weniger API-Aufrufe</h3><p>Installierte Modelle übersetzen ausgewählte Wörter lokal. Ergebnisse bleiben bis zur bestehenden Qualitätsprüfung als ungeprüft markiert.</p><p className={runtime?.available ? "runtime-ok" : "runtime-warning"}>{runtime?.available ? "Python-Laufzeit bereit" : runtime?.error ?? "Laufzeitstatus unbekannt"}</p></div><div className="settings-form"><label className="toggle-row"><input type="checkbox" disabled={!runtime?.available} checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} />Lokale Übersetzung aktivieren</label><label className="toggle-row"><input type="checkbox" disabled={!runtime?.available} checked={value.cloudFallback} onChange={(event) => onChange({ ...value, cloudFallback: event.target.checked })} />Cloud-Fallback bei fehlendem oder fehlerhaftem Modell</label><button className="primary" disabled={saving || !runtime?.available} onClick={() => onSave(value)}>{saving ? "Speichert …" : "Einstellung speichern"}</button><div className="local-model-list">{value.status?.models?.map((model) => <div className="local-model" key={model.key}><div><b>{model.key}</b><small>{model.family} · {formatBytes(model.sizeBytes)} · {model.license}</small><small>{model.sourceLanguages.join(", ")} → {model.targetLanguages.join(", ")} · Revision {model.revision.slice(0, 8)}</small>{model.error && <small className="runtime-warning">{model.error}</small>}</div><button disabled={model.status === "installed" || installing === model.key || !runtime?.available} onClick={() => onInstall(model.key)}>{model.status === "installed" ? "Installiert" : installing === model.key ? "Installiert …" : "Installieren"}</button></div>)}</div></div></article>;
}

function PartnerMessage({ response, sessionId, targetLanguageCode, sourceLanguageCode }: { response: ActivityTurn; sessionId: string; targetLanguageCode?: string; sourceLanguageCode?: string }) {
  const [lookup, setLookup] = useState<{ surface: string; result?: LexiconLookupResult; loading?: boolean; saved?: boolean }>();
  const segments = segmentWords(response.turn.message, targetLanguageCode);
  async function inspect(surface: string) {
    if (!targetLanguageCode || !sourceLanguageCode) return;
    setLookup({ surface, loading: true });
    try {
      const result = await client.lookupLexicon({ text: response.turn.message, surface, targetLanguageCode, sourceLanguageCode, sessionId });
      setLookup({ surface, result });
    } catch { setLookup({ surface, result: { status: "not_found", surface, candidates: [] } }); }
  }
  async function remember(candidate: LexiconSenseCandidate) {
    if (!targetLanguageCode || !sourceLanguageCode || !lookup) return;
    await client.stageLexicon({ sessionId, senseId: candidate.senseId, surface: lookup.surface, lemma: candidate.lemma, pos: candidate.pos, translation: candidate.translation, context: response.turn.message, targetLanguageCode, sourceLanguageCode, origin: candidate.origin });
    setLookup({ ...lookup, saved: true });
  }
  return <div className="message-row partner-row"><small className="message-label">{response.roleLabel}</small><div className="message-bubble partner-bubble lookup-bubble">{segments.map((segment) => segment.isWord ? <button className="lookup-word" key={segment.index} onClick={() => void inspect(segment.text)}>{segment.text}</button> : <span key={segment.index}>{segment.text}</span>)}</div>{lookup && <div className="lexicon-popover" role="status"><button className="lookup-close" aria-label="Wörterbuch schließen" onClick={() => setLookup(undefined)}>×</button><small>WÖRTERBUCH · {lookup.result?.status === "ai_resolved" ? "KI-KONTEXTAUFLÖSUNG" : lookup.result?.status === "local_mt_candidate" ? "LOKALE MT · UNGEPRÜFT" : "LOKAL"}</small><b>{lookup.surface}</b>{lookup.loading ? <p>Wird nachgeschlagen …</p> : lookup.result?.candidates.length ? lookup.result.candidates.map((candidate) => <div className="lexicon-candidate" key={candidate.senseId ?? `${candidate.lemma}:${candidate.translation}`}><p><strong>{candidate.lemma}</strong> <span>{candidate.pos}</span><br />{candidate.translation}</p>{candidate.gloss && <p className="lexicon-gloss">{candidate.gloss}</p>}<button disabled={lookup.saved} onClick={() => void remember(candidate)}>{lookup.saved ? "Vorgemerkt" : "Merken"}</button></div>) : <p>Kein sicherer Treffer gefunden.</p>}</div>}</div>;
}

function segmentWords(text: string, language?: string): Array<{ text: string; index: number; isWord: boolean }> {
  if (typeof Intl.Segmenter === "function") return [...new Intl.Segmenter(language, { granularity: "word" }).segment(text)].map((segment) => ({ text: segment.segment, index: segment.index, isWord: Boolean(segment.isWordLike) }));
  return [...text.matchAll(/[\p{L}\p{M}\d]+|[^\p{L}\p{M}\d]+/gu)].map((match) => ({ text: match[0], index: match.index, isWord: /^[\p{L}\p{M}\d]/u.test(match[0]) }));
}

function TypingIndicator() {
  return <div className="message-row partner-row typing-row" role="status" aria-live="polite">
    <small className="message-label">Gesprächspartner schreibt</small>
    <div className="message-bubble partner-bubble typing-bubble" aria-label="Antwort wird geschrieben"><span /><span /><span /></div>
  </div>;
}

function LearnerMessage({ message, responses }: { message: string; responses: ActivityTurn[] }) {
  const feedback = responses.map(({ turn }) => turn).find((turn) => turn.correction || turn.explanation || turn.targetLanguageUse !== "target" || turn.errorTags.length);
  return <div className="message-row learner-row"><small className="message-label">Du</small><div className="message-bubble learner-bubble">{message}</div>{feedback && <div className="learner-feedback">{feedback.correction && <CorrectionDiff original={message} corrected={feedback.correction} />}{feedback.targetLanguageUse !== "target" && <p className="language-switch">{feedback.targetLanguageUse === "source" ? "Antwort in der Ausgangssprache erkannt." : "Sprachwechsel innerhalb der Antwort erkannt."} Für die Lernzielerfüllung wurde dieser Zug abgewertet.</p>}{feedback.explanation && <p className="feedback-explanation">{feedback.explanation}</p>}</div>}</div>;
}

function CorrectionDiff({ original, corrected }: { original: string; corrected: string }) {
  const operations = wordDiff(original, corrected);
  return <div className="correction-diff"><div aria-label={`Original: ${original}`}>{operations.filter(({ kind }) => kind !== "insert").map((operation, index) => operation.kind === "delete" ? <del key={index}>{operation.value}</del> : <span key={index}>{operation.value}</span>)}</div><div className="corrected-line" aria-label={`Korrektur: ${corrected}`}><small>KORREKTUR</small>{operations.filter(({ kind }) => kind !== "delete").map((operation, index) => operation.kind === "insert" ? <ins key={index}>{operation.value}</ins> : <span key={index}>{operation.value}</span>)}</div></div>;
}

type DiffOperation = { kind: "equal" | "delete" | "insert"; value: string };
export function wordDiff(original: string, corrected: string): DiffOperation[] {
  const tokenize = (value: string) => value.match(/\s+|[\p{L}\p{M}\d]+|[^\s]/gu) ?? [];
  const before = tokenize(original); const after = tokenize(corrected);
  const lengths = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0));
  for (let left = before.length - 1; left >= 0; left--) for (let right = after.length - 1; right >= 0; right--) lengths[left][right] = before[left] === after[right] ? lengths[left + 1][right + 1] + 1 : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
  const result: DiffOperation[] = []; let left = 0; let right = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) { result.push({ kind: "equal", value: before[left++] }); right++; }
    else if (right < after.length && (left >= before.length || lengths[left][right + 1] > lengths[left + 1][right])) result.push({ kind: "insert", value: after[right++] });
    else result.push({ kind: "delete", value: before[left++] });
  }
  return result;
}

function setupActionLabel(action: string) {
  return ({ none: "bereit", create: "wird angelegt", update: "wird aktualisiert", conflict: "Konflikt – bleibt unverändert" } as Record<string, string>)[action] ?? action;
}

function formatUsd(value?: number) {
  if (value === undefined) return "–";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(value);
}

function formatBytes(value: number) {
  return `${(value / 1_000_000_000).toLocaleString("de-DE", { maximumFractionDigits: 2 })} GB`;
}
