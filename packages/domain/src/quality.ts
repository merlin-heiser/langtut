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
