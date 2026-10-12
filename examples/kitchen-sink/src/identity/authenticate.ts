import { Array, Effect, Option, type Redacted } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { publicUrl } from "../config.js";
import { WorkspaceRegistry } from "../workspaces/registry.js";
import { Tenant } from "../workspaces/tenant.js";
import { Directory } from "./directory.js";
import { Login, type Member, scopes, Session } from "./Identity.js";

// What both verifiers check once a credential has named a member: an operator may have
// suspended the workspace. Checked here, it holds on every remote surface.
const inService = Effect.gen(function* () {
  const registry = yield* WorkspaceRegistry;

  return Effect.fn("inService")(function* (member: Member) {
    const suspended = yield* registry.get(member.workspace).pipe(
      Effect.map((workspace) => workspace.suspended),
      Effect.orElseSucceed(() => true),
    );

    // No scopes named: signing in again grants nothing, so this is a plain 403, never a
    // challenge sending an OAuth client back to its authorization server.
    if (suspended) return yield* new Action.Forbidden({ message: "This workspace is suspended." });

    return member;
  });
});

// As an OAuth protected resource the provider publishes discovery (RFC 9728) and names it in
// every challenge, so an MCP client that gets a 401 finds where to sign in, asking for the read
// scope first. The resource is the public URL, known only to the deployment: an Effect, read
// when the provider is built.
const protectedResource = Effect.map(
  publicUrl,
  (url) =>
    ({
      resource: `${url}/mcp`,
      // DEMO ONLY: no server is there. Yours is your authorization server's issuer.
      authorizationServers: ["https://auth.example.com"],
      scopesSupported: [scopes.read, scopes.write],
      scopesRequired: [scopes.read],
      resourceName: "Tracker",
    }) satisfies Authentication.ProtectedResource,
);

// Server only: `Login`'s provider. The Effect is a builder, as `Action.implement` takes one:
// it yields the startup services once, and returns the verifier, which runs per request and
// may read request services, here the `Tenant` router middleware provides.
export const authenticateBearer = Authentication.layer(
  Login,
  Effect.gen(function* () {
    const directory = yield* Directory;
    const admit = yield* inService;

    return (token: Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        const memberships = yield* directory.ofToken(token);

        const member = Option.flatMap(yield* Tenant, (slug) =>
          Array.findFirst(memberships, ({ workspace }) => workspace === slug),
        );

        if (Option.isNone(member)) {
          return yield* new Action.Forbidden({
            message: "Name a workspace you belong to in the X-Workspace header.",
          });
        }

        return yield* admit(member.value);
      });
  }),
  { protectedResource },
);

// `Session`'s provider: the same identity from another credential. Its verifier receives what
// its scheme decodes, the cookie's value. A session belongs to one workspace, so it reads no
// `Tenant`, and under a scheme other than Bearer there is no discovery and no step-up.
export const authenticateSession = Authentication.layer(
  Session,
  Effect.gen(function* () {
    const directory = yield* Directory;
    const admit = yield* inService;

    return (session: Redacted.Redacted<string>) =>
      Effect.flatMap(directory.ofSession(session), admit);
  }),
);
