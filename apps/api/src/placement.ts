import { randomUUID } from "node:crypto";

export interface PlacementItem {
  id: string;
  level: "Pre-A1" | "A1" | "A2" | "B1";
  prompt: string;
  expected: string[];
  tag: string;
  kind?: "production" | "recognition" | "open";
  choices?: string[];
}

export const placementItems: PlacementItem[] = [
  { id: "p1", level: "Pre-A1", prompt: "Welche Form bedeutet ‚Guten Tag‘?", expected: ["dobrý deň"], tag: "func_greet", kind: "recognition", choices: ["Dobrý deň", "Dovidenia", "Ďakujem"] },
  { id: "p2", level: "Pre-A1", prompt: "Übersetze: Ich heiße Merlin.", expected: ["volám sa merlin"], tag: "func_introduce" },
  { id: "p3", level: "A1", prompt: "Übersetze: Ich habe einen Bruder.", expected: ["mám brata"], tag: "case_accusative" },
  { id: "p4", level: "A1", prompt: "Übersetze: Ich wohne in Berlin.", expected: ["bývam v berlíne", "bývam v berline"], tag: "case_locative" },
  { id: "p5", level: "A1", prompt: "Bestelle höflich einen Kaffee.", expected: ["prosím si kávu", "dal by som si kávu"], tag: "func_order" },
  { id: "p6", level: "A2", prompt: "Übersetze: Gestern bin ich nach Hause gegangen.", expected: ["včera som išiel domov", "včera som išla domov"], tag: "verb_past" },
  { id: "p7", level: "A2", prompt: "Übersetze: Morgen werde ich arbeiten.", expected: ["zajtra budem pracovať"], tag: "verb_future" },
  { id: "p8", level: "A2", prompt: "Übersetze: Ich komme aus Deutschland.", expected: ["som z nemecka", "pochádzam z nemecka"], tag: "case_genitive" },
  { id: "p9", level: "B1", prompt: "Übersetze: Ich denke, dass es eine gute Idee ist.", expected: ["myslím si, že je to dobrý nápad"], tag: "syntax_subordinate" },
  { id: "p10", level: "B1", prompt: "Übersetze: Wenn ich Zeit hätte, würde ich reisen.", expected: ["keby som mal čas, cestoval by som", "keby som mala čas, cestovala by som"], tag: "verb_conditional" },
  { id: "p11", level: "B1", prompt: "Verbinde mit einer Relativkonstruktion: Das ist der Mann. Er wohnt hier.", expected: ["to je muž, ktorý tu býva"], tag: "syntax_relative" },
  { id: "p12", level: "B1", prompt: "Drücke in zwei bis drei Sätzen Zustimmung oder Widerspruch aus und begründe deine Position.", expected: [], tag: "func_agree_disagree", kind: "open" }
];

export interface PlacementStateBase {
  id: string;
  status: "active" | "completed";
  startedAt: string;
  itemsAnswered: number;
  maxItems: 20;
  score: number;
  weakTags: string[];
}

export function newPlacement(): PlacementStateBase {
  return { id: randomUUID(), status: "active", startedAt: new Date().toISOString(), itemsAnswered: 0, maxItems: 20, score: 0, weakTags: [] };
}

export function scoreAnswer(item: PlacementItem, answer: string): boolean {
  const normalized = answer.normalize("NFC").toLocaleLowerCase("sk").replace(/[.!?]/g, "").trim();
  return item.expected.some((expected) => normalized.includes(expected));
}

export function recommendation(score: number, answered: number): string {
  const ratio = answered ? score / answered : 0;
  if (answered >= 9 && ratio >= 0.75) return "b1_case_mastery_round1";
  if (answered >= 6 && ratio >= 0.65) return "a2_travel_transport";
  if (answered >= 3 && ratio >= 0.55) return "a1_introductions_identity";
  return "a0_alphabet_pronunciation";
}
