"use client";

// The dev gallery for the servicing cards — a way to design and review them BEFORE the agent graph exists.
//
// Every card here is what a tool actually returned when a scripted conversation drove the real
// registry (db/seed/scenarios.ts), not a hand-drawn fixture — so the gallery cannot show a shape the
// tools cannot produce. Interactions are live but inert: each handler records what it was called with,
// which is the whole contract a card has with the rest of the system (a chip press reports WHICH chip;
// nothing on a card is a source of truth).

import { useState } from "react";
import { MonitorIcon, RotateCcwIcon, SmartphoneIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ServicingCard } from "@/lib/servicing/cards";
import { ServicingCardView } from "./servicing-card";

export type GalleryItem = { group: string; label: string; note: string; card: ServicingCard };

// Obviously fake numbers: the real advisor number is server configuration and must never be invented here.
const FAKE_ADVISOR = "+971 00 000 0000";
const FAKE_MEMBER = "+971 50 000 0000";

export function Gallery({ items }: { items: GalleryItem[] }) {
  const [phone, setPhone] = useState(true);
  const [answered, setAnswered] = useState<Record<number, string>>({});
  const [log, setLog] = useState<string[]>([]);

  const record = (index: number, what: string, answer?: string) => {
    setLog((l) => [`#${index + 1} ${what}`, ...l].slice(0, 12));
    if (answer !== undefined) setAnswered((a) => ({ ...a, [index]: answer }));
  };

  const groups = [...new Set(items.map((i) => i.group))];

  return (
    <div className="space-y-8">
      <div className="sticky top-14 z-10 -mx-4 flex flex-wrap items-center gap-2 border-b bg-background/90 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6">
        <div role="group" aria-label="Frame width" className="flex gap-1">
          <Button type="button" size="sm" variant={phone ? "default" : "outline"} aria-pressed={phone} onClick={() => setPhone(true)}>
            <SmartphoneIcon />
            Phone · 375
          </Button>
          <Button type="button" size="sm" variant={!phone ? "default" : "outline"} aria-pressed={!phone} onClick={() => setPhone(false)}>
            <MonitorIcon />
            Wide
          </Button>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={() => (setAnswered({}), setLog([]))}>
          <RotateCcwIcon />
          Reset
        </Button>
        <p className="ml-auto text-xs text-muted-foreground">Toggle the theme from the header. {items.length} cards.</p>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_16rem]">
        <div className="space-y-10">
          {groups.map((group) => (
            <section key={group} className="space-y-4">
              <div>
                <h2 className="text-sm font-medium">{group}</h2>
                <p className="max-w-2xl text-xs text-muted-foreground text-pretty">{items.find((i) => i.group === group)!.note}</p>
              </div>
              {items.map((item, index) =>
                item.group !== group ? null : (
                  <div key={index} className="space-y-1.5">
                    <p className="font-mono text-xs text-muted-foreground">
                      #{index + 1} · {item.card.kind} · <span className="font-sans">{item.label}</span>
                    </p>
                    <div style={{ maxWidth: phone ? 375 : 720 }} className="rounded-xl border border-dashed p-2">
                      <ServicingCardView
                        card={item.card}
                        advisorPhone={FAKE_ADVISOR}
                        defaultPhone={FAKE_MEMBER}
                        answered={answered[index] ?? null}
                        handlers={{
                          onAnswer: (a) => record(index, `answer ${a.fieldKey} = ${a.value}`, a.label),
                          onConfirm: () => record(index, "confirm", "Looks right"),
                          onChange: () => record(index, "change something", "Change something"),
                          onSubmitForm: (v) => record(index, `form ${JSON.stringify(v)}`, "submitted"),
                          onEvidence: (t) => record(index, `evidence “${t.slice(0, 40)}”`, t),
                          onDeclineEvidence: () => record(index, "declined evidence", "I don't have this"),
                          onChooseConflict: (v) => record(index, `chose ${v}`, v),
                          onAppeal: () => record(index, "appeal"),
                          onCallback: (r) => record(index, `callback ${r.window} ${r.phone}`),
                          onTalkToAdvisor: () => record(index, "talk to an advisor"),
                        }}
                      />
                    </div>
                    <details className="max-w-2xl text-xs">
                      <summary className="cursor-pointer text-muted-foreground select-none">Payload — exactly what the tool returned</summary>
                      <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-snug">{JSON.stringify(item.card, null, 2)}</pre>
                    </details>
                  </div>
                ),
              )}
            </section>
          ))}
        </div>

        <aside aria-label="What the cards reported" className="lg:sticky lg:top-28 lg:self-start">
          <h2 className="mb-2 text-sm font-medium">What the cards reported</h2>
          {log.length === 0 ? (
            <p className="text-xs text-muted-foreground text-pretty">Press a chip. A card reports only WHICH chip — the server re-derives what it means.</p>
          ) : (
            <ol className="space-y-1 font-mono text-[11px]">
              {log.map((line, i) => (
                <li key={i} className="rounded bg-muted px-2 py-1">
                  {line}
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
    </div>
  );
}
