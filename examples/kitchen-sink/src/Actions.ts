import { Assistant } from "./assistant/Assistant.js";
import { AttachImage, GetAttachment } from "./attachments/Attachments.js";
import { WhoAmI } from "./identity/Identity.js";
import { Issues } from "./issues/Issues.js";
import { GetStatus } from "./workspaces/Workspaces.js";

// Which actions each surface gets. A contract says nothing about where it is served: each
// surface takes a list, and these are the lists, built from the contracts themselves.

/** What a signed-in member may call: every protected action of the public port. */
export const MemberActions = [WhoAmI, ...Issues, AttachImage, GetAttachment, ...Assistant] as const;

/**
 * The MCP tools, for the HTTP endpoint and the stdio server alike. `attachImage` is left out:
 * a model should not carry an image's bytes as an argument. So is the assistant: it is a model
 * itself, and its tools are already here. An action added to a domain later is no tool until
 * it is listed here.
 */
export const Tools = [GetStatus, WhoAmI, ...Issues, GetAttachment] as const;
