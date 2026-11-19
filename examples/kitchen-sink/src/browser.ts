import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect } from "effect";

import { Rpc } from "./Rpc.js";

export const board = (url: string) =>
  Effect.gen(function* () {
    const tracker = yield* ActionRpc.socketClient(Rpc, { url });

    const me = yield* tracker.whoAmI();
    const { issues } = yield* tracker.listIssues({ status: "open", limit: 50 });

    return { me, issues };
  });

export const open = async (url: string) =>
  await Effect.runPromise(Effect.scoped(board(url)));
