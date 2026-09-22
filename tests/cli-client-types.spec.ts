// Remote commands cannot install a local authorization hook.
import type * as ActionCliClient from "../src/ActionCliClient.js";

export const remoteOptionsHaveNoHook: "before" extends keyof ActionCliClient.Options<string>
  ? true
  : false = false;

export const remoteGroupOptionsHaveNoHook: "before" extends keyof ActionCliClient.GroupOptions
  ? true
  : false = false;
