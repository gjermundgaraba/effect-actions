import { Assistant } from "./assistant/Assistant.js";
import { AttachImage, GetAttachment } from "./attachments/Attachments.js";
import { WhoAmI } from "./identity/Identity.js";
import { ExportIssues, Issues } from "./issues/Issues.js";
import { GetStatus } from "./workspaces/Workspaces.js";

// Which actions each surface gets. A contract says nothing about where it is served: each
// surface takes a list, and these are the lists, built from the contracts themselves.

/** What a signed-in member may call: every protected action of the public port. */
export const MemberActions = [
  WhoAmI,
  ...Issues,
  ExportIssues,
  AttachImage,
  GetAttachment,
  ...Assistant,
] as const;

/**
 * The MCP tools, for the HTTP endpoint and the stdio server alike. `attachImage` is left out:
 * listing it throws, since MCP takes no image as input. So is the assistant: it is a model
 * itself, and its tools are already here. `exportIssues` answers a stream, which no tool can, so
 * a list naming it would be refused.
 */
export const Tools = [GetStatus, WhoAmI, ...Issues, GetAttachment] as const;
