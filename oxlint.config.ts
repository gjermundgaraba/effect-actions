import { recommended as effect } from "@effect/tsgo/oxlint-presets";
import type { DummyRuleMap, OxlintConfig, OxlintOverride } from "oxlint";
import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

// The shared Ultracite exceptions. Every Effect/Vite+ repository carries this block verbatim, so
// a grep finds every copy; only the test-block and assertion-function name lists vary. Each rule
// here conflicts with an Effect idiom or with a contract the code must keep. Changing the block
// needs maintainer approval, and changes every copy.
// The files Ultracite's vitest preset treats as tests, so its rules and these relaxations agree.
const testFiles = [
  "**/*.{test,spec,test-d,spec-d}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
  "**/__tests__/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
];

const sharedRules: DummyRuleMap = {
  // Key order carries meaning: wire formats, hashes, CLI flags, tool schemas, UI order.
  "sort-keys": "off",
  // A module holds several tagged errors or services, which are classes.
  "max-classes-per-file": "off",
  // A loop awaits in order where order, back-pressure or one-at-a-time I/O matters.
  "no-await-in-loop": "off",
  // With `promise-function-async`, it forces `await Promise.resolve(x)` into thin async wrappers.
  "require-await": "off",
  // `return yield*` in a generator reads as an inconsistent return.
  "typescript/consistent-return": "off",
  // A module may call a function or class declared further down, and types are hoisted; a
  // value used before its declaration is still an error.
  "no-use-before-define": [
    "error",
    { classes: false, functions: false, ignoreTypeReferences: true },
  ],
  // Metrics, not defects: splitting to satisfy them scatters one decision across helpers.
  complexity: "off",
  "max-nested-callbacks": "off",
  // Hashes, file modes and binary formats are bitwise by nature.
  "no-bitwise": "off",
  // Effect modules are PascalCase (`Schema.ts`); everything else is kebab-case.
  "unicorn/filename-case": [
    "error",
    { cases: { kebabCase: true, pascalCase: true } },
  ],
  // Optional DTO fields belong in their construction expression.
  "anti-slop/no-conditional-empty-object-spread": "off",
  // Generators passed to Effect.gen and Effect.fn are named by their span, not the function.
  "func-names": ["error", "as-needed", { generators: "never" }],
  // A schema and its type share a name; tsc rejects real redeclarations.
  "no-redeclare": "off",
  // `Effect.catch` is not a promise chain.
  "promise/prefer-await-to-then": "off",
  // Effect handlers are typed functions, not error-first callbacks: the rule flags every
  // `Effect.catch((error) => ...)`, the name `unicorn/catch-error-name` demands.
  "promise/prefer-await-to-callbacks": "off",
  // `readonly string[]`, but `ReadonlyArray<Html | string>` over `readonly (Html | string)[]`.
  "typescript/array-type": [
    "error",
    { default: "array-simple", readonly: "array-simple" },
  ],
  // Effect's data-first `map(self, f)` and `filter(self, f)` take no thisArg.
  "unicorn/no-array-method-this-argument": "off",
  // Effect APIs take `undefined` as a value, as in `Deferred.succeed(done, undefined)`.
  "unicorn/no-useless-undefined": ["error", { checkArguments: false }],
  // `Schema.TaggedError<X>()` builds an error class; it throws nothing.
  "unicorn/throw-new-error": "off",
  // Notices for every unstable Effect API bury the warnings that matter.
  "effecttsgo/unstable-api-usage": "off",
};

