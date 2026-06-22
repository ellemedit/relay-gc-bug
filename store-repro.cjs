/**
 * Deterministic, zero-React reproduction of the relay-runtime store-GC partial read.
 *
 * Runs against this repo's own relay-runtime (see package.json — `npm run repro`).
 *
 * Mechanism (relay-runtime 21.0.1):
 *   Relay's store GC (`RelayModernStore._collect`) marks record reachability by
 *   walking the SELECTION TREE of each *retained operation* only
 *   (`RelayReferenceMarker.mark`). It never consults active store subscriptions.
 *   So a record kept alive by operation A (which selects a subset of fields) can
 *   have a linked child collected when operation B — the only op that selected
 *   that child — is released, EVEN WHILE a live fragment subscription is still
 *   reading that child. The surviving parent then yields a partial read
 *   (`isMissingData: true`) and unguarded nested access throws a TypeError.
 *
 * This is the lower-level core of real production white-screen crashes in a
 * Relay app: a linked child (a connection, or a nested object field) is collected
 * by GC while the parent record survives via another retained operation, with the
 * consuming fragment kept mounted by React <Activity>. The unguarded nested access
 * on the surviving parent then throws (e.g. `reading '__id'` / `reading
 * '__typename'` on what the generated types say is a non-null field).
 *
 * The fix is in the sibling repo `relay-gc-patch` (Patch S): GC also protects the
 * records in every active subscription's `seenRecords`, so a record a live reader
 * depends on is never collected.
 */
"use strict";

const {
  Environment,
  Network,
  RecordSource,
  Store,
  createOperationDescriptor,
} = require("relay-runtime");

// --- hand-authored compiled operations (v21 ConcreteRequest shape) ---
// schema (conceptually):
//   type Query { room(id: ID!): Room }
//   type Room { id: ID!, name: String!, profile: Profile! }
//   type Profile { id: ID!, name: String! }
const idScalar = { alias: null, args: null, kind: "ScalarField", name: "id", storageKey: null };
const nameScalar = { alias: null, args: null, kind: "ScalarField", name: "name", storageKey: null };
const roomArgs = [{ kind: "Variable", name: "id", variableName: "id" }];
const argDefs = [{ defaultValue: null, kind: "LocalArgument", name: "id" }];

// QB — the "detail" op: selects room.profile (the child that will be collected).
const profileLinked = {
  alias: null, args: null, concreteType: "Profile", kind: "LinkedField",
  name: "profile", plural: false, storageKey: null,
  selections: [idScalar, nameScalar],
};
const roomLinkedB = {
  alias: null, args: roomArgs, concreteType: "Room", kind: "LinkedField",
  name: "room", plural: false, storageKey: null,
  selections: [idScalar, nameScalar, profileLinked],
};
const QB = {
  fragment: { argumentDefinitions: argDefs, kind: "Fragment", metadata: null, name: "QB", selections: [roomLinkedB], type: "Query", abstractKey: null },
  kind: "Request",
  operation: { argumentDefinitions: argDefs, kind: "Operation", name: "QB", selections: [roomLinkedB] },
  params: { cacheID: "QB", id: null, metadata: {}, name: "QB", operationKind: "query", text: "query QB($id:ID!){room(id:$id){id name profile{id name}}}" },
};

// QA — the "list" op: references the SAME Room:1 record but selects only {id name}.
const roomLinkedA = {
  alias: null, args: roomArgs, concreteType: "Room", kind: "LinkedField",
  name: "room", plural: false, storageKey: null,
  selections: [idScalar, nameScalar],
};
const QA = {
  fragment: { argumentDefinitions: argDefs, kind: "Fragment", metadata: null, name: "QA", selections: [roomLinkedA], type: "Query", abstractKey: null },
  kind: "Request",
  operation: { argumentDefinitions: argDefs, kind: "Operation", name: "QA", selections: [roomLinkedA] },
  params: { cacheID: "QA", id: null, metadata: {}, name: "QA", operationKind: "query", text: "query QA($id:ID!){room(id:$id){id name}}" },
};

