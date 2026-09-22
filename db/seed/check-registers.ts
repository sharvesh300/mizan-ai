// A static fence around the two registers (plan §13.4, §18.8).
//
//   bun run db/seed/check-registers.ts
//
// The compiler already refuses a member component that reaches for a column the
// customer view does not have. This is the second, independent fence, and it
// catches what types cannot: a reintroduced `isAdvisor ?` branch inside a shared
// component, or a member query quietly drifting back to the raw table. Comments
// are stripped first — the files say what they must not do, and that is fine.
import { readFileSync, readdirSync } from "node:fs";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${!ok && detail ? `\n         ${detail}` : ""}`);
};

const code = (file: string): string =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** What a member's tree must never name: a broker-only field, the raw table, or a role branch. */
const MEMBER_FORBIDDEN =
  /\bisAdvisor\b|brokerExplanation|brokerReasoning|uncertaintyReason|\bconfidence\b|decidedBy|\bcohort\b|\bservicingEvent\b|\bplanFitReassessment\b|\.role\b/;

/** Shared primitives serve both audiences, so they must not know which is asking. */
const SHARED_FORBIDDEN = /\bisAdvisor\b|\brole\b|\badvisor\b|brokerExplanation|brokerReasoning|uncertaintyReason|decidedBy/;

const memberFiles = [
  "components/servicing/member-event-card.tsx",
  "components/servicing/member-policy-view.tsx",
  // The conversation surface and everything on it is the member's: the thread, the two things that start one, and every card.
  "components/servicing/servicing-thread.tsx",
  "components/servicing/servicing-thread-page.tsx",
  "components/servicing/servicing-actions.tsx",
  "components/servicing/appeal-button.tsx",
  ...readdirSync("components/servicing/cards").filter((f) => f.endsWith(".tsx") && f !== "gallery.tsx").map((f) => `components/servicing/cards/${f}`),
];
const sharedFiles = ["components/servicing/primitives.tsx", "components/servicing/policy-cover.tsx", "components/servicing/citation-chip.tsx"];

console.log("\nMember components");
for (const file of memberFiles) {
  const hit = code(file).match(MEMBER_FORBIDDEN);
  check(`${file} names no broker-only field, raw event table, or role branch`, !hit, hit ? `found: ${hit[0]}` : "");
}

console.log("\nShared primitives");
for (const file of sharedFiles) {
  const hit = code(file).match(SHARED_FORBIDDEN);
  check(`${file} takes no role and names no broker-only field`, !hit, hit ? `found: ${hit[0]}` : "");
}

console.log("\nThe broker's case page stays the broker's");
{
  const memberTree = memberFiles.map((f) => code(f)).join("\n");
  check("no member component imports the case page's data or components", !/lib\/servicing\/case|components\/servicing\/case\/|servicing-signoff|overturnProposal|OverturnProposal/.test(memberTree));
  const page = code("app/policies/[id]/events/[eventId]/page.tsx");
  check("the case page 404s a member rather than redirecting: the URL is not confirmed to exist", /role !== "advisor"\) notFound\(\)/.test(page));
  const actions = code("app/policies/[id]/events/[eventId]/actions.ts");
  check("every verb on a reversal checks the caller is an advisor at the door, before the sign-off layer re-checks it against the row", /role !== "advisor"/.test(actions) && /getCurrentUser/.test(actions));
  const member = code("app/policies/[id]/service/actions.ts");
  check("the member's server actions never reach the sign-off: a member cannot sign their own reversal", !/servicing-signoff|confirmReversal|upholdInstead/.test(member));
  const thread = code("lib/ai/servicing-session.ts").slice(code("lib/ai/servicing-session.ts").indexOf("export async function readServicingThread"));
  check("what the member's thread reads carries no proposal, no broker prose and no confidence", !/appeal_overturn_proposal|brokerExplanation|confidence|uncertaintyReason/.test(thread.slice(0, thread.indexOf("export {") > 0 ? thread.indexOf("export {") : undefined)));
}

console.log("\nThe reassessment case page stays the broker's");
{
  const memberTree = memberFiles.map((f) => code(f)).join("\n");
  check("no member component imports the reassessment case page's data or components", !/reassess-case|reassessment-case-page|reassessment-decision|servicing-reassess/.test(memberTree));
  const page = code("app/policies/[id]/reassess/[reassessmentId]/page.tsx");
  check("the reassessment case page 404s a member rather than redirecting: the URL is not confirmed to exist", /role !== "advisor"\) notFound\(\)/.test(page));
  const actions = code("app/policies/[id]/reassess/[reassessmentId]/actions.ts");
  check("every verb on a reassessment checks the caller is an advisor at the door, before the session layer re-checks it against the row", /role !== "advisor"/.test(actions) && /getCurrentUser/.test(actions));
}

console.log("\nA payout is the broker's record, not the member's");
{
  const memberTree = memberFiles.map((f) => code(f)).join("\n");
  check("no member component imports the settlement panel or its actions", !/settlement-panel|settlements\/actions|servicing-settlement/.test(memberTree));
  const actions = code("app/policies/[id]/settlements/actions.ts");
  check("both payout verbs check the caller is an advisor at the door, before the session layer re-checks against the row", /role !== "advisor"/.test(actions) && /getCurrentUser/.test(actions));
  const panel = code("components/servicing/settlement-panel.tsx");
  check("the panel that shows the reference and who signed it is a BROKER component — it is not in the member tree", !memberFiles.some((f) => f.includes("settlement-panel")) && /paymentReference/.test(panel));
}

console.log("\nThe member queries");
{
  const queries = readFileSync("lib/queries.ts", "utf8");
  const between = (from: string, to: string) => {
    const a = queries.indexOf(from);
    const b = queries.indexOf(to, a);
    return a >= 0 && b > a ? queries.slice(a, b) : "";
  };
  const events = code("lib/queries.ts") && between("export async function listMemberEvents", "export type MemberEvent");
  check("listMemberEvents reads the customer view and never the raw table", /customerEventView/.test(events) && !/servicingEvent\b/.test(events), events.slice(0, 120));
  const reassess = between("export async function listMemberReassessments", "export type MemberReassessment");
  check("listMemberReassessments never selects the broker's reasoning", reassess.length > 0 && !/brokerReasoning/.test(reassess));
  check("listMemberReassessments withholds an unapproved recommend_change — a sales act needs a person to have looked", /recommend_change/.test(reassess) && /reviewDecision/.test(reassess) && /approve.*edit|edit.*approve/.test(reassess));
  const settle = between("export async function listMemberSettlements", "/** BROKER ONLY — the whole payout record");
  check("listMemberSettlements selects the status and the date, and nothing else", settle.length > 0 && /status/.test(settle) && /paidAt/.test(settle));
  check(
    "...never the payment reference, who approved it, who paid it, or the note — those are the broker's record of HOW, not the member's answer to WHERE IS MY MONEY",
    settle.length > 0 && !/paymentReference|approvedByUserId|paidByUserId|notes/.test(settle),
    settle.slice(0, 200),
  );
}

console.log("\nThe page");
{
  const page = code("app/policies/[id]/page.tsx");
  check("the policy page hands off by role and renders nothing itself", /BrokerPolicyView/.test(page) && /MemberPolicyView/.test(page) && !/isAdvisor/.test(page) && !/servicingEvent|listBrokerEvents|listMemberEvents/.test(page));
  check("a member is 404'd off a policy that is not theirs", /ownerUserId !== user\.id\) notFound\(\)/.test(page));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
