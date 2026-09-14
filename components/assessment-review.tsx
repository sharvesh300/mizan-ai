"use client";

// The advisor's decision surface. Broker-only — it is rendered inside
// AdvisorRecord and has no applicant equivalent.
//
// Four verbs, four forms, one tab each, because the shape of what you have to
// write is different for each: approving needs nothing, editing needs a reason,
// and the two that reach the applicant need BOTH registers — a note for the
// file and a message in the applicant's own language. They are separate boxes
// rather than one, so neither can be quietly reused as the other.
//
// Approve is the default tab and the only single-click action. Rejecting
// someone's application is deliberately three fields away.

import { useState } from "react";
import { CheckIcon, MessageCircleQuestionIcon, PencilIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  approveAssessment,
  editAssessment,
  reclassify,
  rejectApplication,
  requestInfo,
} from "@/app/applications/[id]/actions";
import type { ConfidenceLevel } from "@/db/schema";

export type AskableField = { key: string; label: string; suggested: boolean };

export function AssessmentReview({
  taskId,
  applicationId,
  cohort,
  confidence,
  cohorts,
  askable,
  uncertaintyReason,
}: {
  taskId: string;
  applicationId: string;
  cohort: string;
  confidence: ConfidenceLevel;
  cohorts: readonly string[];
  askable: AskableField[];
  uncertaintyReason: string | null;
}) {
  const [pending, setPending] = useState(false);
  const busy = () => setPending(true);

  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle>Your decision</CardTitle>
        <CardDescription>
          {uncertaintyReason
            ? uncertaintyReason
            : "This application is waiting on you. Nothing moves until you decide."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="approve">
          <TabsList>
            <TabsTrigger value="approve">Approve</TabsTrigger>
            <TabsTrigger value="edit">Edit</TabsTrigger>
            <TabsTrigger value="ask">Ask for more</TabsTrigger>
            <TabsTrigger value="reject">Reject</TabsTrigger>
          </TabsList>

          {/* Approve — the classification stands. -------------------------- */}
          <TabsContent value="approve" className="pt-4">
            <form action={approveAssessment.bind(null, taskId)} onSubmit={busy} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="approve-notes">Note for the file (optional)</Label>
                <Textarea
                  id="approve-notes"
                  name="notes"
                  rows={2}
                  placeholder="Spoke to the applicant; they understand the six-month wait and want to proceed."
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Keeps the cohort and flags as they are, and moves the application on to quoting.
              </p>
              <Button type="submit" size="sm" disabled={pending}>
                <CheckIcon />
                Approve assessment
              </Button>
            </form>
          </TabsContent>

          {/* Edit — the cohort was wrong. --------------------------------- */}
          <TabsContent value="edit" className="pt-4">
            <form action={editAssessment.bind(null, taskId)} onSubmit={busy} className="space-y-3">
              <div className="flex flex-wrap gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-cohort">Cohort</Label>
                  <NativeSelect id="edit-cohort" name="cohort" defaultValue={cohort} className="w-64">
                    {cohorts.map((option) => (
                      <NativeSelectOption key={option} value={option}>
                        {option.replace(/_/g, " ")}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-confidence">Confidence</Label>
                  <NativeSelect id="edit-confidence" name="confidence" defaultValue={confidence} className="w-40">
                    {(["high", "medium", "low"] as const).map((level) => (
                      <NativeSelectOption key={level} value={level}>
                        {level}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-notes">Why you changed it</Label>
                <Textarea id="edit-notes" name="notes" rows={2} required placeholder="Conditions are stable and well documented — this is a managed-chronic record, not a complex one." />
              </div>
              <p className="text-xs text-muted-foreground">
                Recorded as a new assessment. What the system originally said stays on the record next to it.
              </p>
              <Button type="submit" size="sm" variant="outline" disabled={pending}>
                <PencilIcon />
                Save correction
              </Button>
            </form>
          </TabsContent>

          {/* Request info — ask for exactly what is missing. --------------- */}
          <TabsContent value="ask" className="pt-4">
            <form action={requestInfo.bind(null, taskId)} onSubmit={busy} className="space-y-3">
              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium">What do you need from them?</legend>
                <p className="text-xs text-muted-foreground">
                  Only what you tick is asked. Everything else they have already told us stays as it is.
                </p>
                <div className="grid gap-1.5 pt-1 sm:grid-cols-2">
                  {askable.map((field) => (
                    <label key={field.key} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="fieldKeys"
                        value={field.key}
                        defaultChecked={field.suggested}
                        className="size-4 rounded border-input accent-primary"
                      />
                      <span>{field.label}</span>
                      {field.suggested ? (
                        <span className="text-xs text-muted-foreground">· flagged</span>
                      ) : null}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="space-y-1.5">
                <Label htmlFor="ask-member">What the applicant reads</Label>
                <Textarea
                  id="ask-member"
                  name="memberMessage"
                  rows={2}
                  required
                  placeholder="One quick thing before we can finish — when are you hoping the treatment would happen?"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ask-notes">Note for the file (optional)</Label>
                <Textarea id="ask-notes" name="notes" rows={2} />
              </div>
              <p className="text-xs text-muted-foreground">
                The task stays in your queue, marked in progress, until they answer.
              </p>
              <Button type="submit" size="sm" variant="outline" disabled={pending}>
                <MessageCircleQuestionIcon />
                Send the question
              </Button>
            </form>
          </TabsContent>

          {/* Reject — no cover offered. ----------------------------------- */}
          <TabsContent value="reject" className="pt-4">
            <form action={rejectApplication.bind(null, taskId)} onSubmit={busy} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="reject-notes">Why, for the file</Label>
                <Textarea id="reject-notes" name="notes" rows={2} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reject-member">What the applicant reads</Label>
                <Textarea
                  id="reject-member"
                  name="memberMessage"
                  rows={3}
                  required
                  placeholder="We are not able to offer cover on this application. Here is why, and what you can do next…"
                />
                <p className="text-xs text-muted-foreground">
                  Write it to them, not about them. They see this and nothing else — no cohort, no flags.
                </p>
              </div>
              <Button type="submit" size="sm" variant="destructive" disabled={pending}>
                <XIcon />
                Reject application
              </Button>
            </form>
          </TabsContent>
        </Tabs>

        <form action={reclassify.bind(null, applicationId)} onSubmit={busy} className="mt-4 border-t pt-3">
          <Button type="submit" size="xs" variant="ghost" disabled={pending}>
            <RefreshCwIcon />
            Re-run the rules
          </Button>
          <span className="ml-2 text-xs text-muted-foreground">
            After the declared record changes, or the rules do.
          </span>
        </form>
      </CardContent>
    </Card>
  );
}
