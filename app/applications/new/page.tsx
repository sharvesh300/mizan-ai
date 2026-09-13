import { ArrowRightIcon, ClockIcon, FileTextIcon, MessageSquareIcon } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const OPTIONS = [
  {
    href: "/applications/new/form",
    icon: FileTextIcon,
    title: "Fill in a form",
    description: "Every question on one page. Best if you have your details to hand and want it done in one go.",
    meta: "About 2 minutes",
  },
  {
    href: "/applications/new/chat",
    icon: MessageSquareIcon,
    title: "Talk it through",
    description:
      "One question at a time, in your own words. You can stop halfway and pick up exactly where you left off.",
    meta: "About 1 minute",
  },
];

export default function NewApplicationPage() {
  return (
    <>
      <PageHeader
        backHref="/applications"
        backLabel="My applications"
        title="Start an application"
        description="Two ways in — they ask for the same things and end up in the same place. Pick whichever suits you."
      />
      <PageBody>
        <div className="grid gap-4 md:grid-cols-2">
          {OPTIONS.map((option) => (
            <Link key={option.href} href={option.href} className="group focus-visible:outline-none">
              <Card className="h-full transition-all group-hover:ring-brand/50 group-focus-visible:ring-3 group-focus-visible:ring-ring/50">
                <CardHeader>
                  <span className="flex size-10 items-center justify-center rounded-xl bg-brand-subtle text-brand">
                    <option.icon className="size-5" />
                  </span>
                  <CardTitle className="mt-3 flex items-center gap-2">
                    {option.title}
                    <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </CardTitle>
                  <CardDescription className="text-pretty">{option.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ClockIcon className="size-3.5" />
                    {option.meta}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </PageBody>
    </>
  );
}
