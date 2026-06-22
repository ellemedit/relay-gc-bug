"use client";

import {
  Environment,
  Network,
  RecordSource,
  type RequestParameters,
  Store,
  type Variables,
} from "relay-runtime";

// Module-singleton environment, as in a typical Relay app. This singleton is why
// the production crash is "restart-only": Next's error boundary reset() re-renders
// the React tree but never rebuilds this store, so the partial record is read
// again and throws again until a full document reload.
//
// The GC options make the strip deterministic instead of relying on navigation
// churn to age the release buffer:
//   - gcReleaseBufferSize: 0  -> a released operation is collected immediately
//   - gcScheduler: run => run -> GC runs synchronously
// The DEFAULT is gcReleaseBufferSize: 10 with an async scheduler, which is why the
// real crash is intermittent ("random") rather than every navigation.
let environment: Environment | null = null;

// No backend: the network layer serves fixed payloads keyed by operation name.
function fetchFn(params: RequestParameters, _variables: Variables) {
  if (params.name === "RoomDetailQuery") {
    return Promise.resolve({
      data: {
        room: { id: "1", name: "Room One", profile: { id: "p1", name: "Alice" } },
      },
    });
  }
  // RoomListQuery references Room:1 but NOT its profile child.
  return Promise.resolve({ data: { room: { id: "1", name: "Room One" } } });
}

export function getEnvironment(): Environment {
  if (environment == null) {
    environment = new Environment({
      network: Network.create(fetchFn),
      store: new Store(new RecordSource(), {
        gcReleaseBufferSize: 0,
        gcScheduler: (run) => run(),
      }),
    });
  }
  return environment;
}
