// The servicing seed: the thirteen supplied events, run THROUGH THE ENGINE.
//
// Until now `servicing_event` held two rows a person had typed, arithmetic and
// all. Nothing computed them, so nothing could tell whether they were right.
// This builds every row by adjudicating it — outcome, amounts, calculation
// trace, ledger snapshots, both explanations — and the ledger by replaying the
// history. If the engine changes, the seed changes with it; if the seed and the
// engine ever disagree, that is a bug you can now see.
//
// Pure: takes the fixtures, returns rows. No database access here, so
// check-servicing.ts can import the same builder and verify it without one.
import { createHash } from "node:crypto";
import hackathon from "@/docs/hackathon_data.json";
import type { PlanTerms } from "@/lib/assessment";
import { reasonCodeLabel } from "@/lib/domain";
import {
  explain,
  addMonths,
  ledgerToJson,
  providerTypeLabel,
  replay,
  type AdjudicationResult,
  type ReplayEvent,
} from "@/lib/servicing";
import type { BenefitClass, ClaimProviderTier, EventKind, Geography, ReasonCode } from "../schema/enums";
import type * as schema from "../schema";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Fixtures = any;

export type SeedEventRow = typeof schema.servicingEvent.$inferInsert;
export type SeedTaskRow = typeof schema.reviewTask.$inferInsert;
export type SeedDecisionRow = typeof schema.reviewDecision.$inferInsert;

// ---------------------------------------------------------------------------
// Deterministic ids — a reseed must produce the same rows
// ---------------------------------------------------------------------------

