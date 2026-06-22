/**
 * Same strip as store-repro.cjs, but with DEFAULT store GC options — to show that
 * `gcReleaseBufferSize: 0` + a synchronous `gcScheduler` only make the bug
 * DETERMINISTIC; they do not create it.
 *
 * Here the store uses Relay's defaults (gcReleaseBufferSize: 10, async scheduler).
 * The released detail op sits in the 10-slot release buffer until enough other
 * operations are released to age it out — exactly what real navigation churn does.
 * We then run one GC pass (the scheduler does this asynchronously in production;
 * `store.__gc()` runs it synchronously so the test is deterministic) and observe
 * the identical result: the co-referenced child is collected, the parent survives.
 */
"use strict";

const {
  Environment,
  Network,
  RecordSource,
  Store,
  createOperationDescriptor,
} = require("relay-runtime");

const idScalar = { alias: null, args: null, kind: "ScalarField", name: "id", storageKey: null };
const nameScalar = { alias: null, args: null, kind: "ScalarField", name: "name", storageKey: null };
const roomArgs = [{ kind: "Variable", name: "id", variableName: "id" }];
const argDefs = [{ defaultValue: null, kind: "LocalArgument", name: "id" }];
const profileLinked = {
  alias: null, args: null, concreteType: "Profile", kind: "LinkedField",
  name: "profile", plural: false, storageKey: null, selections: [idScalar, nameScalar],
};
const roomB = {
  alias: null, args: roomArgs, concreteType: "Room", kind: "LinkedField",
  name: "room", plural: false, storageKey: null, selections: [idScalar, nameScalar, profileLinked],
};
const roomA = {
  alias: null, args: roomArgs, concreteType: "Room", kind: "LinkedField",
  name: "room", plural: false, storageKey: null, selections: [idScalar, nameScalar],
};
const QB = {
  fragment: { argumentDefinitions: argDefs, kind: "Fragment", metadata: null, name: "QB", selections: [roomB], type: "Query", abstractKey: null },
  kind: "Request",
  operation: { argumentDefinitions: argDefs, kind: "Operation", name: "QB", selections: [roomB] },
  params: { cacheID: "QB", id: null, metadata: {}, name: "QB", operationKind: "query", text: "query QB($id:ID!){room(id:$id){id name profile{id name}}}" },
};
const QA = {
  fragment: { argumentDefinitions: argDefs, kind: "Fragment", metadata: null, name: "QA", selections: [roomA], type: "Query", abstractKey: null },
  kind: "Request",
  operation: { argumentDefinitions: argDefs, kind: "Operation", name: "QA", selections: [roomA] },
  params: { cacheID: "QA", id: null, metadata: {}, name: "QA", operationKind: "query", text: "query QA($id:ID!){room(id:$id){id name}}" },
};

function assert(cond, msg) {
  if (!cond) { console.error("❌ FAIL:", msg); process.exitCode = 1; }
  else console.log("✅", msg);
}

// DEFAULT store options — no gcReleaseBufferSize override, no custom gcScheduler.
const store = new Store(new RecordSource());
const environment = new Environment({
  network: Network.create(() => Promise.reject(new Error("no network"))),
  store,
});

const opA = createOperationDescriptor(QA, { id: "1" });
const opB = createOperationDescriptor(QB, { id: "1" });
environment.commitPayload(opB, { room: { id: "1", name: "Room One", profile: { id: "p1", name: "Alice" } } });
environment.commitPayload(opA, { room: { id: "1", name: "Room One" } });

const retainA = environment.retain(opA);
const retainB = environment.retain(opB);

assert(store.getSource().get("p1") != null, "[before] Profile:p1 present");

// Navigate away from the detail screen: the detail op enters the 10-slot release
// buffer (default gcReleaseBufferSize) but is NOT collected yet.
retainB.dispose();
assert(store.getSource().get("p1") != null, "[buffered] Profile:p1 still present (detail op sits in the release buffer)");

// Real navigation churn: release 11 more distinct operations, aging the detail op
// out of the buffer so it is dropped from the GC roots.
for (let i = 0; i < 11; i++) {
  const fillerOp = createOperationDescriptor(QA, { id: `filler-${i}` });
  environment.commitPayload(fillerOp, { room: { id: `filler-${i}`, name: "x" } });
  environment.retain(fillerOp).dispose();
}

// Run one GC pass (async in production via the scheduler; forced synchronously here).
store.__gc();

assert(store.getSource().get("1") != null, "[after default GC] Room:1 SURVIVES (kept by retained QA)");
assert(store.getSource().get("p1") == null, "[after default GC] Profile:p1 COLLECTED — same strip, DEFAULT gc options");

const after = environment.lookup(opB.fragment);
assert(after.isMissingData === true, "[after default GC] detail re-read is PARTIAL (isMissingData=true)");
assert(after.data?.room?.profile === undefined, "[after default GC] room.profile === undefined");

retainA.dispose();
console.log(
  process.exitCode
    ? "\nDEFAULT-GC REPRO FAILED"
    : "\nDEFAULT-GC REPRO OK — with stock gcReleaseBufferSize:10 + async scheduler, the same child is stripped once the released op ages out of the buffer. The knobs in store-repro.cjs only remove that timing.",
);
