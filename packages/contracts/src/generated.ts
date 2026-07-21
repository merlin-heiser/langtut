/* Generated from specs/schemas/contracts.schema.json. Do not edit. */

export type ModuleStatus = "locked" | "available" | "preparing" | "learning" | "credited";
export type SessionMode = "OVERLOAD" | "RECOVERY" | "EXPANSION" | "NORMAL";

export interface GeneratedContracts {
  ModuleStatus?: ModuleStatus;
  GrammarMilestone?: GrammarMilestone;
  CurriculumModule?: CurriculumModule;
  Curriculum?: Curriculum;
  AnkiMetrics?: AnkiMetrics;
  ApiCostSummary?: ApiCostSummary;
  SessionMode?: SessionMode;
  SessionPlan?: SessionPlan;
  CandidateItem?: CandidateItem;
  GeneratedItems?: GeneratedItems;
  VerificationResult?: VerificationResult;
  TutorTurn?: TutorTurn;
  TutorReport?: TutorReport;
  Job?: Job;
  PlacementSession?: PlacementSession;
  PlacementItem?: PlacementItem;
  PlacementStep?: PlacementStep;
  PlacementEvaluation?: PlacementEvaluation;
  [k: string]: unknown;
}
export interface GrammarMilestone {
  id: string;
  description: string;
}
export interface CurriculumModule {
  id: string;
  cefr: string;
  displayLevel: string;
  title: string;
  vocabTarget: number;
  vocabDomains: string[];
  functions: string[];
  grammarMilestones: GrammarMilestone[];
  practiceTypes: string[];
  prerequisites: string[];
  exitCriteria: string[];
  /**
   * @minItems 1
   * @maxItems 3
   */
  focusTags: string[];
  activityIds?: string[];
  status: ModuleStatus;
}
export interface Curriculum {
  packageId: string;
  version: string;
  language: string;
  sourceLanguage: string;
  targetLevel: string;
  vocabTarget: number;
  exerciseTypes: string[];
  /**
   * @minItems 1
   */
  modules: CurriculumModule[];
}
export interface AnkiMetrics {
  reachable: boolean;
  dueReviews: number;
  newCards: number;
  leeches: number;
  lapses7d: number;
  version?: number;
  error?: string;
}
export interface ApiCostSummary {
  currency: "USD";
  weekCost: number;
  totalCost: number;
  weekInputTokens: number;
  weekOutputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  weekStartedAt: string;
  trackedSince: string | null;
  pricingVersion: string;
}
export interface SessionPlan {
  id: string;
  packageId: string;
  createdAt: string;
  mode: SessionMode;
  timeBudgetMin: number;
  reviewCapacity: number;
  newCardBudget: number;
  primaryModuleId: string | null;
  focusTags: string[];
  reasons: string[];
  anki: AnkiMetrics;
}
export interface CandidateItem {
  itemId: string;
  kind: "vocab" | "chunk" | "rule";
  moduleId: string;
  target: string;
  source: string;
  exampleTarget: string;
  exampleSource: string;
  notes: string;
  /**
   * @maxItems 3
   */
  tags: string[];
  milestoneId?: string;
  functionId?: string;
}
export interface GeneratedItems {
  items: CandidateItem[];
}
export interface VerificationResult {
  results: {
    itemId: string;
    approved: boolean;
    issues: string[];
  }[];
}
export interface TutorTurn {
  message: string;
  correction: string;
  explanation: string;
  newExample: string;
}
export interface TutorReport {
  focusTags: string[];
  observedErrors: string[];
  suggestedReviewItems: string[];
  suggestedNewCards: CandidateItem[];
  nextSessionSuggestions: string[];
}
export interface Job {
  id: string;
  packageId: string;
  kind: string;
  moduleId?: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  message?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface PlacementSession {
  id: string;
  packageId: string;
  status: "active" | "completed";
  startedAt: string;
  itemsAnswered: number;
  maxItems: 20;
  recommendedModuleId?: string;
  weakTags?: string[];
}
export interface PlacementItem {
  id: string;
  level: "Pre-A1" | "A1" | "A2" | "B1";
  prompt: string;
  kind: "production" | "recognition" | "open";
  choices?: string[];
}
export interface PlacementStep {
  id: string;
  status: "active" | "completed";
  startedAt: string;
  itemsAnswered: number;
  maxItems: 20;
  recommendedModuleId?: string;
  weakTags?: string[];
  nextItem?: PlacementItem;
  correct?: boolean;
  rubric?: PlacementEvaluation;
}
export interface PlacementEvaluation {
  score: number;
  feedback: string;
  weakTags: string[];
}