const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** RFC 4122 version 5. The fixtures' own ids are uuid5, so these look like the rest of the data. */
export function uuid5(name: string): string {
  const hash = createHash("sha1").update(Buffer.from(NAMESPACE.replace(/-/g, ""), "hex")).update(name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// The two rows that were hand-written, kept for their prose
// ---------------------------------------------------------------------------
//
// Their ARITHMETIC is regenerated (check-servicing.ts pins the trace against
// the original). Their prose was written by a person, is good, and the
// template explainer is not going to beat it — so it stays, keyed by event.
// Their ids stay because a reassessment and a ledger row point at them.

const CURATED: Record<string, { id: string; description: string; occurredOn: string; member: string; broker: string }> = {
  "CLM-1": {
    id: "796d6791-4b19-5cca-973e-04e53a096c43",
    description: "Fractured wrist — urgent care, X-ray, casting",
    occurredOn: "2026-06-02",
    member:
      "Your wrist treatment is covered. This was your first claim of the year, so the 1,500 deductible applied first, then the 30% outpatient share on the rest. The plan paid 1,190 and your share was 2,010. Your deductible is now fully met for 2026 — later claims this year skip that step.",
    broker:
      "P1 first claim, deductible fully consumed at month 5. Plan paid 1,190 of 3,200. Member share 63% on a first claim is expected on Essential's terms, not a fit signal on its own.",
  },
  "CLM-6": {
    id: "f75010f1-9131-57a9-b5ff-22f7eb8cec55",
    description: "Physiotherapy following the wrist fracture",
    occurredOn: "2026-09-04",
    member:
      "Your physiotherapy is covered. Your deductible was already met earlier this year, so only the 30% outpatient share applied — the plan paid 1,260 and your share was 540.",
    broker:
      "Second general claim on P1, deductible already met. Annual paid now 2,450 against a 150,000 limit. Nothing here argues for a plan change.",
  },
};

// ---------------------------------------------------------------------------
// How the two supplied appeals are represented in the log
// ---------------------------------------------------------------------------
//
// In the running system the appeal loop DERIVES these from the evidence
// (plan §5.4). Here they are inputs, so the engine and the log can be checked
// without it. Shared with check-servicing.ts so there is one definition.

export const APPEAL_DECISIONS: Record<
  string,
  {
    verdict: "upheld" | "overturned";
    declaredAtIntake?: boolean;
    correction?: { field: string; to: ClaimProviderTier };
    evidenceSummary?: string;
    evidenceSummaryBroker?: string;
    confidence: number;
    uncertainty: string;
    decidedByAdvisor?: string;
    signOffNote?: string;
  }
> = {
  "APP-1": {
    verdict: "upheld",
    declaredAtIntake: true,
    confidence: 0.65,
    uncertainty:
      "Upheld with no evidence attached. The finding rests on reading a condition the applicant declared at intake against her own account — arguable enough to be worth a look.",
  },
  "APP-2": {
    verdict: "overturned",
    // The certificate names a facility licensed at the STANDARD tier; the contested provider was
    // recorded at the top tier. Any tier the standard network admits gives the same numbers.
    correction: { field: "provider tier", to: "in_network_clinic" },
    evidenceSummary:
      "the certificate you sent shows the physiotherapy centre is licensed in its own right, at the standard network tier, so it is inside your network",
    evidenceSummaryBroker:
      "registration certificate shows Gulf Physiotherapy Centre LLC is an independently licensed outpatient facility at standard tier, leasing a suite within the hospital building",
    confidence: 0.7,
    uncertainty:
      "Overturned on a provider licence that corrects the recorded tier. The evidence arrived as text, so a person confirms the certificate reads as described.",
    decidedByAdvisor: "Leila Mansour",
    signOffNote: "Certificate reads as described: an independently licensed outpatient facility at standard tier. Tier corrected; reversal approved.",
  },
};

// ---------------------------------------------------------------------------

const addDays = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const toPlanTerms = (p: any): PlanTerms => ({
  id: p.id,
  name: p.name,
  annualPremium: p.annual_premium,
  deductible: p.deductible,
  network: p.network,
  outpatientCopayPct: p.outpatient_copay_pct,
  annualLimit: p.annual_limit,
  dentalOptical: p.dental_optical,
  maternityCovered: !!p.maternity_covered,
  maternityWaitingPeriodMonths: p.maternity_waiting_period_months,
  maternityLimit: p.maternity_limit,
  chronicCovered: !!p.chronic_covered,
  chronicWaitingPeriodMonths: p.chronic_waiting_period_months,
});

export const ledgerJson = ledgerToJson;

const events: any[] = (hackathon as any).servicing_events;
const eventByRef = new Map<string, any>(events.map((e) => [e.id, e]));

/** One supplied event as the row the replay reads. `seq` is order within its policy. */
export function toReplayEvent(e: any, seq: number): ReplayEvent {
  if (e.kind === "appeal") {
    const contested = eventByRef.get(e.contests);
    const decision = APPEAL_DECISIONS[e.id];
    if (decision.verdict === "upheld") {
      return { id: e.id, seq, kind: "appeal", policyMonth: e.policy_month, benefitClass: null, providerTier: null, amount: null, supersedesId: null };
    }
    return {
      id: e.id,
      seq,
      kind: "appeal",
      policyMonth: contested.policy_month,
      benefitClass: contested.benefit_class,
      providerTier: decision.correction!.to,
      amount: contested.billed_amount,
      supersedesId: e.contests,
    };
  }
  return {
    id: e.id,
    seq,
    kind: e.kind,
    policyMonth: e.policy_month,
    benefitClass: e.benefit_class,
    providerTier: e.provider_tier,
    geography: (e.geography ?? "uae") as Geography,
    amount: e.billed_amount ?? e.estimated_amount ?? e.amount_paid_by_member,
    supersedesId: null,
  };
}

export const profilesInOrder = (): string[] => [...new Set(events.map((e) => e.profile_id as string))];
export const logForProfile = (profile: string): ReplayEvent[] =>
  events.filter((e) => e.profile_id === profile).map((e, i) => toReplayEvent(e, i + 1));

// ---------------------------------------------------------------------------

/**
 * `appeals: "pending"` seeds the supplied history WITHOUT its two appeals: CLM-3 and CLM-4 stay denied and appealable, and
 * everything after CLM-4 is adjudicated against the ledger as it then stands. That is the database the appeal loop is
 * DEMONSTRATED on — APP-1 and APP-2 are decided through the conversation, and when the reversal is signed PRE-2 becomes
 * "restated", which is the plan's point about an overturn landing at the denial's position and not the appeal's date.
 * The default ("decided") is the acceptance table exactly as supplied.
 */
export type SeedOptions = { appeals?: "decided" | "pending" };

export function buildServicingSeed(fx: Fixtures, options: SeedOptions = {}) {
  const plans = new Map<string, PlanTerms>(fx.plan.map((p: any) => [p.id, toPlanTerms(p)]));
  const ownerOf = new Map<string, string>(fx.person.map((p: any) => [p.id, p.owner_user_id]));
  const userByName = new Map<string, string>(fx.app_user.map((u: any) => [u.full_name, u.id]));

  const rows: SeedEventRow[] = [];
  const tasks: SeedTaskRow[] = [];
  const decisions: SeedDecisionRow[] = [];

  for (const profile of profilesInOrder()) {
    const policy = fx.policy.find((p: any) => p.external_ref === `POL-${profile}`);
    if (!policy) throw new Error(`no policy fixture for ${profile}`);
    const plan = plans.get(policy.plan_id)!;
    const submittedBy = ownerOf.get(policy.person_id)!;
    const supplied = events.filter((e) => e.profile_id === profile && (options.appeals !== "pending" || e.kind !== "appeal"));
    const log = supplied.map((e, i) => toReplayEvent(e, i + 1));

    const idOf = (ref: string) => CURATED[ref]?.id ?? uuid5(`servicing_event:${ref}`);
    /** Results as submitted, so an appeal can be explained against the finding it contests. */
    const submitted = new Map<string, { result: AdjudicationResult; event: ReplayEvent; occurredOn: string }>();

    supplied.forEach((e, i) => {
      const ev = log[i];
      const curated = CURATED[e.id];
      // Meet the event the way the live system will: replay the history so far,
      // this event included, and read this event's step.
      const prefix = replay(plan, log.slice(0, i + 1));
      const step = prefix.steps.find((s) => s.event.id === ev.id);

      const contestedInfo = e.kind === "appeal" ? submitted.get(e.contests)! : null;
      // Dates are derived, not typed: an event lands a couple of days into its policy month, and
      // an appeal five days after the event it contests. The two curated rows keep their own dates.
      const occurredOn =
        curated?.occurredOn ??
        (contestedInfo ? addDays(contestedInfo.occurredOn, 5) : addDays(addMonths(policy.inception_date, e.policy_month), 2));
      const createdAt = new Date(Date.parse(`${occurredOn}T09:00:00Z`) + (i + 1) * 60_000);

      const priorPayable = prefix.steps
        .filter((s) => s.event.id !== ev.id && s.event.kind !== "preauth" && (s.result.planPays ?? 0) > 0)
        .map((s) => ({ ref: s.event.id, month: s.event.policyMonth, benefitClass: s.event.benefitClass as BenefitClass, planPays: s.result.planPays ?? 0 }));

      const priorDenied = prefix.steps
        .filter((s) => s.event.id !== ev.id && s.result.outcome === "denied")
        .map((s) => ({ ref: s.event.id, month: s.event.policyMonth, benefitClass: s.event.benefitClass as BenefitClass, reasonCode: s.result.reasonCode as ReasonCode }));

      let row: SeedEventRow;
      const common = {
        id: idOf(e.id),
        externalRef: e.id,
        policyId: policy.id,
        kind: e.kind as EventKind,
        policyMonth: e.policy_month,
        submittedByUserId: submittedBy,
        occurredOn,
        createdAt,
      };

      if (e.kind !== "appeal") {
        const result = step!.result;
        submitted.set(e.id, { result, event: ev, occurredOn });
        const text = curated
          ? { member: curated.member, broker: curated.broker }
          : explain({
              kind: e.kind,
              eventRef: e.id,
              policyRef: policy.external_ref,
              plan,
              inceptionDate: policy.inception_date,
              policyMonth: e.policy_month,
              benefitClass: ev.benefitClass!,
              providerTier: ev.providerTier!,
              geography: ev.geography ?? "uae",
              amount: ev.amount!,
              result,
              priorPayable,
              priorDenied,
            });
        const undecidable = result.outcome === "insufficient_data";
        row = {
          ...common,
          benefitClass: ev.benefitClass,
          setting: e.setting,
          providerTier: ev.providerTier,
          geography: ev.geography ?? "uae",
          billedAmount: e.kind === "preauth" ? null : ev.amount,
          estimatedAmount: e.kind === "preauth" ? ev.amount : null,
          description: curated?.description ?? e.event,
          outcome: result.outcome,
          reasonCode: result.reasonCode,
          planPays: result.planPays,
          memberPays: result.memberPays,
          calculation: result.calculation,
          ledgerBefore: ledgerJson(result.ledgerBefore),
          ledgerAfter: ledgerJson(result.ledgerAfter),
          memberExplanation: text.member,
          brokerExplanation: text.broker,
          // Deterministic arithmetic over stated terms is as settled as it gets; the one
          // exception is the case the plan data cannot answer, which carries no confidence at all.
          confidence: undecidable ? null : 0.95,
          uncertaintyReason: undecidable
            ? "The plan defines no geographic scope and the provider could not be placed in a network tier — this cannot be decided from the plan data."
            : null,
          decidedBy: "system",
        };
      } else {
        const decision = APPEAL_DECISIONS[e.id];
        const contested = submitted.get(e.contests)!;
        const cev = contested.event;
        const evidence: string[] = e.evidence_attached ?? [];
        const evidenceText = [
          e.applicant_claim,
          e.on_file ? `On file from intake: ${e.on_file}` : null,
          evidence.length ? `Evidence attached: ${evidence.join("; ")}` : "Evidence attached: none.",
        ]
          .filter(Boolean)
          .join("\n\n");

        if (decision.verdict === "upheld") {
          // The denial stands. The row is the record that it was looked at again; the ledger does not move.
          const orig = contested.result;
          const ledger = prefix.ledger;
          const text = explain({
            kind: "appeal",
            eventRef: e.id,
            policyRef: policy.external_ref,
            plan,
            inceptionDate: policy.inception_date,
            policyMonth: e.policy_month,
            benefitClass: cev.benefitClass!,
            providerTier: cev.providerTier!,
            geography: cev.geography ?? "uae",
            amount: cev.amount!,
            result: orig,
            appeal: {
              appealRef: e.id,
              contestedRef: e.contests,
              contestedReason: orig.reasonCode as ReasonCode,
              verdict: "upheld",
              evidenceSupplied: evidence.length > 0,
              declaredAtIntake: decision.declaredAtIntake,
            },
            priorPayable,
          });
          row = {
            ...common,
            benefitClass: cev.benefitClass,
            setting: supplied.find((s) => s.id === e.contests).setting,
            providerTier: cev.providerTier,
            geography: "uae",
            billedAmount: cev.amount,
            description: `Appeal — ${eventByRef.get(e.contests).event}`,
            evidenceText,
            outcome: "upheld",
            reasonCode: orig.reasonCode,
            planPays: orig.planPays,
            memberPays: orig.memberPays,
            // The trace is shown to the member too: reason and wording, never a reference or an enum.
            calculation: [
              `appeal against the earlier decision: ${reasonCodeLabel[orig.reasonCode as ReasonCode]}`,
              evidence.length ? "the evidence supplied does not bear on that finding" : "no evidence was attached",
              `the decision stands — plan pays ${orig.planPays}, member pays ${orig.memberPays}`,
            ],
            ledgerBefore: ledgerJson(ledger),
            ledgerAfter: ledgerJson(ledger),
            memberExplanation: text.member,
            brokerExplanation: text.broker,
            confidence: decision.confidence,
            uncertaintyReason: decision.uncertainty,
            decidedBy: "system",
            appealOfEventId: idOf(e.contests),
          };
          submitted.set(e.id, { result: orig, event: cev, occurredOn });
          // Upheld with no admissible evidence, on a reading of a declared condition against the member's own account: a close call
          // that still resolved. It blocks nothing, and it must not be invisible (plan §13.3.1) — a QUALITY CHECK, band 40.
          tasks.push({
            id: uuid5(`review_task:${e.id}`),
            subjectType: "servicing_event",
            subjectId: row.id!,
            reason: `Quality check: ${e.id} — ${decision.uncertainty}`,
            priorityScore: 40,
            status: "open",
            createdAt,
          });
        } else {
          const result = step!.result;
          const orig = contested.result;
          const text = explain({
            kind: "appeal",
            eventRef: e.id,
            policyRef: policy.external_ref,
            plan,
            inceptionDate: policy.inception_date,
            policyMonth: ev.policyMonth,
            benefitClass: ev.benefitClass!,
            providerTier: ev.providerTier!,
            geography: "uae",
            amount: ev.amount!,
            result,
            appeal: {
              appealRef: e.id,
              contestedRef: e.contests,
              contestedReason: orig.reasonCode as ReasonCode,
              verdict: "overturned",
              evidenceSupplied: true,
              evidenceSummary: decision.evidenceSummary,
              evidenceSummaryBroker: decision.evidenceSummaryBroker,
              correction: { field: decision.correction!.field, from: cev.providerTier!, to: decision.correction!.to },
            },
            priorPayable,
          });
          const advisorId = userByName.get(decision.decidedByAdvisor!);
          if (!advisorId) throw new Error(`no advisor named ${decision.decidedByAdvisor}`);
          row = {
            ...common,
            benefitClass: ev.benefitClass,
            setting: supplied.find((s) => s.id === e.contests).setting,
            providerTier: ev.providerTier,
            geography: "uae",
            billedAmount: ev.amount,
            description: `Appeal — ${eventByRef.get(e.contests).event}`,
            evidenceText,
            outcome: "overturned",
            reasonCode: result.reasonCode,
            planPays: result.planPays,
            memberPays: result.memberPays,
            calculation: [
              `appeal against the earlier decision: ${reasonCodeLabel[orig.reasonCode as ReasonCode]}`,
              `${decision.correction!.field} corrected from ${providerTypeLabel[cev.providerTier!].toLowerCase()} to ${providerTypeLabel[decision.correction!.to].toLowerCase()} on the evidence supplied`,
              ...result.calculation,
            ],
            ledgerBefore: ledgerJson(result.ledgerBefore),
            ledgerAfter: ledgerJson(result.ledgerAfter),
            memberExplanation: text.member,
            brokerExplanation: text.broker,
            confidence: decision.confidence,
            uncertaintyReason: decision.uncertainty,
            decidedBy: "advisor",
            decidedByUserId: advisorId,
            supersedesEventId: idOf(e.contests),
            appealOfEventId: idOf(e.contests),
          };
          submitted.set(e.id, { result, event: ev, occurredOn });

          // An overturn moves money and rewrites the ledger at a past point, so it takes a signature.
          const taskId = uuid5(`review_task:${e.id}`);
          tasks.push({
            id: taskId,
            subjectType: "servicing_event",
            subjectId: row.id!,
            reason: `Appeal overturn ready to sign: ${e.contests} reverses to a payment of AED ${(result.planPays ?? 0).toLocaleString("en")}.`,
            priorityScore: 90,
            status: "resolved",
            assignedToUserId: advisorId,
            createdAt,
            resolvedAt: new Date(createdAt.getTime() + 2 * 3_600_000),
          });
          decisions.push({
            id: uuid5(`review_decision:${e.id}`),
            reviewTaskId: taskId,
            actorUserId: advisorId,
            action: "overturn",
            notes: decision.signOffNote,
            payload: { supersedes: e.contests, correction: { [decision.correction!.field]: decision.correction!.to } },
            decidedAt: new Date(createdAt.getTime() + 2 * 3_600_000),
          });
        }
      }

      rows.push(row);

      // The one event the plan data cannot answer stays open, so the broker's queue has a real row in it.
      if (row.outcome === "insufficient_data") {
        tasks.push({
          id: uuid5(`review_task:${e.id}`),
          subjectType: "servicing_event",
          subjectId: row.id!,
          reason: `${e.id} cannot be decided from the plan terms: the plan defines no cover for treatment outside the UAE.`,
          priorityScore: 100,
          status: "open",
          createdAt,
        });
      }
    });

  }

  return { events: rows, tasks, decisions };
}
