// Compile-only checks for the API definitions copied into the reference cards.
import type { Command } from "effect/unstable/cli";
import * as ActionCliClient from "../src/ActionCliClient.js";
import type * as Documented from "../examples/cli-client-options.js";
import { httpClient } from "../examples/testing-http-client.js";
import * as Testing from "../src/Testing.js";

export const nativeOptions = <Output, Parameters extends Command.Command.Config>(
  options: Documented.Options<Output, Parameters>,
): ActionCliClient.Options<Output, Parameters> => options;

export const documentedOptions = <Output, Parameters extends Command.Command.Config>(
  options: ActionCliClient.Options<Output, Parameters>,
): Documented.Options<Output, Parameters> => options;

export const nativeGroupOptions = (
  options: Documented.GroupOptions,
): ActionCliClient.GroupOptions => options;

export const documentedGroupOptions = (
  options: ActionCliClient.GroupOptions,
): Documented.GroupOptions => options;

// Both assignment directions keep the grouped client and its native middleware requirements.
httpClient satisfies typeof Testing.httpClient;

Testing.httpClient satisfies typeof httpClient;

// Structural assignability does not reject optional extra properties, so check
// the no-hook invariant independently on the public API and its documented copy.
export const remoteOptionsHaveNoHook: "before" extends keyof ActionCliClient.Options<string>
  ? true
  : false = false;

export const documentedOptionsHaveNoHook: "before" extends keyof Documented.Options<string>
  ? true
  : false = false;
