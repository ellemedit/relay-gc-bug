# relay-gc-bug — Relay store-GC strips a co-referenced child out from under a live fragment

A minimal **Next.js (App Router) + Relay 21** reproduction of a Relay store
garbage-collection bug: a record kept alive by one retained operation can have a
**linked child record garbage-collected while a live fragment subscription is
still reading it**. The surviving parent then yields a *partial read*
(`isMissingData: true`), and unguarded nested access throws a `TypeError` — a
blank "white screen" crash.

The proposed fix lives in the sibling repo **[`relay-gc-patch`](https://github.com/ellemedit/relay-gc-patch)**.

## TL;DR

Relay's GC (`RelayModernStore._collect`) marks record reachability by walking the
**selection tree of each *retained operation*** (`RelayReferenceMarker.mark`). It
**never consults active store subscriptions**. So:

1. Operation **A** (`{ room { id name } }`) and operation **B**
   (`{ room { id name profile { id name } } }`) both write the shared `Room:1`
   record. `Profile:p1` is a *separate* record, linked from `Room:1`, selected
   **only by B**.
2. Both screens are mounted, so both ops are retained. A live `useFragment`
   reads `room.profile` — its snapshot's `seenRecords` includes `Profile:p1`.
3. You navigate away from the detail screen. The router releases **B**'s
   retention; **A** stays retained (its `<Activity>` subtree is kept mounted).
4. GC marks reachability from **A** only → `Room:1` survives, but `Profile:p1`
   is **collected — even though the live subscription is still reading it.**
5. The still-mounted fragment re-reads a **partial** snapshot
   (`room.profile === undefined`). `useFragmentInternal` does not re-suspend a
   committed fragment that has no in-flight operation, so it returns the partial
   data, and `room.profile.name` throws.

`profile` is **non-null in the schema**, so the generated TypeScript type is
`profile: { name: string }` and `room.profile.name` type-checks and compiles.
That is the trap: the type says non-null, GC makes it absent at runtime.

This is the isolated root cause of real production white-screen crashes in a Relay
app — unguarded reads like `.__id` on a connection or `.__typename` on a nested
object, where the linked child was collected by GC while its parent survived and
the consuming fragment stayed mounted under React `<Activity>` (Next 16
`cacheComponents`).

## Two reproductions

### 1. Store-level, deterministic, zero-React, zero-install — `npm run repro`

```bash
npm install
npm run repro     # node store-repro.cjs
```

Runs against this repo's own `relay-runtime@21.0.1`. It commits the shared record
via two ops, opens a live subscription on the detail fragment, releases the
detail op, runs GC synchronously, and asserts the child was collected and the
re-read is partial. Verified output:

```
✅ [before] detail read is complete (isMissingData=false)
✅ [before] room.profile.name === 'Alice'
✅ [before] Profile:p1 record present in store
✅ [before] the live detail subscription's seenRecords includes Profile:p1
✅ [after GC] Room:1 SURVIVES (still reachable via retained QA)
✅ [after GC] Profile:p1 COLLECTED out from under the live subscription (the BUG; Patch S keeps it)
✅ [after GC] detail re-read is PARTIAL (isMissingData=true)
✅ [after GC] room.profile === undefined (the partial read)
✅ [after GC] unguarded `room.profile.name` throws TypeError -> Cannot read properties of undefined (reading 'name')
REPRO OK
```

> The store options (`gcReleaseBufferSize: 0` + a synchronous `gcScheduler`) only
> make this deterministic. `npm run repro:default-gc` proves the identical strip
> with Relay's **stock defaults** (`gcReleaseBufferSize: 10`, async scheduler): the
> released detail op sits in the release buffer until normal navigation churn ages
> it out, then GC collects the child. The knobs don't create the bug, they remove
> the timing noise that makes it look "random" in production.

### 2. End-to-end in the browser — `npm run build && npm start`

```bash
npm install
npm run build     # relay-compiler + next build
npm start         # http://localhost:3000
```

1. The page loads and `<Detail>` renders `profile.name = Alice`.
2. Click **"release detail query + GC (→ crash)"**. This releases the detail
   query's retention (as the router does on navigation) while the list op stays
   retained, and runs GC — which collects `Profile:p1`. It then fires one store
   write to the surviving `Room:1` (a stand-in for a background event such as a
   websocket/poll update) to make the still-mounted fragment re-read.
3. The re-read is now **partial** — `room.profile` is `undefined` —
   so `room.profile.name` throws → `app/error.tsx` shows the crash
   ("Failed to load this screen. (CRASHED)" +
   `Cannot read properties of undefined (reading 'name')`). The partial state is
   created by GC; the store write is only the trigger that forces the re-read.

## Why "only an app restart fixes it" in production

The Relay `Environment`/`Store` is a **module singleton** (`src/relay.ts`). Next's
error boundary `reset()` only re-renders the React subtree; it never rebuilds the
store. So the same partial record is read again and throws again. Only a full
document reload (app restart) rebuilds the store. (The fix repo also wires the
error boundary to rebuild the Relay environment as a recovery layer.)

## Determinism knobs

`src/relay.ts` sets `gcReleaseBufferSize: 0` and a synchronous `gcScheduler` so the
strip happens on the exact navigation instead of after enough navigations age the
default release buffer (`gcReleaseBufferSize: 10`). That buffer is why the
production crash is intermittent ("random") rather than every navigation. The bug
itself does not depend on these knobs — they only remove the timing noise.

## Versions

`next@16.2.6` · `react@19.2.0` · `react-relay@21.0.1` · `relay-runtime@21.0.1` ·
`relay-compiler@21.0.1`. Node 24.

## Files

| Path | What |
|---|---|
| `store-repro.cjs` | Deterministic store-level repro (run with `npm run repro`). |
| `store-repro-default-gc.cjs` | The same strip with Relay's stock GC defaults (`npm run repro:default-gc`). |
| `schema.graphql` | 3-type schema: `Query.room → Room.profile → Profile`. |
| `app/page.tsx` | The two queries + the live `useFragment` + the navigation/GC trigger. |
| `src/relay.ts` | Module-singleton Relay environment with deterministic GC settings + a no-backend network layer. |
| `app/error.tsx` | The error boundary (the "white screen"). |
| `next.config.mjs` | `cacheComponents: true` (the `<Activity>` amplifier) + the Relay SWC transform. |
