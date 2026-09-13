"use client";

import { useTransition } from "react";
import { submitQuestionnaire } from "@/app/applications/new/actions";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { Spinner } from "@/components/ui/spinner";
import type { PendingQuestion } from "@/lib/ai/intake-agent";

/**
 * The agent's questionnaire, rendered inside the thread.
 *
 * One form, one submission: the applicant steps through the outstanding fields
 * without a server round-trip per answer, and everything they picked lands in
 * a single turn. What each control is — radio, multi-select, or a typed answer
 * — was chosen by the agent per field and travels on the message payload.
 *
 * The agent's own words introducing the form are the message bubble above it,
 * so nothing is repeated here.
 */
export function ChatQuestionnaire({
  conversationId,
  questions,
}: {
  conversationId: string;
  questions: PendingQuestion[];
}) {
  const [pending, startTransition] = useTransition();
  if (questions.length === 0) return null;

  const items = questions.map((question) => ({
    name: question.fieldKey,
    required: question.required,
    choices:
      question.control === "radio" || question.control === "multi"
        ? question.options.map((option) => ({ value: option }))
        : undefined,
  }));

  return (
    <div className="w-full max-w-xl rounded-2xl rounded-bl-sm border bg-card p-4 shadow-sm">
      <Questionnaire
        items={items}
        action={(formData: FormData) =>
          startTransition(async () => {
            await submitQuestionnaire(conversationId, formData);
          })
        }
      >
        <QuestionnaireProgress />

        {questions.map((question) => (
          <QuestionnaireItem
            key={question.fieldKey}
            name={question.fieldKey}
            required={question.required}
            multiple={question.control === "multi"}
          >
            <QuestionnaireTitle>{question.questionText}</QuestionnaireTitle>
            {question.helpText ? <QuestionnaireDescription>{question.helpText}</QuestionnaireDescription> : null}

            {question.control === "radio" || question.control === "multi" ? (
              <QuestionnaireChoices>
                {question.options.map((option) => (
                  <QuestionnaireChoice key={option} value={option}>
                    {option}
                  </QuestionnaireChoice>
                ))}
              </QuestionnaireChoices>
            ) : (
              <QuestionnaireInput
                type={question.control === "number" ? "number" : question.control === "date" ? "date" : "text"}
                placeholder={question.control === "date" ? undefined : "Type your answer"}
                // The range the parser will accept, on the control itself.
                min={question.control === "number" ? question.min : undefined}
                max={question.control === "number" ? question.max : undefined}
              />
            )}

            <QuestionnaireError>Pick an answer to carry on.</QuestionnaireError>
          </QuestionnaireItem>
        ))}

        <QuestionnaireActions>
          <QuestionnairePrevious size="sm" disabled={pending} />
          {/* Blocking fields keep Skip disabled — the primitive hides it on a required item. */}
          <QuestionnaireSkip size="sm" disabled={pending}>
            Skip
          </QuestionnaireSkip>
          <QuestionnaireNext size="sm" disabled={pending} />
          <QuestionnaireSubmit size="sm" disabled={pending}>
            {pending ? <Spinner /> : "Send answers"}
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </div>
  );
}