const sharedTestOverride: OxlintOverride = {
  files: testFiles,
  // Naming the plugin lets the override reach its rules.
  plugins: ["vitest"],
  rules: {
    // `@effect/vitest`'s test functions are test blocks, and the repository's assertion helpers
    // (Foldkit's `scene`/`story` among them, where used) assert. List the names the repository uses.
    "vitest/no-standalone-expect": [
      "error",
      {
        additionalTestBlockFunctions: [
          "it.effect",
          "it.effect.each",
          "it.effect.prop",
          "it.live",
          "it.prop",
        ],
      },
    ],
    "vitest/expect-expect": [
      "error",
      {
        additionalTestBlockFunctions: [
          "it.effect",
          "it.effect.prop",
          "it.live",
          "it.prop",
        ],
        assertFunctionNames: [
          "expect",
          "expectTypeOf",
          "assert",
          "assert.*",
          "runScenario",
          "untilDelivering",
          "untilKept",
          "untilPosted",
        ],
      },
    ],
    // An `Effect.fn` export's runtime name is empty, so `describe(fn)` reports `<anonymous>`; the
    // rule also takes namespace imports for functions. Titles are strings.
    "vitest/prefer-describe-function-title": "off",
    // A test writes `find(...)!` for what it asserts exists.
    "typescript/no-non-null-assertion": "off",
    // Each value gets its own `expect`, with a message where the value alone would not explain a failure.
    "vitest/max-expects": "off",
    "vitest/valid-expect": ["error", { maxArgs: 2 }],
    // `toBe(true)` asserts a boolean; `toBeTruthy()` accepts any truthy value.
    "vitest/prefer-to-be-truthy": "off",
    "vitest/prefer-to-be-falsy": "off",
    // Tests feed hostile and literal input on purpose.
    "no-script-url": "off",
    "no-template-curly-in-string": "off",
    // Replaces Ultracite's `no-module-mocking`, which misses `vi` from `vite-plus/test`.
    "vitest/no-restricted-vi-methods": [
      "error",
      {
        doMock:
          "Replace dependencies through Layers or real interfaces, not module mocks.",
        mock: "Replace dependencies through Layers or real interfaces, not module mocks.",
      },
    ],
  },
};

const sourceOrLintProbe = (glob: string) => [
  `src/${glob}`,
  `tools/oxlint/tests/probe-*/*/src/${glob}`,
];

const packageNameImport = {
  message: "Source imports source by relative path.",
  regex: "^@gjermundgaraba/effect-actions",
};

const anyRelativeImport = ["./**", "../**"];

const sharedPrivateFiles = [
  "authentication/provider.js",
  "authentication/refusal.js",
  "stdio/console.js",
];

