import { Assistant } from "./assistant/Assistant.js";
import { AttachImage, GetAttachment } from "./attachments/Attachments.js";
import { WhoAmI } from "./identity/Identity.js";
import { ExportIssues, Issues } from "./issues/Issues.js";
import { GetStatus } from "./workspaces/Workspaces.js";

export const MemberActions = [
  WhoAmI,
  ...Issues,
  ExportIssues,
  AttachImage,
  GetAttachment,
  ...Assistant,
] as const;

export const Tools = [GetStatus, WhoAmI, ...Issues, GetAttachment] as const;
