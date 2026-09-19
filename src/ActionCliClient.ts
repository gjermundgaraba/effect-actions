import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { HttpClient } from "effect/unstable/http";
import { HttpApi, HttpApiClient } from "effect/unstable/httpapi";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import type * as ActionHttp from "./ActionHttp.js";
import { command as makeCommand, type Options as CliOptions } from "./internal/cli.js";
import type { Actions } from "./internal/actions.js";

/** Parsing, rendering and native HTTP-endpoint configuration for one remote action. */
export type Options<Output, ParsedParameters extends Command.Command.Config = never> = CliOptions<
  Output,
  ParsedParameters
> & {
  /** Passed directly to Effect's native `HttpApiClient.endpoint`. */
  readonly connection?: NonNullable<globalThis.Parameters<typeof HttpApiClient.make>[1]>;
};

/** Configuration for a remote aggregate group command. */
export interface GroupOptions {
  /** Override the group command name. */
  readonly name?: string;
  /** Shared native HTTP-endpoint configuration for every remote action. */
  readonly connection?: NonNullable<globalThis.Parameters<typeof HttpApiClient.make>[1]>;
}

type Group<Groups extends ReadonlyArray<Actions>, Name extends Groups[number]["name"]> = Extract<
  Groups[number],
  { readonly name: Name }
>;

type Selected<G extends Actions, Name extends G["actions"][number]["name"]> = Extract<
  G["actions"][number],
  { readonly name: Name }
>;

type HttpNames<G extends Actions> = Extract<G["actions"][number], { readonly http: true }>["name"];

type ApiGroups<Groups extends ReadonlyArray<Actions>> =
  ActionHttp.Api<Groups[number]> extends HttpApi.HttpApi<"actions", infer ApiGroups>
    ? ApiGroups
    : never;

type Endpoint<
  Groups extends ReadonlyArray<Actions>,
  GroupName extends Groups[number]["name"],
  ActionName extends HttpNames<Group<Groups, GroupName>>,
> = Extract<
  HttpApiGroup.EndpointsWithIdentifier<
    ApiGroups<Groups>,
    Extract<GroupName, HttpApiGroup.Identifier<ApiGroups<Groups>>>
  >,
  { readonly identifier: ActionName }
>;

type NativeMethod<
  Groups extends ReadonlyArray<Actions>,
  GroupName extends Groups[number]["name"],
  ActionName extends HttpNames<Group<Groups, GroupName>>,
> = HttpApiClient.Client.Method<
  Extract<Endpoint<Groups, GroupName, ActionName>, HttpApiEndpoint.ConstraintRequest>,
  never,
  never
>;

type RemoteCommand<
  Groups extends ReadonlyArray<Actions>,
  GroupName extends Groups[number]["name"],
  ActionName extends HttpNames<Group<Groups, GroupName>>,
> = Command.Command<
  string,
  never,
  {},
  Effect.Error<ReturnType<NativeMethod<Groups, GroupName, ActionName>>>,
  HttpClient.HttpClient | Effect.Services<ReturnType<NativeMethod<Groups, GroupName, ActionName>>>
>;

type RemoteGroupCommand<
  Groups extends ReadonlyArray<Actions>,
  GroupName extends Groups[number]["name"],
> = Command.Command<
  string,
  {},
  {},
  Effect.Error<ReturnType<NativeMethod<Groups, GroupName, HttpNames<Group<Groups, GroupName>>>>>,
  | HttpClient.HttpClient
  | Effect.Services<
      ReturnType<NativeMethod<Groups, GroupName, HttpNames<Group<Groups, GroupName>>>>
    >
>;

/**
 * The native endpoint builder needs string selectors for a runtime-selected route.
 * `http.groups` is checked before this widening, and `NativeMethod` restores the
 * corresponding precise endpoint type at that one dynamic client boundary.
 */
const erasedApi = (api: HttpApi.Constraint): HttpApi.Top => {
  // SAFETY: every binding API is a native HttpApi; only its static map is widened here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic endpoint selector boundary.
  return api as HttpApi.Top;
};

const selectGroup = <Groups extends ReadonlyArray<Actions>, Name extends Groups[number]["name"]>(
  groups: Groups,
  name: Name,
): Group<Groups, Name> => {
  const group = groups.find(
    (candidate): candidate is Group<Groups, Name> => candidate.name === name,
  );

  if (group === undefined) throw new Error(`Unknown HTTP group "${name}"`);

  return group;
};

const selectAction = <G extends Actions, Name extends G["actions"][number]["name"]>(
  group: G,
  name: Name,
): Selected<G, Name> => {
  const action = group.actions.find(
    (candidate): candidate is Selected<G, Name> => candidate.name === name,
  );

  if (action === undefined || !action.http) {
    throw new Error(`Unknown HTTP action "${group.name}.${name}"`);
  }

  return action;
};

/**
 * Project one HTTP action retained by the binding into a native Effect CLI command.
 * Group and action selectors resolve exclusively from `http.groups`; runtime guards
 * keep dynamically supplied selector strings from reaching the native client.
 */
export const command = <
  const Groups extends ReadonlyArray<Actions>,
  const GroupName extends Groups[number]["name"],
  const ActionName extends HttpNames<Group<Groups, GroupName>>,
  ParsedParameters extends Command.Command.Config = never,
>(
  http: ActionHttp.Http<Groups>,
  groupName: GroupName,
  actionName: ActionName,
  options?: Options<
    Selected<Group<Groups, GroupName>, ActionName>["success"]["Type"],
    ParsedParameters
  >,
): RemoteCommand<Groups, GroupName, ActionName> => {
  const group = selectGroup(http.groups, groupName);
  const action = selectAction(group, actionName);

  return makeCommand(
    action,
    (input) =>
      Effect.flatMap(HttpClient.HttpClient, (httpClient) => {
        const native = HttpApiClient.endpoint(erasedApi(http.api), {
          group: groupName,
          endpoint: actionName,
          httpClient,
          ...options?.connection,
        });

        // SAFETY: selectors are checked against `http.groups` immediately above.
        // The erased native endpoint builder cannot preserve their conditional map.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic endpoint selector boundary.
        const endpoint = native as Effect.Effect<
          NativeMethod<Groups, GroupName, ActionName>,
          never,
          never
        >;

        return Effect.flatMap(endpoint, (method) => {
          // SAFETY: this action input is decoded from the exact selected action codec.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic endpoint selector boundary.
          const request = { payload: input } as globalThis.Parameters<typeof method>[0];

          return method(request);
        });
      }),
    options,
  );
};

/** Project all HTTP-enabled actions retained by one group below its group namespace. */
export const group = <
  const Groups extends ReadonlyArray<Actions>,
  const GroupName extends Groups[number]["name"],
>(
  http: ActionHttp.Http<Groups>,
  groupName: GroupName,
  options?: GroupOptions,
): RemoteGroupCommand<Groups, GroupName> => {
  const actions = selectGroup(http.groups, groupName);

  const commands = actions.actions.flatMap((action) =>
    action.http
      ? [
          options?.connection === undefined
            ? command(http, groupName, action.name)
            : command(http, groupName, action.name, { connection: options.connection }),
        ]
      : [],
  );

  return Command.make(options?.name ?? actions.name).pipe(Command.withSubcommands(commands));
};
