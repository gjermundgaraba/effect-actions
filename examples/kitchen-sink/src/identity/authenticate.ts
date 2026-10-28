import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Array, Effect, Option } from "effect";
import type { Redacted } from "effect";

import { publicUrl } from "../config.js";
import { WorkspaceRegistry } from "../workspaces/registry.js";
import { Tenant } from "../workspaces/tenant.js";
import { Directory } from "./directory.js";
import { Login, scopes, Session } from "./Identity.js";
import type { Member } from "./Identity.js";

const inService = Effect.gen(function* () {
  const registry = yield* WorkspaceRegistry;

  return Effect.fn("inService")(function* (member: Member) {
    const suspended = yield* registry.get(member.workspace).pipe(
      Effect.map((workspace) => workspace.suspended),
      Effect.orElseSucceed(() => true)
    );

    if (suspended) {
      return yield* new Action.Forbidden({
        message: "This workspace is suspended.",
      });
    }

    return member;
  });
});

const demoAuthorizationServer = "https://auth.example.com";

const protectedResource = Effect.map(
  publicUrl,
  (url) =>
    ({
      resource: `${url}/mcp`,
      authorizationServers: [demoAuthorizationServer],
      scopesSupported: [scopes.read, scopes.write],
      scopesRequired: [scopes.read],
      resourceName: "Tracker",
    }) satisfies Authentication.ProtectedResource
);

export const authenticateBearer = Authentication.layer(
  Login,
  Effect.gen(function* () {
    const directory = yield* Directory;
    const admit = yield* inService;

    return (token: Redacted.Redacted) =>
      Effect.gen(function* () {
        const memberships = yield* directory.ofToken(token);

        const member = Option.flatMap(yield* Tenant, (slug) =>
          Array.findFirst(memberships, ({ workspace }) => workspace === slug)
        );

        if (Option.isNone(member)) {
          return yield* new Action.Forbidden({
            message:
              "Name a workspace you belong to in the X-Workspace header.",
          });
        }

        return yield* admit(member.value);
      });
  }),
  { protectedResource }
);

export const authenticateSession = Authentication.layer(
  Session,
  Effect.gen(function* () {
    const directory = yield* Directory;
    const admit = yield* inService;

    return (session: Redacted.Redacted) =>
      Effect.flatMap(directory.ofSession(session), admit);
  })
);
