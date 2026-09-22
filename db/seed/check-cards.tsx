// The servicing cards, rendered — and read the way a member reads them.
//
//   bun run db/seed/check-cards.tsx
//
// check-servicing-tools.ts scans the card PAYLOADS. That misses everything a component writes for
// itself ("Request received. An advisor will call you."), so this renders every card to HTML and
// scans the text that would actually reach a screen. It also checks what can be checked without a
// browser: every control has an accessible name, touch targets are large enough, the estimate cannot
// be mistaken for a decision, and nothing is pre-selected on a conflict. Interaction and layout
// are checked in a browser (the dev gallery).
import { renderToStaticMarkup } from "react-dom/server";
import { CALLBACK_RECEIVED } from "@/components/servicing/cards/escalation-card";
import { ServicingCardView } from "@/components/servicing/cards/servicing-card";
import { INTERNAL_REF, isEscalationCard, isEstimateCard, isOutcomeCard, memberCopyViolations, type ServicingCard } from "@/lib/servicing";
import { allGalleryCards as galleryCards } from "./gallery";

/* eslint-disable @typescript-eslint/no-explicit-any */
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${!ok && detail ? `\n         ${detail}` : ""}`);
};

const PHONE = "+971 00 000 0000";
const render = (card: unknown, extra: Record<string, unknown> = {}) => renderToStaticMarkup(<ServicingCardView card={card} advisorPhone={PHONE} {...extra} />);
const textOf = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&apos;|&#x27;|&#39;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const items = galleryCards();
const byKind = (kind: string) => items.filter((i) => i.card.kind === kind);
const first = (kind: string): ServicingCard => byKind(kind)[0].card;

console.log("\nEvery card renders");
{
  const empty = items.filter((i) => render(i.card).length < 100).map((i) => i.label);
  check(`all ${items.length} gallery cards render to real markup`, empty.length === 0, empty.join(", "));
  check("a malformed payload renders nothing — the guard refuses it before any component sees it", render({ kind: "servicing_outcome" }) === "" && render(null) === "" && render({ ...(first("servicing_outcome") as any), confidence: 0.9 }) === "");
}

console.log("\nEverything a member would read is fit to read");
{
  // The escalation reference is the one deliberate member-visible handle; everything else is scanned.
  const leaks = items.flatMap((i) => {
    let text = textOf(render(i.card));
    if (isEscalationCard(i.card)) text = text.replace(i.card.reference, "");
    return memberCopyViolations(text).map((v) => `${i.label}: ${v}`);
  });
  check("no rendered card — chrome, static copy, chips, traces — carries internal vocabulary, a raw enum, a reference in prose or a time promise", leaks.length === 0, leaks.slice(0, 5).join("; "));
  const esc = items.find((i) => isEscalationCard(i.card))!;
  const escHtml = render(esc.card);
  check("the escalation card never says why the case left the agent", !/insufficient|cause|because|reviewer/i.test(textOf(escHtml)));
  check("...and its 'request received' copy promises no time (it is not in the payload, so only a render can prove it)", memberCopyViolations(CALLBACK_RECEIVED).length === 0 && /call you/.test(CALLBACK_RECEIVED));
}

console.log("\nNo card says the same thing twice");
{
  // The queue used to print one sentence twice — the title and the note under it — and it read as a stutter.
  // Found in the gallery, on the outcome card: the explanation and the settlement footer both said who pays.
  const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim().toLowerCase()).filter((x) => x.length >= 30);
  const repeats = items.flatMap((i) => {
    const seen = new Set<string>();
    return sentences(textOf(render(i.card))).filter((x) => (seen.has(x) ? true : (seen.add(x), false))).map((x) => `${i.label}: "${x.slice(0, 60)}…"`);
  });
  check("no rendered card repeats a sentence", repeats.length === 0, repeats.join("; "));
}

console.log("\nControls have names, and touch targets are big enough");
{
  const all = items.map((i) => ({ label: i.label, html: render(i.card) }));
  const unnamed = all.flatMap(({ label, html }) =>
    [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
      .filter((m) => !/aria-label="[^"]+"/.test(m[1]) && textOf(m[2]) === "")
      .map(() => label),
  );
  check("every button has an accessible name (visible text or aria-label)", unnamed.length === 0, unnamed.join(", "));

  const unlabeled = all.flatMap(({ label, html }) =>
    [...html.matchAll(/<(input|textarea|select)\b([^>]*)>/g)]
      .filter((m) => !/type="radio"/.test(m[2]))
      .filter((m) => {
        const id = /\bid="([^"]+)"/.exec(m[2])?.[1];
        return !/aria-label="[^"]+"/.test(m[2]) && !(id && new RegExp(`<label[^>]*for="${id}"`).test(html));
      })
      .map(() => label),
  );
  check("every text input, textarea and select has a label", unlabeled.length === 0, unlabeled.join(", "));

  const small = all.flatMap(({ label, html }) =>
    [...html.matchAll(/<(button|a)\b([^>]*)>/g)].filter((m) => !/min-h-11|size-11/.test(m[2]) && !/<summary/.test(m[0])).map(() => label),
  );
  check("every button and link is at least 44px (min-h-11 / size-11) — a claim is usually submitted from a phone", small.length === 0, [...new Set(small)].join(", "));
  check("every question chip is a real button with a pressed state", /<button[^>]*aria-pressed="false"/.test(render(first("servicing_question"))));
}

console.log("\nQuestion cards");
{
  const chipCard = items.find((i) => i.card.kind === "servicing_question" && (i.card as any).chips.length > 0)!.card;
  const open = render(chipCard);
  // Match the ATTRIBUTE, with its leading space: the class list contains the word "disabled:" (Tailwind) and
  // base-ui also writes data-disabled="", either of which would be counted by a looser pattern.
  const disabledCount = (html: string) => (html.match(/ disabled=""/g) ?? []).length;
  check("every chip is enabled while the question is open", disabledCount(open) === 0);
  const answered = render(chipCard, { answered: (chipCard as any).chips[0].label });
  check("once answered, the chosen chip shows pressed and every other chip is disabled", /aria-pressed="true"/.test(answered) && disabledCount(answered) === (chipCard as any).chips.length - 1, `disabled=${disabledCount(answered)} chips=${(chipCard as any).chips.length}`);
  check("the provider question offers 'Not sure' as a chip like any other", /Not sure/.test(render(items.find((i) => i.card.kind === "servicing_question" && (i.card as any).fieldKey === "provider_type")!.card)));
}

console.log("\nFree-text questions and the evidence request");
{
  const typed = items.filter((i) => i.card.kind === "servicing_question" && (i.card as any).chips.length === 0);
  check("the gallery has free-text questions (an amount and a date), so those controls are actually exercised", typed.length >= 2);
  const html = typed.map((i) => render(i.card)).join("");
  check("a free-text question has a labelled input and a named Send button", /aria-label="Send answer"/.test(html) && /<input[^>]*aria-label="[^"]+"/.test(html));
  check("an amount is asked as AED with a decimal keypad, and a date as a date input", /inputMode="decimal"|inputmode="decimal"/.test(html) && /type="date"/.test(html) && />AED</.test(html));
  const ev = render(first("servicing_evidence_request"));
  check("the evidence request has a real way to say no — a button, not just a payload flag", /I don't have this/.test(textOf(ev)) && /<textarea/.test(ev) && /for="evidence-text"/.test(ev));
}

console.log("\nThe appeal: what the decision turned on, the request, and how it ends");
{
  const intro = render(first("servicing_appeal_intro"));
  const introText = textOf(intro);
  check("the appeal opens by saying what the decision turned on, and what could change it, BEFORE it asks for anything", /This decision turned on/.test(introText) && /What could change it/.test(introText) && !/<textarea|<button/.test(intro));
  check("...and what cannot, kindly, so a member does not send a document that cannot help", /What can't change it on its own/.test(introText));
  check("a finding with nothing on the 'cannot' list does not print an empty heading", !/What can't change it on its own/.test(textOf(render({ ...(first("servicing_appeal_intro") as any), cannotChange: [] }))));
  check("the appeal intro is closed like every card: an undeclared key is refused", render({ ...(first("servicing_appeal_intro") as any), confidence: 0.9 }) === "" && render({ ...(first("servicing_appeal_intro") as any), couldChange: [] }) === "");
  const ask = render(first("servicing_evidence_request"));
  check("the evidence request shows where the document is: asked, received, checked — with the current step marked", /aria-label="Progress"/.test(ask) && /Asked/.test(textOf(ask)) && /Received/.test(textOf(ask)) && /Checked/.test(textOf(ask)) && /aria-current="step"/.test(ask));
  check("once the member has answered, the track has moved on to 'Received'", /aria-current="step"[^>]*>[\s\S]{0,120}Received/.test(render(first("servicing_evidence_request"), { answered: "I don't have this" })));
  const upheld = items.find((i) => (i.card as any).eventKind === "appeal" && (i.card as any).outcome === "upheld")!;
  const reversed = items.find((i) => (i.card as any).eventKind === "appeal" && (i.card as any).outcome === "overturned")!;
  check("an upheld appeal reads 'Decision stands', with no way to appeal it again", /Decision stands/.test(textOf(render(upheld.card))) && !/Appeal this decision/.test(render(upheld.card, { canAppeal: true })));
  check("a reversal reads 'Decision reversed' and shows the money", /Decision reversed/.test(textOf(render(reversed.card))) && /4,400/.test(textOf(render(reversed.card))));
  // Next steps are usually deduped against the prose, so a denial often has none; give this one a step so the appeal button sits under a list.
  const denial = { ...(items.find((i) => (i.card as any).appealable === true)!.card as any), nextSteps: ["A dated step the explanation did not already say."] };
  check("the outcome card of an ordinary denial offers the appeal only when told it may — the LOG decides, not the card", /Appeal this decision/.test(render(denial, { canAppeal: true })) && !/Appeal this decision/.test(render(denial, { canAppeal: false })));
}

console.log("\nConfirm, conflict and the no-model form");
{
  const inferred = items.find((i) => i.label.includes("worked out"))!;
  const html = render(inferred.card);
  check("rows the model worked out are marked 'please check'", /Worked out — please check/.test(textOf(html)));
  const told = render(first("servicing_confirm"));
  check("the confirm card offers both 'Looks right' and 'Change something'", /Looks right/.test(told) && /Change something/.test(told));

  const conflict = render(first("servicing_conflict"));
  check("a conflict pre-selects nothing: both options exist, neither is pressed", (conflict.match(/aria-pressed="false"/g) ?? []).length === 2 && !/aria-pressed="true"/.test(conflict));
  check("...and neither is labelled recommended or default", !/recommend|default|suggested/i.test(textOf(conflict)));
  check("...and both name their source and quote it", /Your document/.test(conflict) && /What you told me/.test(conflict));

  const form = render(first("servicing_facts_form"));
  check("the no-model form lists only the missing fields, each labelled, with Continue disabled until they are filled", /Provider/.test(form) && /Amount/.test(form) && !/Treatment<|>Treatment</.test(textOf(form).replace(/Treatment/, "")) && /<button[^>]*disabled=""[^>]*>[\s\S]*?Continue/.test(form));
}

console.log("\nOutcome and estimate");
{
  const covered = items.find((i) => i.label === "Outcome — covered")!;
  const html = render(covered.card);
  // money() uses a non-breaking space between "AED" and the figure, so compare against normalised text.
  check("the outcome card shows the three figures a member reads: AED 1,800 billed, AED 1,260 from the plan, AED 540 theirs", /AED 1,800/.test(textOf(html)) && /AED 1,260/.test(textOf(html)) && /AED 540/.test(textOf(html)));
  check("a covered claim offers no appeal", !/Appeal this decision/.test(html));
  const denied = items.find((i) => i.label.startsWith("Outcome — not covered"))!;
  const dh = render(denied.card);
  check("a denial ends at something to do: a dated next step, and an appeal", /What you can do/.test(dh) && /1 July 2026/.test(dh) && /Appeal this decision/.test(dh));
  const est = items.find((i) => isEstimateCard(i.card))!;
  const eh = render(est.card);
  check("an estimate cannot be mistaken for a decision: dashed border, an Estimate badge, softer wording, and the caveat", /border-dashed/.test(eh) && />Estimate</.test(eh) && /Covered up to a limit/.test(eh) && /Plan would pay/.test(eh) && /Nothing has been claimed/.test(eh));
  check("...and a real outcome is NOT dashed and carries no Estimate badge", !/border-dashed/.test(html) && !/>Estimate</.test(html));
  const reimb = items.find((i) => i.label === "Outcome — reimbursement")!;
  const rh = render(reimb.card);
  check("a reimbursement reads as money back: 'You paid', 'Plan pays you back', 'Your cost'", /You paid/.test(rh) && /Plan pays you back/.test(rh) && /Your cost/.test(rh) && /paid back to you/.test(rh));
  check("the calculation trace is a closed <details>, not open by default", /<details(?![^>]*\bopen\b)[^>]*>/.test(html));
  check("every outcome card carries its own explanation and figures (no card is a stub)", items.filter((i) => isOutcomeCard(i.card) || isEstimateCard(i.card)).every((i) => textOf(render(i.card)).length > 200));
}

console.log("\nEscalation");
{
  const esc = items.find((i) => isEscalationCard(i.card))!;
  const withPhone = render(esc.card);
  check("with a number configured: a tel: link, and the number readable as text (a tel: link does nothing on a laptop)", /href="tel:\+971000000000"/.test(withPhone) && /Or call \+971 00 000 0000/.test(textOf(withPhone)));
  const without = renderToStaticMarkup(<ServicingCardView card={esc.card} advisorPhone={null} />);
  check("with none configured: no call button at all — only the callback — and no invented number", !/tel:/.test(without) && !/Call an advisor/.test(without) && /Request a callback/.test(without));
  check("the reference is shown for the member to quote", INTERNAL_REF.test(textOf(withPhone)));
  check("'What your advisor will have' is present and closed by default", /What your advisor will have/.test(withPhone) && /<details(?![^>]*\bopen\b)/.test(withPhone));
  check("the number is never in the payload: it is configuration, not something a model can write", !JSON.stringify(esc.card).includes("+971") && !JSON.stringify(esc.card).includes("tel:"));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
