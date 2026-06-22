"use client";

import { useEffect, useRef, useState } from "react";
import {
  fetchQuery,
  graphql,
  RelayEnvironmentProvider,
  useFragment,
} from "react-relay";
import { createOperationDescriptor, type Disposable, getRequest } from "relay-runtime";

import type { pageRoomDetailFragment$key } from "../__generated__/pageRoomDetailFragment.graphql";
import type { RoomDetailQuery as RoomDetailQueryType } from "../__generated__/RoomDetailQuery.graphql";
import type { RoomListQuery as RoomListQueryType } from "../__generated__/RoomListQuery.graphql";
import { getEnvironment } from "../src/relay";

const RoomDetailFragment = graphql`
  fragment pageRoomDetailFragment on Room {
    id
    profile {
      id
      name
    }
  }
`;

// The "detail page" query — selects room.profile (the child that will be collected).
const RoomDetailQuery = graphql`
  query RoomDetailQuery($id: ID!) {
    room(id: $id) {
      ...pageRoomDetailFragment
    }
  }
`;

// The "list page" query — references the SAME Room:1 record but selects only
// {id, name}, NOT its `profile` child. While only this op is retained, GC marks
// reachability from its selection set alone, so Profile:p1 becomes unreachable
// and is collected, even though Room:1 survives.
const RoomListQuery = graphql`
  query RoomListQuery($id: ID!) {
    room(id: $id) {
      id
      name
    }
  }
`;

function Detail({ roomRef }: { roomRef: pageRoomDetailFragment$key }) {
  const room = useFragment(RoomDetailFragment, roomRef);
  // Unguarded nested access — the production pattern: read a nested field on what
  // the generated types say is a non-null record (e.g. `.__id` on a connection or
  // `.__typename` on a nested object).
  // `profile` is NON-NULL in the schema, so the generated type is
  // `profile: { name: string }` and this line type-checks and compiles. After GC
  // strips Profile:p1 it is `undefined` at runtime -> `.name` throws -> error.tsx.
  return <p data-testid="detail">profile.name = {room.profile.name}</p>;
}

export default function Page() {
  const environment = getEnvironment();
  const [roomRef, setRoomRef] = useState<pageRoomDetailFragment$key | null>(null);
  const detailRetain = useRef<Disposable | null>(null);
  const listRetain = useRef<Disposable | null>(null);

  useEffect(() => {
    const vars = { id: "1" };
    const detailOp = createOperationDescriptor(getRequest(RoomDetailQuery), vars);
    const listOp = createOperationDescriptor(getRequest(RoomListQuery), vars);
    void Promise.all([
      fetchQuery<RoomDetailQueryType>(environment, RoomDetailQuery, vars).toPromise(),
      fetchQuery<RoomListQueryType>(environment, RoomListQuery, vars).toPromise(),
    ]).then(() => {
      // Both screens mounted -> both ops retained (the detail page and an
      // <Activity>-kept list page that the router keeps alive in the background).
      detailRetain.current = environment.retain(detailOp);
      listRetain.current = environment.retain(listOp);
      const root = environment.lookup(detailOp.fragment).data as {
        room: pageRoomDetailFragment$key;
      };
      setRoomRef(root.room);
    });
    return () => {
      detailRetain.current?.dispose();
      listRetain.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function releaseDetailAndGc() {
    // 1) Navigate away from the detail screen: the router releases the detail
    //    query's retention. The list op stays retained (its <Activity> subtree is
    //    kept mounted). With gcReleaseBufferSize:0 + a synchronous gcScheduler, GC
    //    runs now and collects Profile:p1 (reachable only from the released detail
    //    op) while Room:1 survives (kept by the list op).
    detailRetain.current?.dispose();
    detailRetain.current = null;

    // 2) A later store update touches Room:1 (a background event arriving after
    //    navigation). The Detail fragment is STILL mounted/subscribed, so it
    //    re-reads — now a PARTIAL snapshot (room.profile === undefined) — and the
    //    unguarded `.name` access throws into the error boundary. This is the
    //    record being collected out from under a live subscription: the patch in
    //    ../relay-gc-patch makes GC keep Profile:p1 because a live subscription
    //    still reads it.
    environment.commitUpdate((store) => {
      const room = store.get("1");
      if (room != null) room.setValue("Room One (updated)", "name");
    });
  }

  return (
    <RelayEnvironmentProvider environment={environment}>
      <main style={{ padding: 24, lineHeight: 1.6 }}>
        <h1>Relay GC partial-read repro</h1>
        {roomRef == null ? (
          <p>loading…</p>
        ) : (
          <>
            <Detail roomRef={roomRef} />
            <button data-testid="crash" onClick={releaseDetailAndGc}>
              release detail query + GC (→ crash)
            </button>
          </>
        )}
      </main>
    </RelayEnvironmentProvider>
  );
}
