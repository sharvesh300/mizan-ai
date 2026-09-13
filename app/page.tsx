import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { application, person, reviewTask } from "@/db/schema";
import { getCurrentUser } from "@/lib/session";

export default async function Home() {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
        <p className="text-zinc-600 dark:text-zinc-400">
          No users found. Seed the database with <code>bun db:seed</code>.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <div className="mb-8 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{user.fullName}</h1>
        <span className="rounded-full bg-black/[.06] px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-zinc-700 dark:bg-white/[.08] dark:text-zinc-300">
          {user.role}
        </span>
      </div>

      {user.role === "advisor" ? (
        <AdvisorQueue userId={user.id} />
      ) : (
        <ApplicantApplications userId={user.id} />
      )}
    </main>
  );
}

async function ApplicantApplications({ userId }: { userId: string }) {
  const rows = await db
    .select({
      reference: application.reference,
      status: application.status,
      personName: person.fullName,
      relationship: person.relationshipToOwner,
    })
    .from(application)
    .innerJoin(person, eq(application.personId, person.id))
    .where(eq(person.ownerUserId, userId))
    .orderBy(desc(application.createdAt));

  return (
    <section>
      <h2 className="mb-3 text-sm font-medium text-zinc-500 dark:text-zinc-400">
        My applications ({rows.length})
      </h2>
      {rows.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">No applications yet.</p>
      ) : (
        <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/15">
          {rows.map((row) => (
            <li key={row.reference} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="font-medium">{row.reference}</p>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {row.personName} · {row.relationship}
                </p>
              </div>
              <span className="text-sm font-medium">{row.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

async function AdvisorQueue({ userId }: { userId: string }) {
  const rows = await db
    .select({
      id: reviewTask.id,
      subjectType: reviewTask.subjectType,
      reason: reviewTask.reason,
      status: reviewTask.status,
      priorityScore: reviewTask.priorityScore,
    })
    .from(reviewTask)
    .where(eq(reviewTask.assignedToUserId, userId))
    .orderBy(desc(reviewTask.priorityScore));

  return (
    <section>
      <h2 className="mb-3 text-sm font-medium text-zinc-500 dark:text-zinc-400">
        My review queue ({rows.length})
      </h2>
      {rows.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">Nothing assigned.</p>
      ) : (
        <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/15">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="font-medium">{row.reason}</p>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">{row.subjectType}</p>
              </div>
              <div className="text-right text-sm">
                <p className="font-medium">{row.status}</p>
                <p className="text-zinc-500 dark:text-zinc-400">priority {row.priorityScore}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
