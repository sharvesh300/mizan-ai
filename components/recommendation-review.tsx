"use client";

// The advisor's decision on a recommendation — Review 2. Broker-only, and
// structurally the twin of AssessmentReview: four verbs, four forms, one tab
// each. The difference from Review 1 is what each verb decides — not "is this
// record right" but "is this the right plan for this person" — and that
// approving, editing or overriding all end the same way: a policy issues.
// Only reject does not.

import { useState } from "react";
import { CheckIcon, PencilIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  approveRecommendation,
  editRecommendation,
  markRecommendationChecked,
  overrideRecommendation,
  rejectRecommendation,
} from "@/app/applications/[id]/actions";

export type PlanOption = { id: string; name: string };

/**
 * Review 1.5 — the applicant has not chosen a plan yet, so nothing here can
 * issue a policy. `markRecommendationChecked` (app/applications/[id]/actions.ts)
 * is the only verb; it just closes the loop for the file. The four-verb form
 * below (`RecommendationReview`) only ever renders once `isSelectionReview`
 * is true — this card is what fills that slot until it is.
 */
export function RecommendationQualityCheck({ taskId, uncertaintyReason }: { taskId: string; uncertaintyReason: string | null }) {
  const [pending, setPending] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Flagged for a look</CardTitle>
        <CardDescription>
          {uncertaintyReason ?? "The system was not fully confident in this shortlist."} The applicant already has the
          cards — this is a quality check, not a gate, and nothing you do here blocks or changes what they see.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={markRecommendationChecked.bind(null, taskId)} onSubmit={() => setPending(true)} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="check-notes">Note for the file (optional)</Label>
            <Textarea id="check-notes" name="notes" rows={2} placeholder="Looked it over — the placement holds up." />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            <CheckIcon />
            Mark checked
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function RecommendationReview({
  taskId,
  currentPlanId,
  plans,
  uncertaintyReason,
}: {
  taskId: string;
  currentPlanId: string;
  plans: PlanOption[];
  uncertaintyReason: string | null;
}) {
  const [pending, setPending] = useState(false);
  const busy = () => setPending(true);

  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle>Your decision</CardTitle>
        <CardDescription>
          {uncertaintyReason ? uncertaintyReason : "This recommendation is waiting on you. Nothing moves until you decide."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="approve">
          <TabsList>
            <TabsTrigger value="approve">Approve</TabsTrigger>
            <TabsTrigger value="edit">Edit</TabsTrigger>
            <TabsTrigger value="override">Override</TabsTrigger>
            <TabsTrigger value="reject">Reject</TabsTrigger>
          </TabsList>

          {/* Approve — the recommendation stands, a policy issues. --------- */}
          <TabsContent value="approve" className="pt-4">
            <form action={approveRecommendation.bind(null, taskId)} onSubmit={busy} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="approve-notes">Note for the file (optional)</Label>
                <Textarea id="approve-notes" name="notes" rows={2} placeholder="Agree with the placement — straightforward." />
              </div>
              <p className="text-xs text-muted-foreground">Issues the policy on the recommended plan.</p>
              <Button type="submit" size="sm" disabled={pending}>
                <CheckIcon />
                Approve and issue
              </Button>
            </form>
          </TabsContent>

          {/* Edit — a correction in the same direction as the system's. ---- */}
          <TabsContent value="edit" className="pt-4">
            <form action={editRecommendation.bind(null, taskId)} onSubmit={busy} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-plan">Plan</Label>
                <NativeSelect id="edit-plan" name="planId" defaultValue={currentPlanId} className="w-56">
                  {plans.map((p) => (
                    <NativeSelectOption key={p.id} value={p.id}>
                      {p.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-notes">Why you changed it</Label>
                <Textarea id="edit-notes" name="notes" rows={2} required placeholder="Confidence was capped by a wait that the applicant already understands and accepts." />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-member">What the applicant reads (optional unless you changed the plan)</Label>
                <Textarea id="edit-member" name="memberMessage" rows={2} />
              </div>
              <p className="text-xs text-muted-foreground">
                Recorded as a new recommendation. What the system originally proposed stays on the record next to it.
              </p>
              <Button type="submit" size="sm" variant="outline" disabled={pending}>
                <PencilIcon />
                Save correction and issue
              </Button>
            </form>
          </TabsContent>

          {/* Override — a different call from the system's entirely. ------ */}
          <TabsContent value="override" className="pt-4">
            <form action={overrideRecommendation.bind(null, taskId)} onSubmit={busy} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="override-plan">Plan</Label>
                <NativeSelect id="override-plan" name="planId" defaultValue={plans.find((p) => p.id !== currentPlanId)?.id ?? currentPlanId} className="w-56">
                  {plans.map((p) => (
                    <NativeSelectOption key={p.id} value={p.id}>
                      {p.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="override-notes">Why you&rsquo;re overriding it</Label>
                <Textarea id="override-notes" name="notes" rows={2} required placeholder="Something the panel could not see — spoke to the applicant directly." />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="override-member">What the applicant reads</Label>
                <Textarea id="override-member" name="memberMessage" rows={2} placeholder="Required if you're picking a different plan than the one you're overriding." />
              </div>
              <Button type="submit" size="sm" variant="outline" disabled={pending}>
                <ShieldAlertIcon />
                Override and issue
              </Button>
            </form>
          </TabsContent>

          {/* Reject — no cover offered. ------------------------------------ */}
          <TabsContent value="reject" className="pt-4">
            <form action={rejectRecommendation.bind(null, taskId)} onSubmit={busy} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="reject-notes">Why, for the file</Label>
                <Textarea id="reject-notes" name="notes" rows={2} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reject-member">What the applicant reads</Label>
                <Textarea id="reject-member" name="memberMessage" rows={3} required />
                <p className="text-xs text-muted-foreground">Write it to them, not about them.</p>
              </div>
              <Button type="submit" size="sm" variant="destructive" disabled={pending}>
                <XIcon />
                Reject
              </Button>
            </form>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
