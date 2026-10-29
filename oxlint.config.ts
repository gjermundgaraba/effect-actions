import { config } from "@clanker-stuff/oxlint-config";

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

const lintingProbes = process.env["LINT_PROBE"] !== undefined;

const lint = config({
  env: { browser: false },
  testBlocks: ["it.effect", "it.effect.prop", "it.live", "it.prop"],
  expectBlocks: ["it.effect.each"],
  assertFunctions: [
    "runScenario",
    "untilDelivering",
    "untilKept",
    "untilPosted",
  ],
  ignorePatterns: [
    "packages/cloudflare/examples/chat-rooms/src/env.d.ts",
    ...(lintingProbes ? [] : ["tools/oxlint/tests/probe-*/**"]),
  ],
  overrides: [
    { env: { browser: true }, files: ["**/src/browser.ts"] },
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
    {
      files: [
        "packages/cloudflare/src/durable/ActionDurableObject.ts",
        "src/authentication/provider.ts",
        "src/cli/commands.ts",
      ],
      rules: { "typescript/method-signature-style": "off" },
    },
    {
      files: ["src/contract/implementation.ts"],
      rules: { "typescript/method-signature-style": "off" },
    },
    {
      files: ["src/cli/commands.ts"],
      rules: { "typescript/no-invalid-void-type": "off" },
    },
    {
      files: [
        "tests/guarantees/types.test-d.ts",
        "tests/http/stream-types.test-d.ts",
      ],
      rules: { "typescript/no-invalid-void-type": "off" },
    },
    {
      files: ["src/cli/commands.ts", "src/contract/reported.ts"],
      rules: { "unicorn/custom-error-definition": "off" },
    },
    {
      files: ["src/contract/Action.ts"],
      rules: { "typescript/consistent-type-definitions": "off" },
    },
    {
      files: ["src/contract/{Action,authorizer}.ts", "src/webhook/Webhook.ts"],
      rules: { "unicorn/prefer-type-error": "off" },
    },
    {
      files: ["src/contract/errors.ts"],
      rules: { "require-unicode-regexp": "off" },
    },
    {
      files: ["src/contract/{push,subscribe}.ts"],
      rules: { "typescript/no-unnecessary-type-parameters": "off" },
    },
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
    {
      files: [
        "src/cli/ActionCli.ts",
        "src/http/streamed.ts",
        "src/rpc/ActionRpc.ts",
      ],
      rules: { "effecttsgo/unsafe-effect-type-assertion": "off" },
    },
    {
      files: ["src/contract/webhooks.ts"],
      rules: { "effecttsgo/leaking-requirements": "off" },
    },
    {
      files: ["packages/cloudflare/src/durable/ActionDurableObject.ts"],
      rules: { "effecttsgo/run-effect-inside-effect": "off" },
    },
    {
      files: [
        "packages/cloudflare/examples/chat-rooms/src/rooms-entrypoint.ts",
      ],
      rules: { "class-methods-use-this": "off" },
    },
    {
      files: [
        "examples/live-rpc/{src/browser,test/chat/chat.test,test/routes.test}.ts",
        "packages/cloudflare/examples/chat-rooms/{src/browser,test/worker.test}.ts",
      ],
      rules: { "unicorn/require-post-message-target-origin": "off" },
    },
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
    {
      files: ["**/*.test-d.ts"],
      rules: {
        "effecttsgo/floating-effect": "off",
        "effecttsgo/missing-effect-context": "off",
        "effecttsgo/missing-effect-error": "off",
        "effecttsgo/missing-layer-context": "off",
      },
    },
    {
      files: ["tests/mcp/stdio.test.ts"],
      rules: { "require-unicode-regexp": "off" },
    },
    {
      files: ["tests/http/api.test.ts"],
      rules: { "typescript/no-inferrable-types": "off" },
    },
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
    {
      files: ["tests/cli/cli.test.ts"],
      rules: { "anti-slop/no-shape-in-symbol-names": "off" },
    },
    {
      files: ["tests/contract/implement.test.ts"],
      rules: { "class-methods-use-this": "off" },
    },
    {
      files: ["tests/contract/client.test.ts"],
      rules: {
        "effecttsgo/schema-class-missing-brand": "off",
        "effecttsgo/schema-class-object-literal": "off",
      },
    },
    {
      files: ["tests/guarantees/types.test-d.ts"],
      rules: { "effecttsgo/effect-succeed-with-void": "off" },
    },
    {
      files: ["tests/authentication/authentication.test.ts"],
      rules: { "effecttsgo/catch-conditional-refail-to-catch-if": "off" },
    },
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
});

export default lint;
