import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Gallery } from "@/components/servicing/cards/gallery";
import { PageBody, PageHeader } from "@/components/page-header";
import { allGalleryCards } from "@/db/seed/gallery";

export const metadata: Metadata = { title: "Servicing cards · dev" };

/**
 * Every card the servicing agent can put in front of a member, as the tools actually produced them.
 *
 * A DEV surface: a 404 in production. It exists so the cards can be designed and reviewed in the open —
 * in light and dark, at phone width and wide — before the graph that will render them exists.
 */
export default function ServicingCardsGallery() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <>
      <PageHeader
        title="Servicing cards"
        description="Dev only. Each card is what a tool returned when a scripted conversation drove the real registry — not a hand-drawn fixture. Interactions are live but inert."
      />
      <PageBody>
        <Gallery items={allGalleryCards()} />
      </PageBody>
    </>
  );
}
