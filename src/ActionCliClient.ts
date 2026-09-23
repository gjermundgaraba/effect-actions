import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { HttpClient } from "effect/unstable/http";
import { HttpApi, HttpApiClient } from "effect/unstable/httpapi";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import type * as Action from "./Action.js";
import type * as ActionHttp from "./ActionHttp.js";
import { command as makeCommand, type Options as CliOptions } from "./internal/cli.js";
import { type Actions, selectNamed } from "./internal/actions.js";

/**
 * What the host configures on Effect's native client: `baseUrl`, `transformClient`,
 * `transformResponse`. The selectors and the client are the command's own.
 */
export type Connection = NonNullable<globalThis.Parameters<typeof HttpApiClient.make>[1]>;

/** Parsing, rendering and native HTTP-endpoint configuration for one remote action. */
export type Options<Output, ParsedParameters extends Command.Command.Config = never> = CliOptions<
  Output,
  ParsedParameters
> & {
  readonly connection?: Connection;
};

/** Configuration for a remote aggregate group command. */
export interface GroupOptions {
  /** Override the group command name. */
  readonly name?: string;
  /** Shared native HTTP-endpoint configuration for every remote action. */
  readonly connection?: Connection;
}

type Group<Groups extends ReadonlyArray<Actions>, Name extends Groups[number]["name"]> = Extract<
  Groups[number],
  { readonly name: Name }
>;

type Selected<G extends Actions, Name extends G["actions"][number]["name"]> = Extract<
  G["actions"][number],
  { readonly name: Name }
>;

type ActionNames<G extends Actions> = G["actions"][number]["name"];

type ApiGroups<Groups extends ReadonlyArray<Actions>, Errors extends ReadonlyArray<Action.Codec>> =
  ActionHttp.Api<Groups[number], Errors[number]> extends HttpApi.HttpApi<"actions", infer ApiGroups>
    ? ApiGroups
    : never;

type Endpoint<
  Groups extends ReadonlyArray<Actions>,
  Errors extends ReadonlyArray<Action.Codec>,
  GroupName extends Groups[number]["name"],
  ActionName extends ActionNames<Group<Groups, GroupName>>,
> = Extract<
  HttpApiGroup.EndpointsWithIdentifier<
    ApiGroups<Groups, Errors>,
    Extract<GroupName, HttpApiGroup.Identifier<ApiGroups<Groups, Errors>>>
  >,
  { readonly identifier: ActionName }
>;

type NativeMethod<
  Groups extends ReadonlyArray<Actions>,
  Errors extends ReadonlyArray<Action.Codec>,
  GroupName extends Groups[number]["name"],
  ActionName extends ActionNames<Group<Groups, GroupName>>,
> = HttpApiClient.Client.Method<
  Extract<Endpoint<Groups, Errors, GroupName, ActionName>, HttpApiEndpoint.ConstraintRequest>,
  never,
  never
>;

type RemoteCommand<
  Groups extends ReadonlyArray<Actions>,
  Errors extends ReadonlyArray<Action.Codec>,
  GroupName extends Groups[number]["name"],
  ActionName extends ActionNames<Group<Groups, GroupName>>,
> = Command.Command<
  string,
  never,
  {},
  Effect.Error<ReturnType<NativeMethod<Groups, Errors, GroupName, ActionName>>>,
  | HttpClient.HttpClient
  | Effect.Services<ReturnType<NativeMethod<Groups, Errors, GroupName, ActionName>>>
>;

type RemoteGroupCommand<
  Groups extends ReadonlyArray<Actions>,
  Errors extends ReadonlyArray<Action.Codec>,
  GroupName extends Groups[number]["name"],
> = Command.Command<
  string,
  {},
  {},
  Effect.Error<
    ReturnType<NativeMethod<Groups, Errors, GroupName, ActionNames<Group<Groups, GroupName>>>>
  >,
  | HttpClient.HttpClient
  | Effect.Services<
      ReturnType<NativeMethod<Groups, Errors, GroupName, ActionNames<Group<Groups, GroupName>>>>
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

/**
 * Project one action of the binding into a native Effect CLI command.
 * Group and action selectors resolve exclusively from `http.groups`; runtime guards
 * keep dynamically supplied selector strings from reaching the native client.
 */
export const command = <
  const Groups extends ReadonlyArray<Actions>,
  const Errors extends ReadonlyArray<Action.Codec>,
  const GroupName extends Groups[number]["name"],
  const ActionName extends ActionNames<Group<Groups, GroupName>>,
  ParsedParameters extends Command.Command.Config = never,
>(
  http: ActionHttp.Http<Groups, Errors>,
  groupName: GroupName,
  actionName: ActionName,
  options?: Options<
    Selected<Group<Groups, GroupName>, ActionName>["success"]["Type"],
    ParsedParameters
  >,
): RemoteCommand<Groups, Errors, GroupName, ActionName> => {
  const group = selectNamed(http.groups, groupName, `HTTP group "${groupName}"`);
  const action = selectNamed(group.actions, actionName, `HTTP action "${groupName}.${actionName}"`);

  return makeCommand(
    action,
    (input) =>
      Effect.flatMap(HttpClient.HttpClient, (httpClient) => {
        // The selectors follow the connection, so a host's configuration cannot redirect the command.
        const native = HttpApiClient.endpoint(erasedApi(http.api), {
          ...options?.connection,
          group: groupName,
          endpoint: actionName,
          httpClient,
        });

        // SAFETY: selectors are checked against `http.groups` above and set last.
        // The erased native endpoint builder cannot preserve their conditional map.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic endpoint selector boundary.
        const endpoint = native as Effect.Effect<
          NativeMethod<Groups, Errors, GroupName, ActionName>,
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

/** Project every action of one bound group below its group namespace. */
export const group = <
  const Groups extends ReadonlyArray<Actions>,
  const Errors extends ReadonlyArray<Action.Codec>,
  const GroupName extends Groups[number]["name"],
>(
  http: ActionHttp.Http<Groups, Errors>,
  groupName: GroupName,
  options?: GroupOptions,
): RemoteGroupCommand<Groups, Errors, GroupName> => {
  const actions = selectNamed(http.groups, groupName, `HTTP group "${groupName}"`);

  const commands = actions.actions.map((action) =>
    options?.connection === undefined
      ? command(http, groupName, action.name)
      : command(http, groupName, action.name, { connection: options.connection }),
  );

  return Command.make(options?.name ?? actions.name).pipe(Command.withSubcommands(commands));
};