export default defineConfig<OxlintConfig>({
  // Core's `browser: true` would admit browser globals everywhere; only the browser entry points
  // below run in one.
  env: { browser: false, node: true },
  extends: [core, antiSlop, vitest, effect],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    // `wrangler types` writes it.
    "packages/cloudflare/examples/chat-rooms/src/env.d.ts",
    // The import-fence test lints probes it writes here, which a run of the repository leaves out.
    ...(process.env["LINT_PROBE"] === undefined
      ? ["tools/oxlint/tests/probe-*/**"]
      : []),
  ],
  options: {
    denyWarnings: true,
    reportUnusedDisableDirectives: "deny",
    typeAware: true,
    typeCheck: true,
  },
  overrides: [
    sharedTestOverride,
    { env: { browser: true }, files: ["**/src/browser.ts"] },
    // Each exception below is (2) a published contract the fix would break, or (1) a rule
    // misreading correct code; the reason says which and how.
    //
    // (2) `{}` is Effect CLI's own "no input" in the returned `Command.Command<Name, {}, ...>` and
    // the "no options given" default of these exported generics, in the emitted declarations.
    {
      files: [
        "src/authentication/Authentication.ts",
        "src/cli/{ActionCli,commands}.ts",
        "src/contract/{Action,call,implementation,watch}.ts",
        "src/http/{ActionHttp,client}.ts",
        "src/mcp/{ActionMcp,client}.ts",
        "src/rpc/ActionRpc.ts",
        "src/toolkit/ActionToolkit.ts",
      ],
      rules: {
        "typescript/ban-types": "off",
        "typescript/no-empty-object-type": "off",
      },
    },
    // (2) Consumers implement these published methods, or pass `render`; as properties, their
    // parameters would be checked contravariantly and narrower implementations stop compiling.
    {
      files: [
        "packages/cloudflare/src/durable/ActionDurableObject.ts",
        "src/authentication/provider.ts",
        "src/cli/commands.ts",
      ],
      rules: { "typescript/method-signature-style": "off" },
    },
    // (1) At this erasure point the method form is the existential: each consumer's handler, typed
    // by its own contract's input, is stored as one erased function and matched to its contract at
    // runtime. A property type rejects them (TS2394), and a sound one needs an unchecked assertion.
    {
      files: ["src/contract/implementation.ts"],
      rules: { "typescript/method-signature-style": "off" },
    },
    // (2) The published `render(this: void, ...)` says Effect CLI calls it without a receiver.
    {
      files: ["src/cli/commands.ts"],
      rules: { "typescript/no-invalid-void-type": "off" },
    },
    // (2) A contract without `success` answers `Schema.Void`, whose type is `void`; these pins
    // state the published success type, which `undefined` is not equal to.
    {
      files: [
        "tests/guarantees/types.test-d.ts",
        "tests/http/stream-types.test-d.ts",
      ],
      rules: { "typescript/no-invalid-void-type": "off" },
    },
    // (2) The fix sets `name`: Effect CLI prints `UserError` by its name, and a concealed defect
    // reaches clients as an `Error` named "Error".
    {
      files: ["src/cli/commands.ts", "src/contract/reported.ts"],
      rules: { "unicorn/custom-error-definition": "off" },
    },
    // (1) The rule takes an interface for an equal of `NoHandler`'s object type, but an interface
    // has no implicit index signature, so it no longer fits `Built`'s record type and `implement`'s
    // overloads stop matching its implementation (TS2394).
    {
      files: ["src/contract/Action.ts"],
      rules: { "typescript/consistent-type-definitions": "off" },
    },
    // (1) A failure described for printing can be any value Effect fails with: `unknown` is its
    // precise type, where the rule assumes a narrower one exists.
    {
      files: ["src/cli/commands.ts"],
      rules: { "anti-slop/no-unknown-parameters": "off" },
    },
    // (2) These published functions throw `Error`; `TypeError` changes the class consumers see.
    {
      files: ["src/contract/{Action,authorizer}.ts", "src/webhook/Webhook.ts"],
      rules: { "unicorn/prefer-type-error": "off" },
    },
    // (2) With a `u` flag, Effect exports `scopeToken` as a `pattern` in the published JSON Schema
    // of `Forbidden.scopes`, in every 403 and MCP error schema.
    {
      files: ["src/contract/errors.ts"],
      rules: { "require-unicode-regexp": "off" },
    },
    // (1) `E` appears once, but `event.input`'s type, and so the inferred request schema, depends
    // on it; without it the input is `Event.Any`'s erased one.
    {
      files: ["src/contract/{push,subscribe}.ts"],
      rules: { "typescript/no-unnecessary-type-parameters": "off" },
    },
    // (2) `Webhook.layer` publishes Effect's experimental `Dns.Dns` as its requirement, so the
    // library resolves through it and every application and test serving webhooks provides it.
    {
      files: [
        "src/webhook/{address,subscriptions,Webhook}.ts",
        "examples/{build-events,kitchen-sink}/src/server.ts",
        "examples/build-events/test/support/memory.ts",
        "examples/kitchen-sink/test/support/services.ts",
        "tests/support/webhook.ts",
        "tests/webhook/{delivery,mcp,persist}.test.ts",
        "tests/webhook/webhook-types.test-d.ts",
      ],
      rules: { "effecttsgo/experimental-api-usage": "off" },
    },
    // (1) At these sites `unknown` is the existential of a heterogeneous registry (`Action.Any`,
    // `AnyImplementation`, erased feeds and handlers, the caller key), TypeScript's only encoding of
    // "this contract's own channel", not a lost type; each published signature restores it.
    {
      files: [
        "packages/cloudflare/src/durable/{ActionDurableObject,stub}.ts",
        "src/authentication/Authentication.ts",
        "src/cli/{ActionCli,commands}.ts",
        "src/contract/{Action,authorizer,call,caller,feed,idempotency,implementation,lease,push,serving,webhooks}.ts",
        "src/http/{ActionHttp,client,events,placed,streamed,watch}.ts",
        "src/mcp/{ActionMcp,bridge,client,reply,watch}.ts",
        "src/rpc/ActionRpc.ts",
        "src/testing/Testing.ts",
        "src/toolkit/ActionToolkit.ts",
        "src/webhook/subscriptions.ts",
      ],
      rules: { "effecttsgo/any-unknown-in-error-context": "off" },
    },
    // (2) These pins state the published type for erased input, `unknown` in its channels.
    // (1) The rest are values refused under `@ts-expect-error`, typed as the checker's error type;
    // and in `mcp/events.test.ts` the plugin reads as `any` an error tsc types as `WatchError<...>`.
    {
      files: [
        "tests/cli/cli-types.test-d.ts",
        "tests/contract/{client-types,contract-types}.test-d.ts",
        "tests/contract/client.test.ts",
        "tests/guarantees/types.test-d.ts",
        "tests/mcp/events.test.ts",
        "tests/mcp/mcp-types.test-d.ts",
        "tests/rpc/rpc-types.test-d.ts",
        "tests/rpc/rpc.test.ts",
      ],
      rules: { "effecttsgo/any-unknown-in-error-context": "off" },
    },
    // (1) The promise plugin reads Effect as promises: `no-promise-in-callback` takes a function
    // whose parameter is named `error` for a Node callback and the Effect it returns for a promise,
    // and `valid-params` counts `Effect.catch(self, f)`'s two arguments against `Promise#catch`'s one.
    {
      files: ["src/cli/commands.ts"],
      rules: { "promise/no-promise-in-callback": "off" },
    },
    {
      files: [
        "src/webhook/subscriptions.ts",
        "tests/authentication/authentication.test.ts",
      ],
      rules: { "promise/valid-params": "off" },
    },
    // (1) `Effect.map`, `Sink.forEach` and an action named `fill` are not arrays' methods.
    {
      files: ["packages/cloudflare/tests/durable/web-socket.model.test.ts"],
      rules: { "array-callback-return": "off" },
    },
    {
      files: ["tests/http/placed.test.ts"],
      rules: { "unicorn/no-array-fill-with-reference-type": "off" },
    },
    {
      files: [
        "tests/mcp/{events,stdio}.test.ts",
        "tests/support/stdio-host.ts",
      ],
      rules: { "unicorn/no-array-for-each": "off" },
    },
    // (1) Each is an assertion at an erased boundary whose invariant its
    // `no-unsafe-type-assertion -- SAFETY:` directive states; this rule reports the same assertion
    // a second time.
    {
      files: [
        "src/cli/ActionCli.ts",
        "src/http/streamed.ts",
        "src/rpc/ActionRpc.ts",
      ],
      rules: { "effecttsgo/unsafe-effect-type-assertion": "off" },
    },
    // (1) The requirement is the subscriber's request context, which `subscribe` runs in; resolving
    // it when the Layer is built would provide request identity at startup.
    {
      files: ["src/contract/webhooks.ts"],
      rules: { "effecttsgo/leaking-requirements": "off" },
    },
    // (1) The `Effect.runPromise` is in a handler returned to the runtime and run per request,
    // after the build Effect it is written in has finished.
    {
      files: ["packages/cloudflare/src/durable/ActionDurableObject.ts"],
      rules: { "effecttsgo/run-effect-inside-effect": "off" },
    },
    // (1) A service binding calls `latestAt` on the `WorkerEntrypoint` instance; a static method
    // or a function would not be callable.
    {
      files: [
        "packages/cloudflare/examples/chat-rooms/src/rooms-entrypoint.ts",
      ],
      rules: { "class-methods-use-this": "off" },
    },
    // (1) `client.postMessage(...)` is the examples' chat action over Effect RPC, not
    // `window.postMessage`.
    {
      files: [
        "examples/live-rpc/{src/browser,test/chat/chat.test,test/routes.test}.ts",
        "packages/cloudflare/examples/chat-rooms/{src/browser,test/worker.test}.ts",
      ],
      rules: { "unicorn/require-post-message-target-origin": "off" },
    },
    // (1) Each reports the compile error the line's `@ts-expect-error` asserts: the refused value
    // is the test's subject. Which pin it lands on varies between runs.
    {
      files: [
        "packages/cloudflare/scripts/package-consumer/worker.ts",
        "scripts/package-consumer/index.ts",
        "tests/contract/{client,event,input-check,tracing}.test.ts",
        "tests/guarantees/builds.model.test.ts",
        "tests/toolkit/toolkit.test.ts",
      ],
      rules: { "effecttsgo/missing-effect-context": "off" },
    },
    {
      files: [
        "packages/cloudflare/scripts/package-consumer/worker.ts",
        "scripts/package-consumer/index.ts",
        "tests/authentication/authentication.test.ts",
        "tests/contract/client.test.ts",
      ],
      rules: { "effecttsgo/missing-effect-error": "off" },
    },
    {
      files: [
        "packages/cloudflare/scripts/package-consumer/worker.ts",
        "tests/authentication/authentication.test.ts",
      ],
      rules: { "effecttsgo/missing-layer-context": "off" },
    },
    // (1) Type pins are type-checked and never run, so nothing floats; a negative pin's refused
    // value is a bare statement under `@ts-expect-error`, whose error the `missing-*` diagnostics
    // repeat.
    {
      files: ["**/*.test-d.ts"],
      rules: {
        "effecttsgo/floating-effect": "off",
        "effecttsgo/missing-effect-context": "off",
        "effecttsgo/missing-effect-error": "off",
        "effecttsgo/missing-layer-context": "off",
      },
    },
    // (2) The case pins the published MCP tool schema for a pattern without `u`, which it leaves
    // out of the listing.
    {
      files: ["tests/mcp/stdio.test.ts"],
      rules: { "require-unicode-regexp": "off" },
    },
    // (1) On a `const`, `: string` is not inferrable: it widens `"api"`, which is the case's subject.
    {
      files: ["tests/http/api.test.ts"],
      rules: { "typescript/no-inferrable-types": "off" },
    },
    // (1) `CliOutput.defaultFormatter()` returns a plain object literal, which its spread copies
    // whole. And the rule assumes non-finite numbers are unintended; these cases feed
    // `--scale Infinity`, and NaN or the infinities to the console.
    {
      files: ["tests/cli/cli.test.ts"],
      rules: {
        "effecttsgo/schema-number": "off",
        "typescript/no-misused-spread": "off",
      },
    },
    {
      files: ["tests/stdio/console.model.test.ts"],
      rules: { "effecttsgo/schema-number": "off" },
    },
    // (1) `Shape` is a geometric shape, a circle or a square, and its handler's key is the action's
    // name, "shape": a domain noun, not a type named for its structure.
    {
      files: ["tests/cli/cli.test.ts"],
      rules: { "anti-slop/no-shape-in-symbol-names": "off" },
    },
    // (1) The fixture's subject is a handler on the prototype, which the case refuses.
    {
      files: ["tests/contract/implement.test.ts"],
      rules: { "class-methods-use-this": "off" },
    },
    // (2) The case shows the published client's documented trap: a consumer's unbranded
    // `Schema.Class` lets a plain object compile, which is then refused at runtime.
    {
      files: ["tests/contract/client.test.ts"],
      rules: {
        "effecttsgo/schema-class-missing-brand": "off",
        "effecttsgo/schema-class-object-literal": "off",
      },
    },
    // (2) Pins that the published `Action.implement` accepts a void action's handler written
    // `Effect.succeed(undefined)`, beside `Effect.void`.
    {
      files: ["tests/guarantees/types.test-d.ts"],
      rules: { "effecttsgo/effect-succeed-with-void": "off" },
    },
    // (1) The suggested `catchIf` is not equivalent here: `HttpRouter.middleware<{ handles: Gone }>`
    // rejects it (TS2769).
    {
      files: ["tests/authentication/authentication.test.ts"],
      rules: { "effecttsgo/catch-conditional-refail-to-catch-if": "off" },
    },
    // A domain reaches another through its public module; the contract imports no other domain.
    {
      files: sourceOrLintProbe("**"),
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              packageNameImport,
              {
                caseSensitive: true,
                group: [
                  ...anyRelativeImport,
                  "!./*.js",
                  "!../[a-z]*/[A-Z]*.js",
                  "!../contract/*.js",
                  ...sharedPrivateFiles.map((file) => `!../${file}`),
                ],
                message: `A relative import is ./<file>.js, another domain's public ../<domain>/<Module>.js, the contract's, or a shared private file: ${sharedPrivateFiles.join(", ")}.`,
              },
            ],
          },
        ],
      },
    },
    {
      files: sourceOrLintProbe("contract/**"),
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              packageNameImport,
              {
                group: [...anyRelativeImport, "!./*.js"],
                message:
                  "src/contract imports nothing outside itself: ./<file>.js alone.",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["packages/*/src/**"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                caseSensitive: true,
                group: [
                  ...anyRelativeImport,
                  "!./*.js",
                  "!../[a-z]*/[A-Z]*.js",
                ],
                message:
                  "A relative import is ./<file>.js or another domain's public ../<domain>/<Module>.js; the core is imported by its package name.",
              },
            ],
          },
        ],
      },
    },
  ],
  rules: {
    ...sharedRules,
  },
});
