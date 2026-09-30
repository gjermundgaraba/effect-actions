import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import * as Action from "../src/Action.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as Authentication from "../src/Authentication.js";

interface Actor {
  readonly id: string;
  readonly permissions: ReadonlyArray<string>;
}

/** DEMO ONLY: a token is an actor's name. */
const actors = new Map<string, Actor>([
  ["alice", { id: "alice", permissions: ["notes:read", "notes:write"] }],
  ["reader", { id: "reader", permissions: ["notes:read"] }],
]);

/** Provided per request: the signed-in actor, or none for a caller who has not signed in. */
export class Caller extends Context.Service<Caller, Option.Option<Actor>>()("example/Caller") {}

/** The signed-in actor. Signed out, `Unauthenticated`: the 401 an MCP client signs in on. */
export const signedIn = Effect.flatMap(
  Caller,
  Effect.fromOption(() => new Action.Unauthenticated({ message: "Sign in to use this tool." })),
);

/** The hook of every protected implementation: signed in, and allowed what the action does. */
const authorize = Effect.fn("authorize")(function* (action: Action.Any) {
  const permission = action.access === "read" ? "notes:read" : "notes:write";
  const actor = yield* signedIn;

  if (!actor.permissions.includes(permission)) {
    return yield* new Action.Forbidden({
      message: `Requires ${permission}.`,
      scopes: [permission],
    });
  }
});

// Only the credential is optional: without a token the caller is signed out, and a token
// that does not verify is still a 401. Verify a real token's audience too.
const authentication = Authentication.make(
  Caller,
  Effect.succeed(
    Effect.gen(function* () {
      const token = yield* Effect.option(Authentication.bearerToken);

      if (Option.isNone(token)) return Option.none();

      const actor = actors.get(Redacted.value(token.value));

      if (actor === undefined) {
        return yield* new Action.Unauthenticated({ message: "Unknown demo token." });
      }

      return Option.some(actor);
    }),
  ),
  {
    resource: "http://localhost:3000/mcp",
    authorizationServers: ["https://auth.example.com"],
    scopesSupported: ["notes:read", "notes:write"],
    scopesRequired: ["notes:read"],
  },
);

const Search = Action.make("search", {
  description: "Search the public notes.",
  input: { query: Schema.String },
  success: Schema.Array(Schema.String),
  access: "read",
});

const Save = Action.make("save", {
  description: "Save a note of your own.",
  input: { text: Schema.String },
  success: Schema.String,
  access: "write",
});

// Public: no rule, and no identity read, so a signed-out caller may call it.
const search = Action.implement(
  Search,
  ({ query }) => Effect.succeed([`A public note about ${query}.`]),
  Action.allowAll,
);

// Protected: the hook refuses a signed-out caller before the handler reads the actor.
const save = Action.implement(
  Save,
  ({ text }) => Effect.map(signedIn, ({ id }) => `${id} saved: ${text}`),
  authorize,
);

// One URL for both: listing and `search` answer anyone; `save` answers a signed-out caller
// with the 401 an MCP client signs in on, and a reader with the 403 it steps up on.
export const layer = ActionMcp.layerHttp([search, save], { name: "notes", version: "1.0.0" }).pipe(
  Layer.provide(authentication.layer),
);
