"use client";

import { useState } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { RelationshipType } from "@/db/schema";

const RELATIONSHIP_OPTIONS: { value: RelationshipType; label: string }[] = [
  { value: "self", label: "Myself" },
  { value: "spouse", label: "My spouse" },
  { value: "child", label: "My child" },
  { value: "parent", label: "My parent" },
  { value: "other", label: "Someone else" },
];

/**
 * "Who is this for", inline in the intake form.
 *
 * The name field only makes sense once the applicant has said this is for
 * someone else, so it is client-side state — the rest of the form is a plain
 * server action, this is the one place picking an option changes what else
 * is on the page.
 */
export function SubjectFields() {
  const [relationship, setRelationship] = useState<RelationshipType>("self");

  return (
    <>
      <Field>
        <FieldLabel htmlFor="subjectRelationship">Who is this application for?</FieldLabel>
        <NativeSelect
          id="subjectRelationship"
          name="subjectRelationship"
          className="w-full"
          value={relationship}
          onChange={(event) => setRelationship(event.target.value as RelationshipType)}
        >
          {RELATIONSHIP_OPTIONS.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {relationship === "self" ? null : (
        <Field>
          <FieldLabel htmlFor="subjectFullName">Their full name</FieldLabel>
          <Input id="subjectFullName" name="subjectFullName" required placeholder="e.g. Fatima Al Suwaidi" />
        </Field>
      )}
    </>
  );
}
