import { FingerprintIcon, ShieldCheckIcon, ShieldQuestionIcon } from "lucide-react";
import { revokeUaePassVerification, startUaePassVerification } from "@/app/verify/uae-pass/actions";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { dateLabel } from "@/lib/domain";
import { assuranceLabel, type UaePassVerification } from "@/lib/uae-pass";

/** The one way into the flow. A plain form, so it works before hydration. */
export function UaePassButton({ returnTo, size = "default" }: { returnTo: string; size?: "default" | "sm" | "lg" }) {
  return (
    <form action={startUaePassVerification}>
      <input type="hidden" name="returnTo" value={returnTo} />
      <Button type="submit" size={size} className="bg-foreground text-background hover:bg-foreground/85">
        <FingerprintIcon />
        Verify with UAE PASS
      </Button>
    </form>
  );
}

/** The applicant's own view: what was verified, or why it is worth doing. */
export function UaePassCard({ verification, returnTo }: { verification: UaePassVerification | null; returnTo: string }) {
  if (!verification) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldQuestionIcon className="size-4 text-muted-foreground" />
            Verify your identity
          </CardTitle>
          <CardDescription className="text-pretty">
            Confirm who you are with UAE PASS once. Your advisor sees a verified identity, and new applications take
            your age from your Emirates ID instead of asking again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UaePassButton returnTo={returnTo} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <ShieldCheckIcon className="size-4 text-success" />
          Identity verified
          <StatusBadge tone="success">UAE PASS</StatusBadge>
        </CardTitle>
        <CardDescription>
          {assuranceLabel[verification.assuranceLevel]} · verified {dateLabel(verification.verifiedAt)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <VerifiedFacts verification={verification} />
        <form action={revokeUaePassVerification}>
          <Button type="submit" size="sm" variant="ghost" className="-ml-2 text-muted-foreground">
            Disconnect UAE PASS
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** The claims we hold, masked where they are sensitive. Shared by the applicant card and the advisor record. */
export function VerifiedFacts({ verification }: { verification: UaePassVerification }) {
  const facts = [
    { label: "Name on Emirates ID", value: verification.fullNameEn },
    { label: "Emirates ID", value: verification.emiratesIdMasked, mono: true },
    { label: "Date of birth", value: verification.dateOfBirth ? dateLabel(verification.dateOfBirth) : "—" },
    { label: "Mobile", value: verification.mobile ?? "—" },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 text-sm">
      {facts.map((fact) => (
        <div key={fact.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{fact.label}</dt>
          <dd className={`truncate font-medium ${fact.mono ? "font-mono tabular-nums" : ""}`}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A compact status for broker screens: verified or not. Verification belongs
 * to the login, so on a dependant's record (`holder`) it is the account
 * holder who was verified, and the badge says so.
 */
export function UaePassBadge({
  verification,
  holder = false,
}: {
  verification: UaePassVerification | null | undefined;
  holder?: boolean;
}) {
  return verification ? (
    <StatusBadge tone="success">
      <ShieldCheckIcon />
      {holder ? "Holder UAE PASS verified" : "UAE PASS verified"}
    </StatusBadge>
  ) : (
    <StatusBadge>
      <ShieldQuestionIcon />
      {holder ? "Holder not verified" : "Identity not verified"}
    </StatusBadge>
  );
}
