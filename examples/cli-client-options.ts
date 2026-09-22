import type { Schema } from "effect";
import type { Command } from "effect/unstable/cli";
import type { HttpApiClient } from "effect/unstable/httpapi";

/** Native client configuration: baseUrl, transformClient, transformResponse. */
export type Connection = NonNullable<Parameters<typeof HttpApiClient.make>[1]>;

/** Remote commands have no local `before` hook. */
export type Options<Output, ParsedParameters extends Command.Command.Config = never> = {
  readonly name?: string;
  readonly render?: (output: Output) => string;
  readonly connection?: Connection;
} & (
  | { readonly parameters?: never; readonly input?: never }
  | {
      readonly parameters: ParsedParameters;
      readonly input: (parsed: Command.Command.Config.InferValue<ParsedParameters>) => Schema.Json;
    }
);

export interface GroupOptions {
  readonly name?: string;
  readonly connection?: Connection;
}
