import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { LanguageModel } from "effect/ai";

import { issues } from "./handlers.js";
import { CloseIssue, CommentOnIssue, GetIssue, ListIssues } from "./Issues.js";

const tools = [ListIssues, GetIssue, CommentOnIssue, CloseIssue] as const;

export const { toolkit, layer } = ActionToolkit.make(issues, {
  actions: tools,
  needsApproval: (call) => !call.action.readOnly,
});

export const triage = (prompt: string) =>
  LanguageModel.generateText({ prompt, toolkit });
