// The appeal loop's deterministic half (docs/servicing_agent_plan.md §5.4).
//
// An appeal is NOT "user unhappy → send to advisor". It argues against exactly one finding, and this file is
// what makes that assessable rather than a mood:
//
//   identifyContested   which finding is being argued with — from the ROW, never from the member's prose
//   ADMISSIBILITY       what could change each finding, and the ONE input it turns on (§5.4.2)
//   remainingKinds      "can useful evidence still exist?" — a set difference, not a judgment (§5.4.3)
//   validateCorrection  the one-field patch an admissible piece of evidence may propose (§5.4.4)
//   reAdjudicate        the same arithmetic that denied the claim, run again at the ORIGINAL ledger position (§5.4.5)
//   compareOutcome      "different outcome?", and the never-worse rule (§5.4.6)
//
// The boundary is the whole point. The agent judges whether a document bears on a finding; the engine
// performs the re-adjudication. Neither does the other's job: the agent cannot decide a claim is now
// payable, and nothing here decides whether a document is relevant. An overturn is therefore never a model
// being persuaded — it is a model correcting ONE input, and the same rules paying what they had denied.
//
// Pure and free of `server-only`, like everything in lib/servicing: the checks drive it from a script.

import type { PlanTerms } from "@/lib/assessment";
import {
  benefitClassEnum,
  providerTierEnum,
  type BenefitClass,
  type ClaimProviderTier,
  type EventKind,
  type EventOutcome,
  type ProviderTier,
  type ReasonCode,
} from "@/db/schema/enums";
import { adjudicate } from "./adjudicate";
import { EVIDENCE_THAT_COULD_CHANGE } from "./next-steps";
import { effectPositions, replay } from "./replay";
import type { AdjudicationResult, LedgerState, ReplayEvent } from "./types";
import { providerTypeLabel } from "./labels";

// ---------------------------------------------------------------------------
// The admissibility table (§5.4.2)
// ---------------------------------------------------------------------------

/**
 * The kinds of evidence an appeal can be about. A CLOSED set: `request_evidence` refuses anything outside it,
 * which means the system can never ask a member for a document that could not have changed the answer even if
 * they produced it.
 */
