import type { CandidateItem } from "@langtut/contracts";

export function normalizeSlovak(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

export function stripDiacritics(value: string): string {
  return normalizeSlovak(value).normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC").toLocaleLowerCase("sk");
}

export function validateCandidate(item: CandidateItem, allowedTags: Set<string>): string[] {
  const issues: string[] = [];
  if (!item.itemId || !item.moduleId) issues.push("missing_identity");
  if (!item.slovak.trim() || !item.german.trim()) issues.push("empty_front_or_back");
  if (item.slovak !== item.slovak.normalize("NFC") || item.exampleSlovak !== item.exampleSlovak.normalize("NFC")) issues.push("not_nfc");
  if (item.tags.length > 3) issues.push("too_many_domain_tags");
  if (item.tags.some((tag) => !allowedTags.has(tag))) issues.push("unknown_tag");
  if (item.slovak.length > 200 || item.german.length > 260) issues.push("content_too_long");
  return issues;
}

const metalanguageFronts = new Set([
  "dlzen", "makcen", "pravopis", "prizvuk", "samohlaska", "spoluhlaska", "slabika",
  "nominativ", "akuzativ", "genitiv", "dativ", "lokal", "instrumental", "vokativ",
  "predlozka", "zameno", "pridavne meno", "prislovka", "slovesny vid", "vid",
  "slovosled", "vedlajsia veta", "vztazna veta", "podmienovaci sposob", "rozkazovaci sposob",
  "minuly cas", "buduci cas", "pritomny cas", "l-participium", "formalny register",
]);

const metalanguageGerman = /\b(?:Längenzeichen|Weichheitszeichen|Vokallänge|Rechtschreibung|Wortbetonung|Betonung|Akzent(?:zeichen)?|Vokal|Konsonant|Silbe|Nominativ|Akkusativ|Genitiv|Dativ|Lokativ|Instrumental|Vokativ|Kasus|Fallform|Präposition|Pronomen|Adjektiv|Adverb|Konjugation|Deklination|Wortstellung|Nebensatz|Relativsatz|Konditional|Imperativ|Verbalaspekt|Tempus|Zeitform|Partizip|formales? Register)\b/i;
const paradigmMarker = /\b(?:[123]\.?\s*Person|Person\s+(?:Singular|Plural)|Singularform|Pluralform|konjugierte Form|Form von)\b/i;
const phonologyContext = /\b(?:Aussprache|Vokal|Konsonant|Silbe|Laut|Betonung|Akzent)\b/i;
const lowercaseClosedClass = new Set(["ja", "ty", "on", "ona", "ono", "my", "vy", "oni", "ony", "co", "kto", "kde", "ako", "ano", "nie", "sa", "si"]);

/**
 * Vocab notes count lexical competence. Labels for grammar/phonology, isolated
 * symbols and cells of an inflection paradigm belong to rules or exercises.
 */
export function validateLearningRole(item: CandidateItem): string[] {
  if (item.kind !== "vocab") return [];
  const issues: string[] = [];
  const front = stripDiacritics(item.slovak);
  if (/^\p{L}$/u.test(item.slovak.trim())) issues.push("vocab_is_symbol_not_lexeme");
  if (metalanguageFronts.has(front) || metalanguageGerman.test(item.german)) issues.push("vocab_is_metalanguage");
  if (["makky", "tvrdy"].includes(front) && phonologyContext.test(`${item.german} ${item.notes} ${item.exampleGerman}`)) issues.push("vocab_is_metalanguage");
  if (paradigmMarker.test(item.notes)) issues.push("vocab_is_inflection_cell");
  if (lowercaseClosedClass.has(front) && item.slovak !== item.slovak.toLocaleLowerCase("sk")) issues.push("vocab_noncanonical_dictionary_form");
  return [...new Set(issues)];
}

export function isNearDuplicate(a: string, b: string): boolean {
  const left = stripDiacritics(a);
  const right = stripDiacritics(b);
  if (left === right) return true;
  const max = Math.max(left.length, right.length);
  if (!max) return true;
  return 1 - levenshtein(left, right) / max >= 0.9;
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}