function assert(cond, msg) {
  if (!cond) { console.error("❌ FAIL:", msg); process.exitCode = 1; }
  else console.log("✅", msg);
}

const environment = new Environment({
  network: Network.create(() => Promise.reject(new Error("no network in repro"))),
  store: new Store(new RecordSource(), {
    gcReleaseBufferSize: 0, // evict released operations immediately
    gcScheduler: (run) => run(), // run GC synchronously so the repro is deterministic
  }),
});

const vars = { id: "1" };
const opA = createOperationDescriptor(QA, vars);
const opB = createOperationDescriptor(QB, vars);

// Populate the store as the app would: both ops write the shared Room:1 record.
environment.commitPayload(opB, {
  room: { id: "1", name: "Room One", profile: { id: "p1", name: "Alice" } },
});
environment.commitPayload(opA, { room: { id: "1", name: "Room One" } });

// Both screens are mounted -> both ops retained.
const retainA = environment.retain(opA); // the room-list page (Activity-kept)
const retainB = environment.retain(opB); // the room-detail page

// The detail screen has a LIVE fragment subscription reading room.profile — the
// store-level equivalent of a mounted useFragment(...). seenRecords for this
// snapshot includes Profile:p1.
const detailSnapshot = environment.lookup(opB.fragment);
const subscription = environment.subscribe(detailSnapshot, () => {});

assert(detailSnapshot.isMissingData === false, "[before] detail read is complete (isMissingData=false)");
assert(detailSnapshot.data?.room?.profile?.name === "Alice", "[before] room.profile.name === 'Alice'");
assert(environment.getStore().getSource().get("p1") != null, "[before] Profile:p1 record present in store");
assert(
  detailSnapshot.seenRecords instanceof Set
    ? detailSnapshot.seenRecords.has("p1")
    : Object.prototype.hasOwnProperty.call(detailSnapshot.seenRecords, "p1"),
  "[before] the live detail subscription's seenRecords includes Profile:p1",
);

// The detail screen unmounts (navigated away); its operation retention is released.
// The list op (QA) stays retained -> keeps Room:1 alive, but does NOT select profile.
// The detail fragment subscription, however, is STILL active (Activity-kept).
retainB.dispose();

// GC ran synchronously, marking reachability from QA only (NOT from the live
// subscription — that is the bug Patch S fixes).
const profileRec = environment.getStore().getSource().get("p1");
const roomRec = environment.getStore().getSource().get("1");
assert(roomRec != null, "[after GC] Room:1 SURVIVES (still reachable via retained QA)");
assert(
  profileRec == null,
  "[after GC] Profile:p1 COLLECTED out from under the live subscription (the BUG; Patch S keeps it)",
);

// A reader still interested in the detail data now gets a PARTIAL snapshot.
const after = environment.lookup(opB.fragment);
assert(after.isMissingData === true, "[after GC] detail re-read is PARTIAL (isMissingData=true)");
assert(after.data?.room != null, "[after GC] room present");
assert(after.data?.room?.profile === undefined, "[after GC] room.profile === undefined (the partial read)");

// The exact production crash class: unguarded nested access on the partial read.
let threw = null;
try {
  const _ = after.data.room.profile.name; // unguarded access on the partial read
  void _;
} catch (e) {
  threw = e;
}
assert(
  threw instanceof TypeError &&
    /Cannot read properties of undefined|undefined is not an object/.test(threw.message),
  `[after GC] unguarded \`room.profile.name\` throws TypeError -> ${threw && threw.message}`,
);

subscription.dispose();
retainA.dispose();
console.log(
  process.exitCode
    ? "\nREPRO FAILED (the bug did not reproduce on this relay-runtime)"
    : "\nREPRO OK — GC strips a co-referenced child out from under a live subscription; the surviving parent yields a partial read that crashes on unguarded access.",
);
