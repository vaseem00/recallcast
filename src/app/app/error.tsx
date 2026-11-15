"use client"; // Error boundaries must be Client Components

import ErrorSlot from "@/components/ErrorSlot";

/** Errors in a signed-in page: shown inside the /app shell, so the nav stays usable. */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  return <ErrorSlot error={error} retry={retry} backHref="/app" backLabel="Back to your library" />;
}