export const EVIDENCE_KINDS = ["dated_diagnosis", "prior_cover", "provider_licence", "misclassified_prior_claim", "treatment_class_record"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** The inputs an appeal may patch — the only two the supplied findings ever turn on. */
export const CORRECTABLE_FIELDS = ["provider_tier", "benefit_class"] as const;
export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

export type AdmissibleKind = {
  kind: EvidenceKind;
  /** The request card's prompt: what to send, in the member's words. */
  ask: string;
  /** What the document has to show — the finding it must bear on, in words. */
  mustShow: string;
  /** The line on the appeal intro's "what could change it" list. */
  couldChange: string;
  /**
   * The input this evidence corrects, or null when the engine has NO input for it. Continuity of cover and a
   * mis-recorded EARLIER claim change a finding, but not by patching this event's own tier or class — one needs a
   * credit the plan terms do not model, the other rewrites another claim. Those are real evidence and they go to a
   * person, not through a patch the engine cannot honestly apply.
   */
  corrects: CorrectableField | null;
};

export type Admissibility = {
  /** The input the finding turns on (null: no input an appeal can patch). */
  turnsOn: CorrectableField | "prior_event" | null;
  /** In the order to ask — most likely first. */
  kinds: readonly AdmissibleKind[];
  /** Things that sound like arguments and are not. The agent is shown this list: its failure mode is agreeing with a well-written paragraph. */
  notAdmissible: readonly string[];
  /** The finding, as a member says it: "the waiting period for existing conditions". */
  decisionTurnedOn: string;
};

export const ADMISSIBILITY: Partial<Record<ReasonCode, Admissibility>> = {
  waiting_period_not_elapsed: {
    turnsOn: "benefit_class",
    decisionTurnedOn: "the waiting period for existing conditions",
    kinds: [
      {
        kind: "dated_diagnosis",
        ask: "Do you have a record that shows when this condition was first diagnosed?",
        mustShow: "a dated diagnosis placing the first finding of the condition after your policy started",
        couldChange: EVIDENCE_THAT_COULD_CHANGE.waiting_period_not_elapsed![0],
        corrects: "benefit_class",
      },
      {
        kind: "prior_cover",
        ask: "Do you have proof that you had health cover before this policy began?",
        mustShow: "continuous health cover before this policy started",
        couldChange: EVIDENCE_THAT_COULD_CHANGE.waiting_period_not_elapsed![1],
        corrects: null,
      },
    ],
    notAdmissible: [
      "Your description of when it started — your application already records it, so we'd need a document to look again.",
      "How much the treatment cost, or how urgent it was.",
    ],
  },
  provider_out_of_network: {
    turnsOn: "provider_tier",
    decisionTurnedOn: "the provider's network tier",
    kinds: [
      {
        kind: "provider_licence",
        ask: "Do you have the provider's licence or registration?",
        mustShow: "the provider's own registered category — the network tier it is licensed at",
        couldChange: EVIDENCE_THAT_COULD_CHANGE.provider_out_of_network![0],
        corrects: "provider_tier",
      },
    ],
    notAdmissible: [
      "Where the provider is, how well known it is, or that it sits inside another building — the category it is registered under is what counts.",
      "That it was the most convenient place to go.",
    ],
  },
  sublimit_exhausted: {
    turnsOn: "prior_event",
    decisionTurnedOn: "the yearly limit for this benefit",
    kinds: [
      {
        kind: "misclassified_prior_claim",
        ask: "Do you have a record showing an earlier claim was a different kind of treatment?",
        mustShow: "that an earlier claim counted against this limit was a different kind of treatment",
        couldChange: EVIDENCE_THAT_COULD_CHANGE.sublimit_exhausted![0],
        corrects: null,
      },
    ],
    notAdmissible: ["That you need the treatment, or have appointments booked.", "That the limit is too low."],
  },
  annual_limit_reached: {
    turnsOn: "prior_event",
    decisionTurnedOn: "your yearly limit",
    kinds: [
      {
        kind: "misclassified_prior_claim",
        ask: "Do you have a record showing an earlier claim was recorded incorrectly?",
        mustShow: "that an earlier claim counted against the yearly limit was recorded incorrectly",
        couldChange: EVIDENCE_THAT_COULD_CHANGE.annual_limit_reached![0],
        corrects: null,
      },
    ],
    notAdmissible: ["That you need the treatment, or have appointments booked.", "That the limit is too low."],
  },
  benefit_excluded: {
    turnsOn: "benefit_class",
    decisionTurnedOn: "what kind of treatment it counts as",
    kinds: [
      {
        kind: "treatment_class_record",
        ask: "Do you have a record showing what kind of treatment this was?",
        mustShow: "that the treatment belongs to a benefit your plan does cover",
        couldChange: EVIDENCE_THAT_COULD_CHANGE.benefit_excluded![0],
        corrects: "benefit_class",
      },
    ],
    notAdmissible: ["That the plan should cover this, or that it is a bad plan."],
  },
};

// ---------------------------------------------------------------------------
// A floor under the agent's judgment
// ---------------------------------------------------------------------------

const DATE = /((?:19|20)\d{2})|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/i;

/**
 * What a piece of text has to LOOK like to be called a given kind of document. Deliberately crude: it cannot tell a real
 * licence from a typed one, and it is not meant to — the wall against a fabricated document is the person who signs an
 * overturn, shown the quote. What it does stop is the cheap failure, a model (or a member) calling an ASSERTION a
 * document: "it's a separate practice with its own licence" says nothing about a tier, so it is not a licence.
 */
const MARKERS: Record<EvidenceKind, { evidence: RegExp[]; quote?: RegExp; needs: string }> = {
  dated_diagnosis: { evidence: [/diagnos/i], quote: DATE, needs: "a diagnosis, and the quoted words must carry a date" },
  prior_cover: { evidence: [/(insur|cover|polic|member|plan)/i], quote: DATE, needs: "earlier cover, and the quoted words must carry a date" },
  provider_licence: { evidence: [/(licen[cs]|registrat|registered)/i, /(tier|categor|class|standard|basic|network)/i], needs: "a licence or registration that names the provider's registered category or tier" },
  misclassified_prior_claim: { evidence: [/(claim|invoice|receipt|bill|record)/i, /(class|categor|type|maternity|general|routine|dental|chronic)/i], needs: "an earlier claim and the kind of treatment it was" },
  treatment_class_record: { evidence: [/(treat|therap|procedure|prescri|diagnos|consult)/i], needs: "a record of the treatment" },
};

/** Null when the text can be called this kind; otherwise what it lacks. */
export function kindMarkerProblem(kind: EvidenceKind, evidenceText: string, quote: string): string | null {
  const m = MARKERS[kind];
  if (!m.evidence.every((re) => re.test(evidenceText)) || (m.quote && !m.quote.test(quote))) {
    return `that text does not read as ${kind.replace(/_/g, " ")} evidence — it needs to show ${m.needs}. A description of what happened is not a document`;
  }
  return null;
}

export const admissibilityFor = (reason: ReasonCode): Admissibility | null => ADMISSIBILITY[reason] ?? null;
export const admissibleKinds = (reason: ReasonCode): EvidenceKind[] => (ADMISSIBILITY[reason]?.kinds ?? []).map((k) => k.kind);
export const kindInfo = (reason: ReasonCode, kind: EvidenceKind): AdmissibleKind | null => ADMISSIBILITY[reason]?.kinds.find((k) => k.kind === kind) ?? null;

// ---------------------------------------------------------------------------
// Identify the contested finding (§5.4.1)
// ---------------------------------------------------------------------------

/** What an appeal needs to know about the row it contests. Plain data: the store builds it from the log. */
export type ContestedRow = {
  id: string;
  ref: string;
  kind: EventKind;
  policyMonth: number;
  outcome: EventOutcome | null;
  reasonCode: ReasonCode | null;
  benefitClass: BenefitClass | null;
  providerTier: ClaimProviderTier | null;
  geography: "uae" | "abroad" | "unknown";
  amount: number | null;
  planPays: number | null;
  memberPays: number | null;
  description: string | null;
  /** Who decided it. A finding a person made is theirs to revisit, not the appeal loop's. */
  decidedBy?: "system" | "advisor" | "applicant" | null;
  /** A row that supersedes this one, if any. */
  supersededBy: string | null;
  /** An appeal already filed against this row, if any. */
  appealedBy: string | null;
};

/**
 * Why a row is NOT an appeal — each exits before the loop starts (§5.4.1).
 *
 *  unappealable_finding   nothing adverse to argue with (`covered`), or a finding whose evidence is out of scope
 *                         (`policy_not_active` turns on billing)
 *  already_with_advisor   `insufficient_data`: the system never made a finding, and a person already has it
 *  superseded             an earlier overturn already changed it
 *  appeal_of_appeal       an appeal of an appeal is a second opinion, not new evidence
 *  already_appealed       one appeal per denial
 *  not_a_decision         a pre-authorization is a forecast, and there is nothing to contest
 */
export type AppealExit = "unappealable_finding" | "already_with_advisor" | "superseded" | "appeal_of_appeal" | "already_appealed" | "not_a_decision";

export type Contested = {
  row: ContestedRow;
  reason: ReasonCode;
  admissibility: Admissibility;
};

export function identifyContested(row: ContestedRow): { ok: true; contested: Contested } | { ok: false; exit: AppealExit } {
  if (row.kind === "appeal") return { ok: false, exit: "appeal_of_appeal" };
  if (row.kind === "preauth") return { ok: false, exit: "not_a_decision" };
  if (row.supersededBy) return { ok: false, exit: "superseded" };
  if (row.decidedBy === "advisor") return { ok: false, exit: "already_with_advisor" };
  if (row.reasonCode === "insufficient_data" || row.outcome === "insufficient_data") return { ok: false, exit: "already_with_advisor" };
  if (row.appealedBy) return { ok: false, exit: "already_appealed" };
  if (row.outcome !== "denied" || !row.reasonCode) return { ok: false, exit: "unappealable_finding" };
  const admissibility = ADMISSIBILITY[row.reasonCode];
  if (!admissibility) return { ok: false, exit: "unappealable_finding" };
  return { ok: true, contested: { row, reason: row.reasonCode, admissibility } };
}

/** What a member reads when a decision cannot be appealed, and why — never a reason code. */
export const APPEAL_EXIT_TEXT: Record<AppealExit, string> = {
  unappealable_finding: "There's nothing in this decision to appeal. If you think the amount is wrong, an advisor can go through the working with you.",
  already_with_advisor: "An advisor already has this one, so there's nothing to appeal — anything you'd like to add goes to them.",
  superseded: "This decision has already been changed. The newer decision is the one that counts.",
  appeal_of_appeal: "This is already the result of an appeal. If you still think it's wrong, an advisor can look at it with you.",
  already_appealed: "This decision has already been appealed once. If you have something new, an advisor can look at it with you.",
  not_a_decision: "An estimate isn't a decision, so there's nothing to appeal.",
};

// ---------------------------------------------------------------------------
// "Can useful evidence still exist?" (§5.4.3)
// ---------------------------------------------------------------------------

/** What has happened to the evidence in one appeal, by kind. */
export type EvidenceLedger = {
  /** Kinds a piece of evidence actually showed. */
  supplied: EvidenceKind[];
  /** Kinds the member said they do not have. */
  declined: EvidenceKind[];
  /** Kinds already asked for, once per request — a kind asked twice is not asked again. */
  requested: EvidenceKind[];
};

export const MAX_REQUESTS_PER_KIND = 2;

/**
 * admissible − supplied − declined − asked twice.
 *
 * Non-empty AND under the round limit → ask for the first (most likely) item by name. Empty → uphold now:
 * asking again would be theatre. Computed rather than left to the model's sense of possibility, because that
 * is unbounded in both directions — endless requests for a member who will never have the document, or a
 * premature uphold for one who would have produced it.
 */
export function remainingKinds(reason: ReasonCode, ev: EvidenceLedger): EvidenceKind[] {
  const asked = (k: EvidenceKind) => ev.requested.filter((x) => x === k).length;
  return admissibleKinds(reason).filter((k) => !ev.supplied.includes(k) && !ev.declined.includes(k) && asked(k) < MAX_REQUESTS_PER_KIND);
}

// ---------------------------------------------------------------------------
// The correction patch (§5.4.4)
// ---------------------------------------------------------------------------

export type Correction = {
  field: CorrectableField;
  from: string;
  to: string;
  /** Verbatim from the evidence. A correction with no textual support in the document fails the turn. */
  quote: string;
  /** Which piece of evidence the quote came from. */
  evidenceIndex: number;
};

const squash = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

/** The value a field currently has on the contested row. */
export const currentValue = (row: ContestedRow, field: CorrectableField): string | null => (field === "provider_tier" ? row.providerTier : row.benefitClass);

const VALUES: Record<CorrectableField, readonly string[]> = {
  // A licence cannot make a provider "outside the UAE" — that is geography, and it is not something an appeal patches.
  provider_tier: providerTierEnum,
  benefit_class: benefitClassEnum,
};

/**
 * Everything checked BEFORE the engine is touched:
 *  1. `field` must be the one the contested code turns on. An appeal against a network denial cannot patch the amount.
 *  2. `value` must be a member of that field's closed enum.
 *  3. `value` must differ from what is recorded — a patch that changes nothing is a rejection, not an overturn.
 *  4. `quote` must be a verbatim span of the evidence supplied.
 *
 * Everything else about the event is immutable under appeal: billed amount, date, month, policy, member. Those
 * are facts about what happened, not findings about it — which is what keeps an appeal from degenerating into
 * "describe the claim again, differently, until it pays".
 */
export function validateCorrection(
  contested: Contested,
  evidenceKind: EvidenceKind,
  args: { field: string; value: string; quote: string },
  evidence: string[],
): { ok: true; correction: Correction } | { ok: false; error: string } {
  const info = kindInfo(contested.reason, evidenceKind);
  if (!info) return { ok: false, error: `${evidenceKind} is not evidence that can bear on this finding — the admissible kinds are [${admissibleKinds(contested.reason).join(", ")}]` };
  if (info.corrects === null) {
    return { ok: false, error: `${evidenceKind} bears on this finding, but it corrects no input the engine holds for this event — it needs a person, so call escalate with cause correction_needs_review` };
  }
  const turnsOn = contested.admissibility.turnsOn;
  if (args.field !== info.corrects || args.field !== turnsOn) {
    return { ok: false, error: `field "${args.field}" is not what this finding turns on — the only field an appeal against it may correct is "${turnsOn}". The amount, date and month cannot be patched by an appeal` };
  }
  const field = args.field as CorrectableField;
  if (!VALUES[field].includes(args.value)) return { ok: false, error: `value "${args.value}" is not a valid ${field} — one of [${VALUES[field].join(", ")}]` };
  const from = currentValue(contested.row, field);
  if (from === args.value) return { ok: false, error: `${field} is already recorded as "${args.value}" — a correction that changes nothing is not a correction` };

  const q = squash(args.quote);
  if (q.length < 12) return { ok: false, error: "quote is too short to be a span of the evidence — quote the words that show it, verbatim" };
  const evidenceIndex = evidence.findIndex((e) => squash(e).includes(q));
  if (evidenceIndex < 0) return { ok: false, error: `quote "${args.quote}" does not appear in anything the member supplied — a correction needs textual support in the document itself` };

  return { ok: true, correction: { field, from: from ?? "", to: args.value, quote: args.quote.trim(), evidenceIndex } };
}

// ---------------------------------------------------------------------------
// Re-adjudication at the original ledger position (§5.4.5)
// ---------------------------------------------------------------------------

export type ReAdjudication = {
  /** The ledger as it stood immediately before the contested event took effect. */
  ledgerBefore: LedgerState;
  result: AdjudicationResult;
  verdict: "overturn" | "uphold_identical" | "uphold_worse" | "uphold_undecidable";
};

/**
 * Run the engine on ONE event of the log with some inputs replaced, against the ledger AS IT STOOD before that event
 * took effect — not against today's. APP-2 must be adjudicated against P4's empty ledger at month 7, which is why its
 * deductible applies; an appeal filed months later must not change what the original saw. The same function serves an
 * advisor supplying the missing input on an undecidable case (plan §13.3.2): the person names WHICH tier to treat the
 * provider as, and the engine computes the money — a person never types an amount.
 *
 * "Before" is effect order, not submission order: an overturn filed later that lands at an earlier denial's position
 * takes effect before this event, so it is in the ledger this event should have seen.
 */
export function adjudicateAt(input: {
  plan: PlanTerms;
  events: ReplayEvent[];
  eventId: string;
  overrides: { benefitClass?: BenefitClass; providerTier?: ProviderTier; geography?: "uae" | "abroad" | "unknown" };
  policyStatus?: "active" | "lapsed" | "cancelled";
}): { ledgerBefore: LedgerState; result: AdjudicationResult } {
  const { plan, events, eventId, overrides } = input;
  const target = events.find((e) => e.id === eventId);
  if (!target) throw new Error(`event ${eventId} is not in the log`);
  if (target.benefitClass === null || target.providerTier === null || target.amount === null) {
    throw new Error(`${eventId} has no benefit class, provider tier or amount to adjudicate`);
  }
  const position = effectPositions(events);
  const here = position.get(eventId)!;
  const before = events.filter((e) => e.id !== eventId && position.get(e.id)! < here);
  const ledgerBefore = replay(plan, before).ledger;
  const result = adjudicate({
    plan,
    ledger: ledgerBefore,
    policyStatus: input.policyStatus ?? "active",
    policyMonth: target.policyMonth,
    benefitClass: overrides.benefitClass ?? target.benefitClass,
    providerTier: overrides.providerTier ?? target.providerTier,
    geography: overrides.geography ?? target.geography ?? "uae",
    amount: target.amount,
    dryRun: target.kind === "preauth",
  });
  return { ledgerBefore, result };
}

/** Re-adjudicate a contested denial with ONE input corrected, and compare (§5.4.5). */
export function reAdjudicate(input: {
  plan: PlanTerms;
  events: ReplayEvent[];
  contestedId: string;
  patch: { field: CorrectableField; value: string };
  policyStatus?: "active" | "lapsed" | "cancelled";
  /** The contested row's recorded result, which a re-adjudication is compared with. */
  original: { outcome: EventOutcome | null; planPays: number | null };
}): ReAdjudication {
  const { patch } = input;
  const { ledgerBefore, result } = adjudicateAt({
    plan: input.plan,
    events: input.events,
    eventId: input.contestedId,
    overrides: patch.field === "benefit_class" ? { benefitClass: patch.value as BenefitClass } : { providerTier: patch.value as ProviderTier },
    policyStatus: input.policyStatus,
  });
  return { ledgerBefore, result, verdict: compareOutcome(input.original, result) };
}

/**
 * "Different outcome?" — and the never-worse rule (§5.4.6).
 *
 *   better for the member  → overturn (an advisor signs it)
 *   identical              → uphold, with a NEW explanation: we looked again, with your document
 *   worse for the member   → uphold the ORIGINAL. The appeal is closed at no cost to them
 *
 * The last row is deliberate: an appeal can never cost a member money. A member who supplies honest evidence
 * must never be punished for it, and without this rule a sufficiently thorough re-adjudication eventually would.
 */
export function compareOutcome(original: { outcome: EventOutcome | null; planPays: number | null }, redone: AdjudicationResult): ReAdjudication["verdict"] {
  if (redone.outcome === "insufficient_data") return "uphold_undecidable";
  const was = original.planPays ?? 0;
  const now = redone.planPays ?? 0;
  if (now < was) return "uphold_worse";
  if (now > was) return "overturn";
  // Equal money. A denial that becomes a covered claim which happens to pay nothing (the bill is inside the
  // deductible) still moves the member forward — the deductible is consumed — so it is better, not identical.
  const wasDenied = original.outcome === "denied";
  const nowDenied = redone.outcome === "denied";
  if (wasDenied && !nowDenied) return "overturn";
  if (!wasDenied && nowDenied) return "uphold_worse";
  return "uphold_identical";
}

// ---------------------------------------------------------------------------
// Words — derived, never typed by a model
// ---------------------------------------------------------------------------

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** One clause, in the member's words, saying what the evidence showed — the "You were right — …" of a reversal. */
export function evidenceClause(c: Correction): string {
  if (c.field === "provider_tier") {
    const label = lowerFirst(providerTypeLabel[c.to as ClaimProviderTier] ?? c.to);
    return `what you sent shows the provider is registered as a ${label}, which your plan covers`;
  }
  return c.to === "general"
    ? "what you sent shows this wasn't an existing condition when your policy started"
    : `what you sent shows this treatment counts as ${lowerFirst(c.to.replace(/_/g, " "))}, which your plan covers`;
}

/** The same finding for the broker: names the field, and carries the quote that supported it. */
export function evidenceClauseBroker(c: Correction, kind: EvidenceKind): string {
  const q = c.quote.length > 160 ? `${c.quote.slice(0, 157)}…` : c.quote;
  return `${kind.replace(/_/g, " ")} supplied as text; "${q}" supports correcting ${c.field.replace(/_/g, " ")}`;
}
