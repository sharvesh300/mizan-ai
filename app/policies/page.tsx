import type { Metadata } from "next";
import { ArrowRightIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { UtilizationBar } from "@/components/utilization";
import { dateLabel, money } from "@/lib/domain";
import { listAllPolicies, listPoliciesForUser } from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Policies · Mizan AI",
  description: "Live cover and how much of it has been used.",
};

export default async function PoliciesPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const isAdvisor = user.role === "advisor";
  const rows = isAdvisor ? await listAllPolicies() : await listPoliciesForUser(user.id);

  return (
    <>
      <PageHeader
        title={isAdvisor ? "Policies" : "My cover"}
        description={
          isAdvisor
            ? "Live policies and how much of each plan has been used so far."
            : "What you're covered for, and how much of it you've used this year."
        }
      />
      <PageBody>
        {rows.length === 0 ? (
          <Empty className="rounded-xl border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShieldCheckIcon />
              </EmptyMedia>
              <EmptyTitle>No active cover</EmptyTitle>
              <EmptyDescription>
                {isAdvisor
                  ? "No policies have been issued yet."
                  : "Once an application is approved, your policy will appear here."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {rows.map(({ policy, plan, ledger, personName, ...rest }) => {
              const owner = "ownerName" in rest ? (rest.ownerName as string) : null;
              return (
                <Card key={policy.id}>
                  <CardHeader>
                    <CardTitle className="flex flex-wrap items-center gap-2">
                      {plan.name}
                      <StatusBadge tone={policy.status === "active" ? "success" : "neutral"}>
                        {policy.status}
                      </StatusBadge>
                    </CardTitle>
                    <CardDescription>
                      {policy.policyNumber} · {personName}
                      {owner ? ` · ${owner}` : ""} · since {dateLabel(policy.inceptionDate)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <UtilizationBar
                      label="Deductible"
                      used={ledger?.deductibleMet ?? 0}
                      cap={plan.deductible}
                      hint={
                        (ledger?.deductibleMet ?? 0) >= plan.deductible
                          ? "Met for the year — your plan pays from the first dirham now, minus co-pay."
                          : "You pay this much yourself before the plan starts paying."
                      }
                    />
                    <UtilizationBar
                      label="Annual limit"
                      used={ledger?.annualPaid ?? 0}
                      cap={plan.annualLimit}
                      hint={`${money(plan.annualLimit - (ledger?.annualPaid ?? 0))} of cover left this year.`}
                    />
                    <Button
            nativeButton={false}
                      variant="outline"
                      size="sm"
                      className="w-full"
                      render={
                        <Link href={`/policies/${policy.id}`}>
                          {isAdvisor ? "Open record" : "Cover and claims"}
                          <ArrowRightIcon />
                        </Link>
                      }
                    />
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </PageBody>
    </>
  );
}
