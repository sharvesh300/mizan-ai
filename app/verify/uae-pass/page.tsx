import type { Metadata } from "next";
import { InfoIcon } from "lucide-react";
import Link from "next/link";
import { UaePassAuthorize } from "@/components/identity/uae-pass-authorize";
import { PageBody, PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/session";
import { readPendingState, UAE_PASS_SCOPES } from "@/lib/uae-pass";

export const metadata: Metadata = { title: "Verify with UAE PASS · Mizan AI" };

/** `aisha.rahman@example.ae` → `ai••••••••@example.ae`: enough to recognise, not enough to lift. */
const maskEmail = (email: string) => {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}${"•".repeat(Math.max(local.length - 2, 3))}@${domain}`;
};

/**
 * Stands in for https://id.uaepass.ae/…/authorize. It only renders for the
 * request the user just started — the state in the URL has to match the one
 * in their cookie — so a bookmarked or shared link lands on the error state.
 */
export default async function UaePassAuthorizePage(props: PageProps<"/verify/uae-pass">) {
  const search = await props.searchParams;
  const [user, pending] = await Promise.all([getCurrentUser(), readPendingState()]);
  if (!user) return null;

  const valid = !search.error && pending && pending.state === search.state && pending.userId === user.id;

  return (
    <>
      <PageHeader
        title="Verify your identity"
        description="You are being handed to UAE PASS, the UAE's national digital identity. We never see your UAE PASS password — only the details you agree to share."
      />
      <PageBody className="mx-auto max-w-2xl space-y-4">
        {valid ? (
          <UaePassAuthorize state={pending.state} identifier={maskEmail(user.email)} scopes={UAE_PASS_SCOPES} />
        ) : (
          <Alert>
            <InfoIcon />
            <AlertTitle>This verification request has expired</AlertTitle>
            <AlertDescription>
              <p>Requests last ten minutes and only work in the session that started them. Start again from your overview.</p>
              <Button
                nativeButton={false}
                size="sm"
                variant="outline"
                className="mt-3"
                render={<Link href="/">Back to overview</Link>}
              />
            </AlertDescription>
          </Alert>
        )}
        <p className="text-xs text-muted-foreground text-pretty">
          Demo build: this screen simulates UAE PASS. No request leaves Mizan AI, and the Emirates ID it returns is
          generated for the demo, not looked up.
        </p>
      </PageBody>
    </>
  );
}
