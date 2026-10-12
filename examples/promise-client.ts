import { Effect } from "effect";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http } from "./binding.js";

// Built once, outside any Effect: its methods need nothing more.
export const api = ActionHttp.fetchClient(Http);

// A promise per call. A declared error rejects it as its decoded value, so
// `error instanceof UserNotFound` holds in a `catch`.
export const userName = async (id: string): Promise<string> =>
  (await Effect.runPromise(api.getUser({ id }))).name;
