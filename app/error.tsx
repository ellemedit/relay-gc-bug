"use client";

// The "white screen": Next's error boundary. A partial-read TypeError lands here.
//
// Note `reset()` only re-renders the React subtree. Because the Relay Environment
// is a module singleton (src/relay.ts), the same partial record is read again and
// throws again — which is why, in production, only a full app restart recovers.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{ padding: 24 }} data-testid="error-boundary">
      <h1>Failed to load this screen. (CRASHED)</h1>
      <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>
        {String(error?.message ?? error)}
      </pre>
      <button onClick={() => reset()}>reset (does NOT recover)</button>
    </div>
  );
}
