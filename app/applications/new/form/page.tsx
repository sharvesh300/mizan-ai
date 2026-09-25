import { FingerprintIcon } from "lucide-react";
import { UaePassButton } from "@/components/identity/uae-pass";
import { PageBody, PageHeader } from "@/components/page-header";
import { SubjectFields } from "@/components/subject-fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { defaultInception } from "@/lib/intake";
import { getCurrentUser } from "@/lib/session";
import { ageFromDob, getVerification } from "@/lib/uae-pass";
import { submitIntakeForm } from "../actions";

export default async function IntakeFormPage() {
  const user = await getCurrentUser();
  const verification = user ? await getVerification(user.id) : null;
  // Re-collect nothing: a verified date of birth answers "age" before it is asked.
  const verifiedAge = verification?.dateOfBirth ? ageFromDob(verification.dateOfBirth) : null;

  return (
    <>
      <PageHeader
        backHref="/applications/new"
        title="Your details"
        description="Everything here goes to an advisor along with the plan we suggest. Only age and budget are required — the rest helps us match you better."
      />
      <PageBody>
        {/* Outside the intake form: the UAE PASS button is a form of its own, and forms cannot nest. */}
        {verification ? null : (
          <Alert className="mx-auto mb-6 max-w-3xl">
            <FingerprintIcon />
            <AlertTitle>Skip a question with UAE PASS</AlertTitle>
            <AlertDescription>
              <p>Verify once and we take your age from your Emirates ID — and your advisor sees a verified identity.</p>
              <div className="mt-3">
                <UaePassButton returnTo="/applications/new/form" size="sm" />
              </div>
            </AlertDescription>
          </Alert>
        )}
        {/* A plain server-action form: every field name maps to one column,
            so it works before hydration. `SubjectFields` is the one bit of
            client state — showing the name field only once it's needed. */}
        <form action={submitIntakeForm} className="mx-auto max-w-3xl space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Who is this for</CardTitle>
              <CardDescription>Applying for yourself or someone in your family — either way, in one place.</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldSet>
                <FieldGroup className="sm:grid sm:grid-cols-2 sm:gap-4">
                  <SubjectFields />
                </FieldGroup>
              </FieldSet>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>About you</CardTitle>
              <CardDescription>The basics we need to price a plan.</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldSet>
                <FieldGroup className="sm:grid sm:grid-cols-2 sm:gap-4">
                  <Field>
                    <FieldLabel htmlFor="age">Age</FieldLabel>
                    <Input
                      id="age"
                      name="age"
                      type="number"
                      min={18}
                      max={100}
                      required
                      placeholder="32"
                      defaultValue={verifiedAge ?? undefined}
                    />
                    {verifiedAge != null ? (
                      <FieldDescription>From your UAE PASS verification. Change it if this is for someone else.</FieldDescription>
                    ) : null}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="maritalStatus">Marital status</FieldLabel>
                    <NativeSelect id="maritalStatus" name="maritalStatus" className="w-full" defaultValue="">
                      <NativeSelectOption value="">Prefer not to say</NativeSelectOption>
                      <NativeSelectOption value="single">Single</NativeSelectOption>
                      <NativeSelectOption value="married">Married</NativeSelectOption>
                      <NativeSelectOption value="divorced">Divorced</NativeSelectOption>
                      <NativeSelectOption value="widowed">Widowed</NativeSelectOption>
                    </NativeSelect>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="emirate">Emirate</FieldLabel>
                    <Input id="emirate" name="emirate" placeholder="Dubai" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="policyInception">Cover should start</FieldLabel>
                    <Input
                      id="policyInception"
                      name="policyInception"
                      type="date"
                      defaultValue={defaultInception()}
                      required
                    />
                  </Field>
                </FieldGroup>
                <Field orientation="horizontal">
                  <Checkbox id="smoker" name="smoker" />
                  <FieldLabel htmlFor="smoker" className="font-normal">
                    I smoke
                  </FieldLabel>
                </Field>
              </FieldSet>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Health and what you&apos;ll need</CardTitle>
              <CardDescription>
                Be as plain as you like &mdash; we read these in your own words, and an advisor sees exactly what you
                wrote.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FieldSet>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="conditions">Health conditions</FieldLabel>
                    <Textarea
                      id="conditions"
                      name="conditions"
                      rows={2}
                      placeholder="Type 2 diabetes (managed), high blood pressure"
                    />
                    <FieldDescription>
                      Separate them with commas. Leave blank if there are none. Saying a condition is managed or
                      controlled helps us match plans that cover it sooner.
                    </FieldDescription>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="needs">Anything you know you&apos;ll need cover for</FieldLabel>
                    <Textarea id="needs" name="needs" rows={2} placeholder="Maternity, ongoing diabetes care" />
                    <FieldDescription>
                      Waiting periods are the thing that catches people out, so this matters more than it looks.
                    </FieldDescription>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="needHorizonMonths">How many months away is that?</FieldLabel>
                    <Input
                      id="needHorizonMonths"
                      name="needHorizonMonths"
                      type="number"
                      min={0}
                      max={60}
                      className="sm:w-40"
                      placeholder="6"
                    />
                    <FieldDescription>
                      A plan that covers something behind a 12-month wait is no use to you in month three. Leave blank
                      if nothing is coming up.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </FieldSet>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>What matters to you</CardTitle>
              <CardDescription>This is what we weigh the three plans against.</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldSet>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="budget">Budget for premiums</FieldLabel>
                    <NativeSelect id="budget" name="budget" required className="w-full sm:w-72" defaultValue="moderate">
                      <NativeSelectOption value="low">Low — keep it as cheap as possible</NativeSelectOption>
                      <NativeSelectOption value="moderate">Moderate — sensible cost</NativeSelectOption>
                      <NativeSelectOption value="comfortable">Comfortable — cover matters more</NativeSelectOption>
                      <NativeSelectOption value="not_a_concern">Not really a concern</NativeSelectOption>
                    </NativeSelect>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="priorities">Priorities</FieldLabel>
                    <Textarea
                      id="priorities"
                      name="priorities"
                      rows={2}
                      placeholder="Lowest premium, good hospital access"
                    />
                  </Field>
                  <Field orientation="horizontal">
                    <Checkbox id="treatmentOutsideUaeExpected" name="treatmentOutsideUaeExpected" />
                    <FieldLabel htmlFor="treatmentOutsideUaeExpected" className="font-normal">
                      I expect to get some treatment outside the UAE
                    </FieldLabel>
                  </Field>
                </FieldGroup>
              </FieldSet>
            </CardContent>
          </Card>

          <div className="flex items-center justify-end gap-2">
            <Button type="submit" size="lg">
              Send to an advisor
            </Button>
          </div>
        </form>
      </PageBody>
    </>
  );
}
