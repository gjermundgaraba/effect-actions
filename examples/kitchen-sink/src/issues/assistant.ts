import { LanguageModel } from "effect/ai";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { issues } from "./handlers.js";
import { CloseIssue, CommentOnIssue, GetIssue, ListIssues } from "./Issues.js";

// The actions a model may call, listed here, where they are served. Filing issues is left to
// people.
const tools = [ListIssues, GetIssue, CommentOnIssue, CloseIssue] as const;

// Some of the issue actions as a model's tools: Effect's native `Toolkit`, in process, with no
// server between. `toolkit` holds the tool definitions and `layer` their handlers, the same
// implementation every other surface serves, behind the same `authorize` and write limit.
export const { toolkit, layer } = ActionToolkit.make(issues, {
  actions: tools,
  // One rule over every call a model makes, before the call runs: a write ends the turn with
  // an approval request instead of a result. Approval is not authorization: `authorize` still
  // runs for an approved call, as for any other.
  needsApproval: (call) => !call.action.readOnly,
});

// One turn of the assistant. The caller provides the model, and the member it acts for around
// the whole turn: `authorize` and the handlers read that one caller.
export const triage = (prompt: string) => LanguageModel.generateText({ prompt, toolkit });
