"use client";

/**
 * Explicit global error boundary.
 *
 * Without this file Next.js falls back to an internal default `/_global-error`
 * page that fails to prerender under Next 16 / React 19 (`useContext` of null).
 * A custom global-error Client Component replaces that default. It must render
 * its own <html> and <body> because it substitutes the root layout when a
 * root-level error occurs.
 */
export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
          <h1>Something went wrong</h1>
          <p>An unexpected error occurred while rendering this page.</p>
          {error?.digest ? <p>Reference: {error.digest}</p> : null}
          <button type="button" onClick={() => reset()}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
