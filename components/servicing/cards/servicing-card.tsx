"use client";

// One switch over the nine card kinds. The thread (phase 4) renders a payload through this and nothing
// else; an unrecognised payload is refused by the guard before it ever reaches a component.

import { isServicingCard, type ServicingCard as Payload } from "@/lib/servicing/cards";
import { AppealIntroCard } from "./appeal-intro-card";
import { ConfirmCard } from "./confirm-card";
import { ConflictCard } from "./conflict-card";
import { EscalationCard } from "./escalation-card";
import { EvidenceRequestCard } from "./evidence-request-card";
import { FactsFormCard } from "./facts-form-card";
import { OutcomeCard } from "./outcome-card";
import { QuestionCard } from "./question-card";
import type { CardViewProps } from "./shell";

export type ServicingCardViewProps = CardViewProps & {
  card: unknown;
  /** Server-side configuration; only the escalation card uses it. */
  advisorPhone?: string | null;
  defaultPhone?: string;
  callbackRequested?: boolean;
  /** Whether "Appeal this decision" is offered — the thread says so per card, from the log (plan §5.4.1). */
  canAppeal?: boolean;
};

export function ServicingCardView({ card, advisorPhone = null, defaultPhone, callbackRequested, canAppeal = true, ...view }: ServicingCardViewProps) {
  // The payload came out of a database column: check it, never assume it.
  if (!isServicingCard(card)) return null;
  const c: Payload = card;
  switch (c.kind) {
    case "servicing_question":
      return <QuestionCard card={c} {...view} />;
    case "servicing_confirm":
      return <ConfirmCard card={c} {...view} />;
    case "servicing_facts_form":
      return <FactsFormCard card={c} {...view} />;
    case "servicing_evidence_request":
      return <EvidenceRequestCard card={c} {...view} />;
    case "servicing_appeal_intro":
      return <AppealIntroCard card={c} {...view} />;
    case "servicing_conflict":
      return <ConflictCard card={c} {...view} />;
    case "servicing_outcome":
    case "servicing_estimate":
      return <OutcomeCard card={c} canAppeal={canAppeal} {...view} />;
    case "servicing_escalation":
      return <EscalationCard card={c} advisorPhone={advisorPhone} defaultPhone={defaultPhone} callbackRequested={callbackRequested} {...view} />;
  }
}
