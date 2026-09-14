import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  MessageSquareIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApplicationJourney } from "@/components/application-journey";
import { AssessmentReview } from "@/components/assessment-review";
import { CorrectionRequest } from "@/components/correction-request";
import { RecommendationQualityCheck, RecommendationReview } from "@/components/recommendation-review";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge, StatusDot } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  applicationStatusLabel,
  applicationStatusTone,
  cohortLabel,
  dateLabel,
  flagSeverityLabel,
  flagSeverityTone,
  isWithAdvisor,
  money,
  monthsLabel,
  percent,
  recoStatusLabel,
  recoStatusTone,
  reviewActionLabel,
  reviewActionTone,
  reviewStatusLabel,
  reviewStatusTone,
} from "@/lib/domain";
import { askableFields, fieldKeysForFlagFields } from "@/lib/ai/fields";
import { COHORTS } from "@/lib/assessment";
import {
  countOpenQuestions,
  getApplication,
  getAssessment,
  getClassificationDecision,
  getConversationForApplication,
  getMemberNotices,
  getDeclared,
  getPolicyForApplication,
  getQuotes,
  getRecommendation,
  getRecommendationDecision,
  getReviewTasksForApplication,
  isSelectionReview,
} from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";

export default async function ApplicationPage(props: PageProps<"/applications/[id]">) {
  const { id } = await props.params;
  const search = await props.searchParams;
  const user = await getCurrentUser();
  if (!user) return null;

  const record = await getApplication(id);
  if (!record) notFound();

  const isAdvisor = user.role === "advisor";
  // An applicant may only open their own record.
  if (!isAdvisor && record.person.ownerUserId !== user.id) notFound();

  const [declared, quotes, recommendation, policy] = await Promise.all([
    getDeclared(id),
    getQuotes(id),
    getRecommendation(id),
    getPolicyForApplication(id),
  ]);

  const { application: app, person } = record;

  return (
    <>
      <PageHeader
        backHref="/applications"
        backLabel={isAdvisor ? "Applications" : "My applications"}
        title={app.reference}
        description={
          isAdvisor
            ? `${person.fullName} · age ${app.age} · ${app.budget.replace(/_/g, " ")} budget · via ${app.intakeSource.replace(/_/g, " ")}`
            : `Started ${dateLabel(app.createdAt)} · cover from ${dateLabel(app.policyInception)}`
        }
      >
        <StatusBadge tone={applicationStatusTone[app.status]}>{applicationStatusLabel[app.status]}</StatusBadge>
        {policy ? (
          <Button
            nativeButton={false}
            size="sm"
            variant="outline"
            render={
              <Link href={`/policies/${policy.policy.id}`}>
                <ShieldCheckIcon />
                View policy
              </Link>
            }
          />
        ) : null}
      </PageHeader>

      <PageBody className="space-y-6">
        {search.submitted && !isAdvisor ? (
          <Alert>
            <CheckCircle2Icon className="text-success" />
            <AlertTitle>Your application is in.</AlertTitle>
            <AlertDescription>
              An advisor reviews your details and the plan we suggest before anything is confirmed. Nothing else is
              needed from you right now.
            </AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <ApplicationJourney
              status={app.status}
              audience={isAdvisor ? "broker" : "customer"}
              withAdvisor={isWithAdvisor(app.status)}
            />
          </CardContent>
        </Card>

        {isAdvisor ? (
          <AdvisorRecord
            applicationId={id}
            declared={declared}
            quotes={quotes}
            recommendation={recommendation}
            app={app}
            person={person}
            owner={record.owner}
          />
        ) : (
          <ApplicantRecord
            applicationId={id}
            declared={declared}
            quotes={quotes}
            recommendation={recommendation}
            app={app}
          />
        )}
      </PageBody>
    </>
  );
}

/** The member-register text an advisor wrote on a reject / request-info. */
const memberMessageOf = (payload: Record<string, unknown> | null): string | null => {
  const value = payload?.memberMessage;
  return typeof value === "string" && value.trim() ? value : null;
};

type Declared = Awaited<ReturnType<typeof getDeclared>>;
type Quotes = Awaited<ReturnType<typeof getQuotes>>;
type Reco = Awaited<ReturnType<typeof getRecommendation>>;
type App = NonNullable<Awaited<ReturnType<typeof getApplication>>>["application"];
type Person = NonNullable<Awaited<ReturnType<typeof getApplication>>>["person"];

// ---------------------------------------------------------------------------
// Applicant register — their coverage, their words, no internal vocabulary
// ---------------------------------------------------------------------------

async function ApplicantRecord({
  applicationId,
  declared,
  quotes,
  recommendation,
  app,
}: {
  applicationId: string;
  declared: Declared;
  quotes: Quotes;
  recommendation: Reco;
  app: App;
}) {
  // Everything an advisor has said TO them, and where the conversation is.
  // Never the note the advisor wrote for the file — `getMemberNotices` does
  // not select that column at all.
  const [notices, convo] = await Promise.all([
    getMemberNotices(applicationId),
    getConversationForApplication(applicationId),
  ]);
  const waitingOnThem = convo && app.status === "in_intake" ? await countOpenQuestions(convo.id) : 0;
  const latestAsk = notices.find((notice) => notice.action === "request_info");
  const decline = notices.find((notice) => notice.action === "reject");

  return (
    <>
      {/* An advisor needs something before this can go further. Their words,
          and a way straight back to just those questions — not intake again. */}
      {waitingOnThem > 0 ? (
        <Alert>
          <MessageSquareIcon className="text-warning" />
          <AlertTitle>We need one more thing</AlertTitle>
          <AlertDescription className="space-y-3">
            <p className="text-pretty">
              {latestAsk?.message ??
                "An advisor has asked for a little more before we can finish this off."}
            </p>
            <Button
            nativeButton={false}
              size="sm"
              render={
                <Link href={`/applications/new/chat/${convo!.id}`}>
                  Answer {waitingOnThem === 1 ? "the question" : `the ${waitingOnThem} questions`}
                </Link>
              }
            />
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Declined. The advisor's own words to them, and what they can do —
          never the internal reason, and never a classification. */}
      {app.status === "declined" ? (
        <Alert>
          <XCircleIcon className="text-destructive" />
          <AlertTitle>We could not take this application further</AlertTitle>
          <AlertDescription className="space-y-3">
            <p className="text-pretty">
              {decline?.message ??
                "An advisor has closed this application. Get in touch and we will talk it through."}
            </p>
            <Button
            nativeButton={false}
              size="sm"
              variant="outline"
              render={<Link href="/applications/new">Start a new application</Link>}
            />
          </AlertDescription>
        </Alert>
      ) : null}

      {recommendation ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              We suggest {recommendation.plan.name}
              <Badge variant="secondary">{money(recommendation.plan.annualPremium)} a year</Badge>
            </CardTitle>
            <CardDescription>Why this one fits you</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-relaxed text-pretty">{recommendation.recommendation.memberReasoning}</p>
            {recommendation.rejections.length > 0 ? (
              <>
                <Separator />
                <div className="space-y-2">
                  <p className="text-sm font-medium">Why not the others</p>
                  {recommendation.rejections.map((rejection) => (
                    <div key={rejection.planId} className="text-sm">
                      <span className="font-medium">{rejection.plan.name}</span>
                      <span className="text-muted-foreground"> — {rejection.reason}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {quotes.length > 0 ? <PlanComparison quotes={quotes} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>What you told us</CardTitle>
          <CardDescription>
            We reuse this everywhere — you should never be asked for it twice.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <DeclaredDetails declared={declared} app={app} />
          <Separator />
          <CorrectionRequest applicationId={applicationId} />
        </CardContent>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Advisor register — the full record, including everything routing-related
// ---------------------------------------------------------------------------

async function AdvisorRecord({
  applicationId,
  declared,
  quotes,
  recommendation,
  app,
  person,
  owner,
}: {
  applicationId: string;
  declared: Declared;
  quotes: Quotes;
  recommendation: Reco;
  app: App;
  person: Person;
  owner: { fullName: string; email: string };
}) {
  const [assessment, reviews, decision, recoDecision] = await Promise.all([
    getAssessment(applicationId),
    getReviewTasksForApplication(applicationId, recommendation?.recommendation.id),
    getClassificationDecision(applicationId),
    getRecommendationDecision(applicationId),
  ]);

  // The one thing on this page that is waiting on a person. A resolved task is
  // history and belongs in the Review tab, not in front of them as a decision.
  const openTask = reviews.find(
    ({ task }) => task.subjectType === "application" && task.status !== "resolved",
  );
  // Review 2 — the recommendation, not the record. Distinct task, distinct
  // question ("is this the right plan"), only ever open once Review 1 (above)
  // is clear.
  const openRecoTask = reviews.find(
    ({ task }) => task.subjectType === "recommendation" && task.status !== "resolved",
  );
  // Which of the two questions this open task is actually asking — see the
  // comment above `openRecommendationTask`, app/applications/[id]/actions.ts.
  const recoReviewIsSelection = recommendation ? await isSelectionReview(recommendation.recommendation.id) : false;

  // Tick the boxes the flags point at, so "ask for more" opens pre-aimed at
  // whatever actually fired rather than at the whole questionnaire.
  const suggested = new Set(
    fieldKeysForFlagFields((assessment?.flags ?? []).flatMap((flag) => flag.fields)),
  );
  const askable = askableFields().map((field) => ({ ...field, suggested: suggested.has(field.key) }));

  return (
    <Tabs defaultValue="record">
      <TabsList>
        <TabsTrigger value="record">Record</TabsTrigger>
        <TabsTrigger value="quotes">Quotes &amp; recommendation</TabsTrigger>
        <TabsTrigger value="review">Review ({reviews.length})</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
      </TabsList>

      <TabsContent value="record" className="space-y-4 pt-4">
        {openTask && assessment ? (
          <AssessmentReview
            taskId={openTask.task.id}
            applicationId={applicationId}
            cohort={assessment.cohort}
            confidence={assessment.confidence}
            cohorts={COHORTS}
            askable={askable}
            uncertaintyReason={decision?.uncertaintyReason ?? null}
          />
        ) : null}

        {/* BROKER ONLY. Cohort and flags are routing vocabulary — this block
            has no equivalent in the applicant view by design. */}
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Classification
              {assessment ? (
                <StatusBadge tone={assessment.confidence === "high" ? "success" : assessment.confidence === "medium" ? "info" : "warning"}>
                  {assessment.confidence} confidence
                </StatusBadge>
              ) : null}
            </CardTitle>
            <CardDescription>Internal. Used for routing and matching, never shown to the applicant.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {assessment ? (
              <>
                <div>
                  <p className="text-xs text-muted-foreground">Cohort</p>
                  <p className="font-medium">{cohortLabel(assessment.cohort)}</p>
                </div>
                {assessment.flags.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">Flags that fired</p>
                    {assessment.flags.map((flag) => (
                      <div key={flag.id} className="rounded-lg border p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="font-mono text-xs">{flag.ruleCode}</code>
                          <StatusBadge tone={flagSeverityTone[flag.severity]}>
                            {flagSeverityLabel[flag.severity]}
                          </StatusBadge>
                        </div>
                        <p className="mt-1.5 text-sm text-muted-foreground text-pretty">{flag.reason}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No flags fired.</p>
                )}
              </>
            ) : (
              <Alert>
                <AlertTriangleIcon className="text-warning" />
                <AlertTitle>Not yet assessed</AlertTitle>
                <AlertDescription>
                  This application has been submitted but no cohort has been assigned. It is sitting in the queue
                  waiting for assessment.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Applicant record</CardTitle>
            <CardDescription>
              {person.fullName} · account held by {owner.fullName} ({owner.email})
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DeclaredDetails declared={declared} app={app} showRaw />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="quotes" className="space-y-4 pt-4">
        {quotes.length > 0 ? <PlanComparison quotes={quotes} showScores /> : (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No quotes generated yet.
            </CardContent>
          </Card>
        )}

        {openRecoTask && recommendation ? (
          recoReviewIsSelection ? (
            <RecommendationReview
              taskId={openRecoTask.task.id}
              currentPlanId={recommendation.plan.id}
              plans={quotes.map((q) => ({ id: q.plan.id, name: q.plan.name }))}
              uncertaintyReason={recoDecision?.uncertaintyReason ?? null}
            />
          ) : (
            <RecommendationQualityCheck
              taskId={openRecoTask.task.id}
              uncertaintyReason={recoDecision?.uncertaintyReason ?? null}
            />
          )
        ) : null}

        {recommendation ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                Recommended: {recommendation.plan.name}
                <StatusBadge tone={recoStatusTone[recommendation.recommendation.status]}>
                  {recoStatusLabel[recommendation.recommendation.status]}
                </StatusBadge>
                {recommendation.recommendation.confidence != null ? (
                  <Badge variant="outline">
                    confidence {Math.round(recommendation.recommendation.confidence * 100)}%
                  </Badge>
                ) : null}
              </CardTitle>
              <CardDescription>
                v{recommendation.recommendation.version} · by {recommendation.recommendation.createdBy}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {recommendation.recommendation.uncertaintyReason ? (
                <Alert>
                  <AlertTriangleIcon className="text-warning" />
                  <AlertTitle>Why this one needs you</AlertTitle>
                  <AlertDescription>{recommendation.recommendation.uncertaintyReason}</AlertDescription>
                </Alert>
              ) : null}

              <div>
                <p className="mb-1 text-xs text-muted-foreground">Broker reasoning</p>
                <p className="text-sm leading-relaxed text-pretty">
                  {recommendation.recommendation.brokerReasoning}
                </p>
              </div>

              <Separator />

              <div>
                <p className="mb-1 text-xs text-muted-foreground">
                  What the applicant reads — same facts, their register
                </p>
                <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
                  {recommendation.recommendation.memberReasoning}
                </p>
              </div>

              {recommendation.rejections.length > 0 ? (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">Why the alternatives lost</p>
                    {recommendation.rejections.map((rejection) => (
                      <div key={rejection.planId} className="flex gap-2 rounded-lg border p-3 text-sm">
                        <XCircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div>
                          <p className="font-medium">{rejection.plan.name}</p>
                          <p className="text-muted-foreground text-pretty">{rejection.reason}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </TabsContent>

      <TabsContent value="review" className="space-y-4 pt-4">
        {reviews.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Nothing routed for review on this application.
            </CardContent>
          </Card>
        ) : (
          reviews.map(({ task, decisions }) => (
            <Card key={task.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {task.reason}
                  <StatusBadge tone={reviewStatusTone[task.status]}>{reviewStatusLabel[task.status]}</StatusBadge>
                </CardTitle>
                <CardDescription>
                  {task.subjectType.replace(/_/g, " ")} · priority {task.priorityScore} · raised{" "}
                  {dateLabel(task.createdAt)}
                </CardDescription>
              </CardHeader>
              {decisions.length > 0 ? (
                <CardContent className="space-y-3">
                  {decisions.map(({ decision, actor }) => (
                    <div key={decision.id} className="flex gap-2.5 text-sm">
                      <StatusDot tone={reviewActionTone[decision.action]} className="mt-1.5" />
                      <div className="min-w-0 space-y-1">
                        <p>
                          <span className="font-medium">{reviewActionLabel[decision.action]}</span> by{" "}
                          {actor.fullName} ·{" "}
                          <span className="text-muted-foreground">{dateLabel(decision.decidedAt)}</span>
                        </p>
                        {decision.notes ? (
                          <p className="text-muted-foreground text-pretty">{decision.notes}</p>
                        ) : null}
                        {/* Same decision, the applicant's register. Kept next
                            to the note so the two can be read against each
                            other — one explanation shown twice reads wrong in
                            one of the views, and this is where you would see it. */}
                        {memberMessageOf(decision.payload) ? (
                          <p className="rounded-lg border border-dashed px-3 py-2 text-pretty">
                            <span className="text-xs text-muted-foreground">What the applicant was told</span>
                            <br />
                            {memberMessageOf(decision.payload)}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </CardContent>
              ) : null}
            </Card>
          ))
        )}
      </TabsContent>

      <TabsContent value="history" className="pt-4">
        <Card>
          <CardHeader>
            <CardTitle>Status history</CardTitle>
            <CardDescription>Every move, who made it, and why.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-4">
              {declared.history.map((entry) => (
                <li key={entry.id} className="flex gap-3">
                  <StatusDot tone={applicationStatusTone[entry.toStatus]} className="mt-1.5" />
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">
                      {entry.fromStatus ? `${applicationStatusLabel[entry.fromStatus]} → ` : ""}
                      {applicationStatusLabel[entry.toStatus]}
                    </p>
                    <p className="text-muted-foreground">
                      {entry.changedBy} · {dateLabel(entry.changedAt)}
                      {entry.reason ? ` · ${entry.reason}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// Shared blocks
// ---------------------------------------------------------------------------

function DeclaredDetails({
  declared,
  app,
  showRaw = false,
}: {
  declared: Declared;
  app: App;
  showRaw?: boolean;
}) {
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ["Age", String(app.age)],
          ["Marital status", app.maritalStatus ?? "—"],
          ["Smoker", app.smoker == null ? "—" : app.smoker ? "Yes" : "No"],
          ["Emirate", app.emirate ?? "—"],
          ["Budget", app.budget.replace(/_/g, " ")],
          ["Cover from", dateLabel(app.policyInception)],
          ["Treatment abroad expected", app.treatmentOutsideUaeExpected ? "Yes" : "No"],
          ["Captured via", app.intakeSource.replace(/_/g, " ")],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-medium capitalize">{value}</dd>
          </div>
        ))}
      </dl>

      <Separator />

      <DeclaredList
        title="Health conditions"
        empty="None declared."
        items={declared.conditions.map((c) => ({
          id: c.id,
          primary: c.rawText,
          secondary: showRaw ? `${c.stability}${c.conditionCode ? ` · ${c.conditionCode}` : " · uncoded"}` : c.stability,
        }))}
      />

      <DeclaredList
        title="What they'll need cover for"
        empty="Nothing stated."
        items={declared.needs.map((n) => ({
          id: n.id,
          primary: n.rawText,
          secondary: `${n.benefitClass ? n.benefitClass.replace(/_/g, " ") : "unclassified"} · ${monthsLabel(n.horizonMonths)} away`,
          warn: n.benefitClass == null || n.horizonMonths == null,
        }))}
      />

      <DeclaredList
        title="Priorities"
        empty="None stated."
        items={declared.priorities.map((p) => ({
          id: p.id,
          primary: p.rawText,
          secondary: showRaw ? p.tag.replace(/_/g, " ") : undefined,
        }))}
      />

      {declared.providers.length > 0 ? (
        <DeclaredList
          title="Providers they expect to use"
          empty=""
          items={declared.providers.map((p) => ({
            id: p.id,
            primary: p.providerName,
            secondary: p.tier?.replace(/_/g, " ") ?? "tier unknown",
          }))}
        />
      ) : null}
    </div>
  );
}

function DeclaredList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: { id: string; primary: string; secondary?: string; warn?: boolean }[];
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{title}</p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
              {/* Their own words, verbatim — never a normalised paraphrase. */}
              <span>{item.primary}</span>
              {item.secondary ? (
                <Badge variant={item.warn ? "destructive" : "secondary"} className="capitalize">
                  {item.secondary}
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlanComparison({ quotes, showScores = false }: { quotes: Quotes; showScores?: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>All three plans, priced</CardTitle>
        <CardDescription>
          Compared on what actually differs — what you pay, what you pay at the point of care, and how long you wait.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 lg:grid-cols-3">
          {quotes.map((quote) => (
            <div
              key={quote.id}
              className={
                quote.rank === 1
                  ? "rounded-xl border-2 border-brand bg-brand-subtle/30 p-4"
                  : "rounded-xl border p-4"
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{quote.plan.name}</p>
                {quote.rank === 1 ? <StatusBadge tone="brand">Best match</StatusBadge> : null}
                {!quote.eligible ? <StatusBadge tone="danger">Not suitable</StatusBadge> : null}
              </div>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{money(quote.annualPremium)}</p>
              <p className="text-xs text-muted-foreground">per year</p>

              <dl className="mt-3 space-y-1.5 text-sm">
                <Row label="Deductible" value={money(quote.plan.deductible)} />
                <Row label="Co-pay" value={percent(quote.plan.outpatientCopayPct)} />
                <Row label="Annual limit" value={money(quote.plan.annualLimit)} />
                <Row
                  label="Maternity"
                  value={
                    quote.plan.maternityCovered
                      ? `${money(quote.plan.maternityLimit)} after ${monthsLabel(quote.plan.maternityWaitingPeriodMonths)}`
                      : "Not covered"
                  }
                />
                <Row
                  label="Existing conditions"
                  value={
                    quote.plan.chronicCovered
                      ? monthsLabel(quote.plan.chronicWaitingPeriodMonths)
                      : "Not covered"
                  }
                />
                <Row label="Network" value={quote.plan.network} />
                {showScores && quote.score != null ? (
                  <Row label="Fit score" value={quote.score.toFixed(2)} />
                ) : null}
              </dl>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium capitalize tabular-nums">{value}</dd>
    </div>
  );
}
