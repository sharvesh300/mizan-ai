// Reading the no-model form.
//
// With no model key — or after a failed turn — the agent's question is a form, and its answers arrive as raw
// strings. They still have to become the SAME validated facts a tool call produces, or the two modes would
// adjudicate different things. So a submission goes through `record_fact` like everything else; what this
// file adds is the part `record_fact` cannot do: it speaks to the member. A tool's refusal is written for an
// agent ("quote is not a verbatim span of anything the member has said"). A member who typed 31 February
// needs "That isn't a real date", and needs it against the field they got wrong.
//
// It also builds the message the member appears to have sent. The thread shows their answers as one readable
// line, and that line is what every later quote is checked against — so the quotes and the line are made here,
// together, and cannot disagree.
//
// Pure, and free of `server-only`, like everything in lib/servicing.

import { claimProviderTierEnum, type BenefitClass, type ClaimProviderTier } from "@/db/schema/enums";
import { isRealDate, longDate, monthOfDate } from "./dates";
import { FACT_VALUE, FIELD_KEYS, fieldsFor, type FieldKey, type Intent } from "./facts";
import { benefitClassLabel, providerTypeLabel } from "./labels";

export type FormKey = FieldKey | "benefit_class";

export type FormEntry = {
  key: FieldKey;
  /** The validated value, ready for `record_fact`. */
  value: string | number | boolean;
  /** A verbatim span of `summary`, so the quote check passes for the right reason. */
  quote: string;
};

export type FormReading = {
  entries: FormEntry[];
  /** What the member's message reads as in the thread: "Physiotherapy · 4 September 2026 · Clinic · AED 1,800". */
  summary: string;
  benefitClass: { value: BenefitClass; declaredCondition: string | null } | null;
  /** Per field, in words a member can act on. */
  errors: Partial<Record<FormKey, string>>;
};

const money = (n: number) => `AED ${Number.isInteger(n) ? n.toLocaleString("en") : n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "1,800", "AED 1800" and "1800.50" are all amounts; "about two thousand" is not. */
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/aed/gi, "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function interpretForm(
  values: Record<string, string>,
  ctx: { intent: Intent; inceptionDate: string; today: string; declaredConditions: string[] },
): FormReading {
  const errors: FormReading["errors"] = {};
  const entries: FormEntry[] = [];
  const shown: string[] = [];
  const applies = new Set<string>(fieldsFor(ctx.intent));
  const given = (k: string) => (values[k] ?? "").trim();

  for (const key of FIELD_KEYS) {
    const raw = given(key);
    if (!raw || !applies.has(key)) continue;

    switch (key) {
      case "treatment": {
        if (!FACT_VALUE.treatment.safeParse(raw).success) {
          errors.treatment = "Tell me a little about the treatment — a few words is enough.";
          break;
        }
        entries.push({ key, value: raw, quote: raw });
        shown.push(raw);
        break;
      }
      case "treatment_date": {
        if (!isRealDate(raw)) {
          errors.treatment_date = "That isn't a real date. Pick the day of the treatment.";
        } else if (raw > ctx.today) {
          errors.treatment_date = "That date is still to come. For something you're planning, use “Is this covered?” instead.";
        } else {
          try {
            monthOfDate(ctx.inceptionDate, raw);
            const shownDate = longDate(raw);
            entries.push({ key, value: raw, quote: shownDate });
            shown.push(shownDate);
          } catch {
            errors.treatment_date = `That's before your policy started on ${longDate(ctx.inceptionDate)}, so it can't be claimed.`;
          }
        }
        break;
      }
      case "provider_type": {
        if (!(claimProviderTierEnum as readonly string[]).includes(raw)) {
          errors.provider_type = "Choose the kind of place it was from the list.";
          break;
        }
        const label = providerTypeLabel[raw as ClaimProviderTier];
        entries.push({ key, value: raw, quote: label });
        shown.push(label);
        break;
      }
      case "provider_name": {
        if (!FACT_VALUE.provider_name.safeParse(raw).success) {
          errors.provider_name = "Enter the name as it appears on your bill, or leave this blank.";
          break;
        }
        entries.push({ key, value: raw, quote: raw });
        shown.push(raw);
        break;
      }
      case "amount": {
        const n = parseAmount(raw);
        if (n === null || !FACT_VALUE.amount.safeParse(n).success) {
          errors.amount = "Enter the total as a number, like 1,800.";
          break;
        }
        // The quote is the FIGURE, as it appears in the summary: the tool checks the digits are in the member's words.
        entries.push({ key, value: n, quote: n.toLocaleString("en", { maximumFractionDigits: 2 }) });
        shown.push(money(n));
        break;
      }
      case "paid_by_member": {
        if (raw !== "yes" && raw !== "no") {
          errors.paid_by_member = "Tell me whether you've already paid.";
          break;
        }
        const label = raw === "yes" ? "Paid the provider" : "Not paid yet";
        entries.push({ key, value: raw === "yes", quote: label });
        shown.push(label);
        break;
      }
    }
  }

  // What kind of treatment it is, if the form asked.
  let benefitClass: FormReading["benefitClass"] = null;
  const cls = given("benefit_class");
  if (cls) {
    if (cls.startsWith("chronic:")) {
      const name = cls.slice("chronic:".length);
      const match = ctx.declaredConditions.find((c) => c.toLowerCase() === name.toLowerCase());
      if (match) {
        benefitClass = { value: "chronic_preexisting", declaredCondition: match };
        shown.push(`for my ${match}`);
      } else errors.benefit_class = "Choose one of the options listed.";
    } else if (cls === "general" || cls === "maternity" || cls === "dental_optical") {
      benefitClass = { value: cls, declaredCondition: null };
      shown.push(benefitClassLabel[cls]);
    } else errors.benefit_class = "Choose one of the options listed.";
  }

  return { entries, summary: shown.join(" · "), benefitClass, errors };
}
