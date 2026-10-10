import { Buffer } from "node:buffer";
import { describe, expect, it } from "@effect/vitest";
import { Effect, ErrorReporter, Layer, Schema, SchemaGetter, Stream } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";
import { Base64 } from "effect/encoding";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import * as Testing from "../../src/testing/Testing.js";
import { mcpRequest, post, send } from "../support/requests.js";
import { converse, type HostRequest } from "../support/stdio-host.js";

const options = { name: "media", version: "0" };

const read = { description: "Reads", readOnly: true, caller: Action.Anyone } as const;

const png = new Uint8Array([137, 80, 78, 71]);

const jpeg = new Uint8Array([255, 216, 255]);

const image = { data: png, mimeType: "image/png" };

const photo = { data: jpeg, mimeType: "image/jpeg" };

const imageBlockAsSent = ({ data, mimeType }: typeof Action.Image.Type, field?: string) => ({
  type: "image",
  data: Base64.encode(data),
  mimeType,
  ...(field === undefined ? {} : { _meta: { "effect-actions/field": field } }),
});

const Screen = Schema.Struct({ id: Schema.Finite, title: Schema.String });

const screen = { id: 1, title: "Home" };

const Shot = Action.make("shot", { ...read, success: { screen: Screen, image: Action.Image } });

const JsonRpcReply = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    error: Schema.optionalKey(Schema.Json),
  }),
);

const replyOf = (line: string) => {
  const { result, error } = Schema.decodeUnknownSync(JsonRpcReply)(line);

  if (result === undefined) return { error };

  const { _meta: _sent, resultType: _type, ...rest } = result;

  return { result: rest };
};

const answersOverHttp = (requests: ReadonlyArray<HostRequest>) =>
  Effect.forEach(requests, ({ method, params = {} }) =>
    Effect.flatMap(send(mcpRequest({ method, params })), (response) => response.text),
  );

describe("MCP registration without media", () => {
  const Ready = Action.make("ready", {
    ...read,
    input: { verbose: Schema.optionalKey(Schema.Boolean) },
    success: { ready: Schema.Boolean },
    mcp: { title: "Ready", openWorldHint: true, _meta: { "io.example/ui": "panel" } },
  });

  const Named = Schema.Struct({ id: Schema.String }).annotate({ identifier: "Named" });

  const Find = Action.make("find", { ...read, input: Named, success: Named });
  const Greeting = Action.make("greeting", { ...read, success: Schema.String });
  const Count = Action.make("count", { ...read, success: Schema.Finite });
  const Reset = Action.make("reset", { ...read, readOnly: false });

  class Missing extends Schema.TaggedError<Missing>()("Missing", { id: Schema.String }) {}

  const Fail = Action.make("fail", { ...read, success: Schema.String, error: Missing });
  const Boom = Action.make("boom", { ...read, success: Schema.String });
  const Broken = Action.make("broken", { ...read, success: Schema.Finite });

  const apps = Action.implement([Ready, Find, Greeting, Count, Reset, Fail, Boom, Broken], {
    ready: () => Effect.succeed({ ready: true }),
    find: ({ id }) => Effect.succeed({ id }),
    greeting: () => Effect.succeed('say "hi"'),
    count: () => Effect.succeed(42),
    reset: () => Effect.void,
    fail: () => Effect.fail(new Missing({ id: "1" })),
    boom: () => Effect.die(new Error("secret database password")),
    broken: () => Effect.succeed(Infinity),
  });

  const tools = ActionToolkit.make(apps);

  const nativeRegistrationOfSameTools = McpServer.toolkit(
    Toolkit.make(
      ...Object.values(tools.toolkit.tools).map((tool) => tool.annotate(Tool.Strict, true)),
    ),
  ).pipe(Layer.provide(tools.layer));

  const call = (name: string, args: Schema.Json = {}): HostRequest => ({
    method: "tools/call",
    params: { name, arguments: args },
  });

  const invalidArgumentCalls = [call("ready", { invented: true }), call("find", { id: 1 })];

  const requests = [
    { method: "tools/list" },
    call("ready"),
    call("ready", { verbose: true }),
    call("find", { id: "n1" }),
    call("greeting"),
    call("count"),
    call("reset"),
    call("fail"),
    call("boom"),
    call("broken"),
    ...invalidArgumentCalls,
  ];

  it.effect("lists and answers as Effect's registerToolkit does, over HTTP", () =>
    Effect.gen(function* () {
      const reports: Array<string> = [];

      const reporter = ErrorReporter.layer([
        ErrorReporter.make(({ error }) => void reports.push(error.message)),
      ]);

      const ours = yield* answersOverHttp(requests).pipe(
        Effect.provide(Testing.layer(ActionMcp.layerHttp(apps, options))),
        Effect.provide(reporter),
      );

      const reportedDefects = reports.splice(0);

      const theirs = yield* answersOverHttp(requests).pipe(
        Effect.provide(
          Testing.layer(
            ActionMcp.layerHttp([], { ...options, features: nativeRegistrationOfSameTools }),
          ),
        ),
        Effect.provide(reporter),
      );

      expect(ours).toEqual(theirs);
      expect(reportedDefects).toEqual(reports);
      expect(reportedDefects).toHaveLength(2);

      expect(replyOf(ours[1] ?? "")).toEqual({
        result: {
          isError: false,
          structuredContent: { ready: true },
          content: [{ type: "text", text: '{"ready":true}' }],
        },
      });
      expect(replyOf(ours[7] ?? "")).toEqual({
        result: { isError: true, content: [{ type: "text", text: '{"_tag":"Missing","id":"1"}' }] },
      });
      expect(ours[8]).toContain("internal server error");
      expect(ours[8]).not.toContain("secret");
      expect(ours[10]).toContain("Invalid parameters for tool 'ready'");
    }),
  );

  it.effect.each(["2026-07-28", "2025-11-25", "2025-06-18"])(
    "lists and answers as Effect's registerToolkit does, over stdio to a %s host",
    (revision) =>
      Effect.gen(function* () {
        const ours = yield* converse(ActionMcp.runStdio(apps, options), revision, requests);

        const theirs = yield* converse(
          ActionMcp.runStdio([], { ...options, features: nativeRegistrationOfSameTools }),
          revision,
          requests,
        );

        expect(ours).toEqual(theirs);

        if (revision !== "2026-07-28") {
          expect(replyOf(ours[4] ?? "")).toEqual({
            result: { isError: false, content: [{ type: "text", text: 'say "hi"' }] },
          });
        }
      }),
  );
});

describe("media fields over MCP", () => {
  const ShotWithoutMedia = Action.make("plain", { ...read, success: { screen: Screen } });
  const MaybeWithoutMedia = Action.make("title", { ...read, success: { title: Schema.String } });
  const PagesWithoutMedia = Action.make("total", { ...read, success: { total: Schema.Finite } });

  const Maybe = Action.make("maybe", {
    ...read,
    input: { present: Schema.Boolean },
    success: { title: Schema.String, image: Schema.optional(Action.Image) },
  });

  const Pages = Action.make("pages", {
    ...read,
    success: {
      cover: Action.Image,
      total: Schema.Finite,
      pages: Schema.Array(Action.Image),
      back: Schema.optionalKey(Action.Image),
    },
  });

  const Picture = Action.make("picture", { ...read, success: Action.Image });
  const Album = Action.make("album", { ...read, success: Schema.Array(Action.Image) });

  const Pair = Action.make("pair", {
    ...read,
    success: { front: Action.Image, back: Schema.optional(Action.Image) },
  });

  const pngInNodeBuffer: Uint8Array = Buffer.from(png);

  const actions = [
    Shot,
    ShotWithoutMedia,
    MaybeWithoutMedia,
    PagesWithoutMedia,
    Maybe,
    Pages,
    Picture,
    Album,
    Pair,
  ] as const;

  const apps = Action.implement(actions, {
    shot: () => Effect.succeed({ screen, image }),
    plain: () => Effect.succeed({ screen }),
    title: () => Effect.succeed({ title: "Home" }),
    total: () => Effect.succeed({ total: 2 }),
    maybe: ({ present }) => Effect.succeed(present ? { title: "Home", image } : { title: "Home" }),
    pages: () => Effect.succeed({ cover: photo, total: 2, pages: [image, photo], back: image }),
    picture: () => Effect.succeed({ data: pngInNodeBuffer, mimeType: "image/png" }),
    album: () => Effect.succeed([photo, image]),
    pair: () => Effect.succeed({ front: image }),
  });

  const call = (name: string, args: Schema.Json = {}): HostRequest => ({
    method: "tools/call",
    params: { name, arguments: args },
  });

  const calls = [
    call("shot"),
    call("maybe", { present: true }),
    call("maybe", { present: false }),
    call("pages"),
    call("picture"),
    call("album"),
    call("pair"),
  ];

  const expectedResults = [
    {
      isError: false,
      structuredContent: { screen },
      content: [
        { type: "text", text: JSON.stringify({ screen }) },
        imageBlockAsSent(image, "image"),
      ],
    },
    {
      isError: false,
      structuredContent: { title: "Home" },
      content: [{ type: "text", text: '{"title":"Home"}' }, imageBlockAsSent(image, "image")],
    },
    {
      isError: false,
      structuredContent: { title: "Home" },
      content: [{ type: "text", text: '{"title":"Home"}' }],
    },
    {
      isError: false,
      structuredContent: { total: 2 },
      content: [
        { type: "text", text: '{"total":2}' },
        imageBlockAsSent(photo, "cover"),
        imageBlockAsSent(image, "pages"),
        imageBlockAsSent(photo, "pages"),
        imageBlockAsSent(image, "back"),
      ],
    },
    { isError: false, content: [imageBlockAsSent(image)] },
    { isError: false, content: [imageBlockAsSent(photo), imageBlockAsSent(image)] },
    { isError: false, content: [imageBlockAsSent(image, "front")] },
  ];

  const Listed = Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        tools: Schema.Array(
          Schema.Struct({ name: Schema.String, outputSchema: Schema.optionalKey(Schema.Json) }),
        ),
      }),
    }),
  );

  const outputSchemas = (line: string) =>
    Object.fromEntries(
      Schema.decodeUnknownSync(Listed)(line).result.tools.map(({ name, outputSchema }) => [
        name,
        outputSchema,
      ]),
    );

  it.effect("lifts each media field into an image block, over HTTP", () =>
    Effect.gen(function* () {
      const [listed = "", ...answered] = yield* answersOverHttp([
        { method: "tools/list" },
        ...calls,
      ]).pipe(Effect.provide(Testing.layer(ActionMcp.layerHttp(apps, options))));

      expect(answered.map(replyOf)).toEqual(expectedResults.map((result) => ({ result })));

      const schemas = outputSchemas(listed);

      expect(schemas.shot).toEqual(schemas.plain);
      expect(schemas.maybe).toEqual(schemas.title);
      expect(schemas.pages).toEqual(schemas.total);

      expect(Object.keys(schemas)).toEqual(actions.map(({ name }) => name));

      for (const name of ["picture", "album", "pair"]) expect(schemas[name]).toBeUndefined();
    }),
  );

  it.effect.each(["2026-07-28", "2025-11-25", "2025-06-18"])(
    "lifts each media field into an image block, over stdio to a %s host",
    (revision) =>
      Effect.gen(function* () {
        const [listed = "", ...answered] = yield* converse(
          ActionMcp.runStdio(apps, options),
          revision,
          [{ method: "tools/list" }, ...calls],
        );

        expect(answered.map(replyOf)).toEqual(expectedResults.map((result) => ({ result })));

        const schemas = outputSchemas(listed);

        expect(schemas.shot).toEqual(schemas.plain);

        for (const name of ["picture", "album", "pair"]) expect(schemas[name]).toBeUndefined();
      }),
  );

  it.effect("decodes each media success in Testing.mcpClient as the handler returned it", () =>
    Effect.gen(function* () {
      const client = yield* Testing.mcpClient(actions);

      expect(yield* client.shot()).toEqual({ screen, image });
      expect(yield* client.maybe({ present: true })).toEqual({ title: "Home", image });
      expect(yield* client.maybe({ present: false })).toEqual({ title: "Home" });

      expect(yield* client.pages()).toEqual({
        cover: photo,
        total: 2,
        pages: [image, photo],
        back: image,
      });

      expect(yield* client.picture()).toEqual(image);
      expect(yield* client.album()).toEqual([photo, image]);
      expect(yield* client.pair()).toEqual({ front: image });
    }).pipe(Effect.provide(Testing.layer(ActionMcp.layerHttp(apps, options)))),
  );

  class Gone extends Schema.TaggedError<Gone>()("Gone", { id: Schema.Finite }) {}

  const Lost = Action.make("lost", { ...read, success: { image: Action.Image }, error: Gone });

  it.effect("keeps a declared error of a media action unchanged", () =>
    Effect.gen(function* () {
      const [answer = ""] = yield* answersOverHttp([call("lost")]);

      expect(replyOf(answer)).toEqual({
        result: { isError: true, content: [{ type: "text", text: '{"_tag":"Gone","id":1}' }] },
      });

      const client = yield* Testing.mcpClient([Lost]);

      expect(yield* Effect.flip(client.lost())).toEqual(new Gone({ id: 1 }));
    }).pipe(
      Effect.provide(
        Testing.layer(
          ActionMcp.layerHttp(
            Action.implement(Lost, () => Effect.fail(new Gone({ id: 1 }))),
            options,
          ),
        ),
      ),
    ),
  );
});

describe("the rest of a media success", () => {
  const call = (name: string): HostRequest => ({
    method: "tools/call",
    params: { name, arguments: {} },
  });

  it.effect("keeps the success's own description, not its identifier, in its outputSchema", () =>
    Effect.gen(function* () {
      const annotations = { title: "Shot", description: "A screenshot" };

      const Described = Action.make("described", {
        ...read,
        success: Schema.Struct({ title: Schema.String, image: Action.Image }).annotate({
          ...annotations,
          identifier: "Shot",
        }),
      });

      const Titled = Action.make("titled", {
        ...read,
        success: Schema.Struct({ title: Schema.String }).annotate(annotations),
      });

      const apps = Action.implement([Described, Titled], {
        described: () => Effect.succeed({ title: "Home", image }),
        titled: () => Effect.succeed({ title: "Home" }),
      });

      const [listed = ""] = yield* answersOverHttp([{ method: "tools/list" }]).pipe(
        Effect.provide(Testing.layer(ActionMcp.layerHttp(apps, options))),
      );

      const [described, titled] = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            result: Schema.Struct({
              tools: Schema.Array(Schema.Struct({ outputSchema: Schema.Json })),
            }),
          }),
        ),
      )(listed).result.tools;

      expect(described?.outputSchema).toEqual(titled?.outputSchema);
      expect(described?.outputSchema).toMatchObject(annotations);
    }),
  );

  it.effect("lifts an optional image whose union lists `undefined` first", () =>
    Effect.gen(function* () {
      const Reversed = Action.make("reversed", {
        ...read,
        success: {
          title: Schema.String,
          image: Schema.optionalKey(Schema.Union([Schema.Undefined, Action.Image])),
        },
      });

      const [answer = ""] = yield* answersOverHttp([call("reversed")]).pipe(
        Effect.provide(
          Testing.layer(
            ActionMcp.layerHttp(
              Action.implement(Reversed, () => Effect.succeed({ title: "Home", image })),
              options,
            ),
          ),
        ),
      );

      expect(replyOf(answer)).toEqual({
        result: {
          isError: false,
          structuredContent: { title: "Home" },
          content: [{ type: "text", text: '{"title":"Home"}' }, imageBlockAsSent(image, "image")],
        },
      });
    }),
  );

  const SuspendedField = Action.make("later", {
    ...read,
    success: { title: Schema.String, image: Schema.suspend(() => Action.Image) },
  });

  const SuspendedSuccess = Action.make("deferred", {
    ...read,
    success: Schema.suspend(() => Schema.Struct({ title: Schema.String, image: Action.Image })),
  });

  const suspended = Action.implement([SuspendedField, SuspendedSuccess], {
    later: () => Effect.succeed({ title: "Home", image }),
    deferred: () => Effect.succeed({ title: "Home", image }),
  });

  it.effect("lifts a top-level image from a suspended field or success", () =>
    Effect.gen(function* () {
      const lifted = {
        result: {
          isError: false,
          structuredContent: { title: "Home" },
          content: [{ type: "text", text: '{"title":"Home"}' }, imageBlockAsSent(image, "image")],
        },
      };

      const answered = yield* answersOverHttp([call("later"), call("deferred")]);

      expect(answered.map(replyOf)).toEqual([lifted, lifted]);

      const client = yield* Testing.mcpClient([SuspendedField, SuspendedSuccess]);

      expect(yield* client.later()).toEqual({ title: "Home", image });
      expect(yield* client.deferred()).toEqual({ title: "Home", image });
    }).pipe(Effect.provide(Testing.layer(ActionMcp.layerHttp(suspended, options)))),
  );

  it.effect("encodes each field of the rest once, and never the media again", () =>
    Effect.gen(function* () {
      let encodes = 0;

      const CountingEncodes = Schema.String.pipe(
        Schema.decode({
          decode: SchemaGetter.passthrough(),
          encode: SchemaGetter.transform((value: string) => `${value}-${++encodes}`),
        }),
      );

      const IndexSignatureTakingImage = Action.make("indexed", {
        ...read,
        success: Schema.StructWithRest(
          Schema.Struct({ label: CountingEncodes, image: Action.Image }),
          [
            Schema.Record(
              Schema.String,
              Schema.Union([
                Schema.String,
                Schema.Finite,
                Schema.Struct({ data: Schema.Uint8Array, mimeType: Schema.String }),
              ]),
            ),
          ],
        ),
      });

      const [answer = ""] = yield* answersOverHttp([call("indexed")]).pipe(
        Effect.provide(
          Testing.layer(
            ActionMcp.layerHttp(
              Action.implement(IndexSignatureTakingImage, () =>
                Effect.succeed({ label: "Home", image, total: 2 }),
              ),
              options,
            ),
          ),
        ),
      );

      expect(replyOf(answer)).toEqual({
        result: {
          isError: false,
          structuredContent: { label: "Home-1", total: 2 },
          content: [
            { type: "text", text: '{"label":"Home-1","total":2}' },
            imageBlockAsSent(image, "image"),
          ],
        },
      });

      expect(encodes).toBe(1);
    }),
  );

  const Strip = Action.make("strip", { ...read, success: Schema.NonEmptyArray(Action.Image) });

  const Gallery = Action.make("gallery", {
    ...read,
    success: { total: Schema.Finite, pages: Schema.NonEmptyArray(Action.Image) },
  });

  const arrays = Action.implement([Strip, Gallery], {
    strip: () => Effect.succeed([photo, image] as const),
    gallery: () => Effect.succeed({ total: 2, pages: [image, photo] as const }),
  });

  it.effect("lifts an array of media of one kind, a non-empty one too", () =>
    Effect.gen(function* () {
      const answered = yield* answersOverHttp([call("strip"), call("gallery")]);

      expect(answered.map(replyOf)).toEqual([
        { result: { isError: false, content: [imageBlockAsSent(photo), imageBlockAsSent(image)] } },
        {
          result: {
            isError: false,
            structuredContent: { total: 2 },
            content: [
              { type: "text", text: '{"total":2}' },
              imageBlockAsSent(image, "pages"),
              imageBlockAsSent(photo, "pages"),
            ],
          },
        },
      ]);

      const client = yield* Testing.mcpClient([Strip, Gallery]);

      expect(yield* client.strip()).toEqual([photo, image]);
      expect(yield* client.gallery()).toEqual({ total: 2, pages: [image, photo] });
    }).pipe(Effect.provide(Testing.layer(ActionMcp.layerHttp(arrays, options)))),
  );
});

describe("Testing.mcpClient and a media result", () => {
  const clientAnsweringEveryCallWith = (result: Schema.Json) =>
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ jsonrpc: "2.0", id: 1, result })),
        ),
      ),
    );

  it.effect("takes a media field from its blocks alone, never from the structured content", () =>
    Effect.gen(function* () {
      const client = yield* Testing.mcpClient([Shot], { url: "http://localhost/mcp" });

      const error = yield* Effect.flip(client.shot());

      expect(error._tag).toBe("SchemaError");
    }).pipe(
      clientAnsweringEveryCallWith({
        isError: false,
        structuredContent: { screen, image: { data: Base64.encode(png), mimeType: "image/png" } },
        content: [],
      }),
    ),
  );

  const OnlyImageRequired = Action.make("captioned", {
    ...read,
    success: { caption: Schema.optionalKey(Schema.String), image: Action.Image },
  });

  it.effect("fails a result whose structured content is no object", () =>
    Effect.gen(function* () {
      const client = yield* Testing.mcpClient([OnlyImageRequired], { url: "http://localhost/mcp" });

      const error = yield* Effect.flip(client.captioned());

      expect(error._tag).toBe("SchemaError");
    }).pipe(
      clientAnsweringEveryCallWith({
        isError: false,
        structuredContent: 42,
        content: [imageBlockAsSent(image, "image")],
      }),
    ),
  );

  it.effect("fails a result with more blocks than its one image", () =>
    Effect.gen(function* () {
      const client = yield* Testing.mcpClient([Shot], { url: "http://localhost/mcp" });

      const error = yield* Effect.flip(client.shot());

      expect(error._tag).toBe("SchemaError");
    }).pipe(
      clientAnsweringEveryCallWith({
        isError: false,
        structuredContent: { screen },
        content: [
          { type: "text", text: JSON.stringify({ screen }) },
          imageBlockAsSent(image, "image"),
          imageBlockAsSent(photo, "image"),
        ],
      }),
    ),
  );
});

describe("media fields on the other surfaces", () => {
  const shot = Action.implement(Shot, () => Effect.succeed({ screen, image }));

  const jsonWithBase64Bytes = {
    screen,
    image: { data: Base64.encode(png), mimeType: "image/png" },
  };

  const Http = ActionHttp.make([Shot]);

  it.effect("sends the JSON over HTTP, and ActionHttp.client decodes the bytes", () =>
    Effect.gen(function* () {
      const response = yield* send(post("/api/shot"));

      expect(yield* response.json).toEqual(jsonWithBase64Bytes);

      const client = yield* ActionHttp.client(Http);

      expect(yield* client.shot()).toEqual({ screen, image });
    }).pipe(Effect.provide(Testing.layer(ActionHttp.layer(Http, shot)))),
  );

  it.effect("gives a Toolkit's model the JSON, and its handler the decoded success", () =>
    Effect.gen(function* () {
      const tools = ActionToolkit.make(shot);

      const [returned] = yield* Effect.flatMap(tools.toolkit, (toolkit) =>
        Effect.flatMap(toolkit.handle("shot", {}), Stream.runCollect),
      ).pipe(Effect.provide(tools.layer));

      expect(returned?.encodedResult).toEqual(jsonWithBase64Bytes);
      expect(returned?.result).toEqual({ screen, image });
    }),
  );
});

describe("misplaced media", () => {
  interface ImageTree {
    readonly image: typeof Action.Image.Type;
    readonly children: ReadonlyArray<ImageTree>;
  }

  const ImageTree: Schema.Codec<ImageTree> = Schema.Struct({
    image: Action.Image,
    children: Schema.Array(Schema.suspend((): Schema.Codec<ImageTree> => ImageTree)),
  });

  class Framed extends Schema.Class<Framed>("Framed")({ image: Action.Image }) {}

  class Lost extends Schema.TaggedError<Lost>()("Lost", { image: Action.Image }) {}

  const successes = {
    nested: { screen: Schema.Struct({ image: Action.Image }) },
    union: { image: Schema.NullOr(Action.Image) },
    record: { images: Schema.Record(Schema.String, Action.Image) },
    optionalArray: { images: Schema.optional(Schema.Array(Action.Image)) },
    optionalKeyArray: { images: Schema.optionalKey(Schema.Array(Action.Image)) },
    option: { image: Schema.Option(Action.Image) },
    nullableOptional: { image: Schema.optionalKey(Schema.NullOr(Action.Image)) },
    renamed: Schema.Struct({ image: Action.Image }).pipe(Schema.encodeKeys({ image: "picture" })),
    encodedImage: { image: Action.Image.pipe(Schema.encodeKeys({ data: "bytes" })) },
    encodedArray: Schema.Array(Action.Image).pipe(
      Schema.encode({
        decode: SchemaGetter.transform((images) => [...images].reverse()),
        encode: SchemaGetter.transform((images) => [...images].reverse()),
      }),
    ),
    optionalSuccess: Schema.UndefinedOr(Action.Image),
    framed: Framed,
    tree: ImageTree,
  };

  const misplaced = [
    ...Object.entries(successes).map(([name, success]) => Action.make(name, { ...read, success })),
    Action.make("input", { ...read, input: { image: Action.Image } }),
    Action.make("error", { ...read, error: Lost }),
  ];

  const refused = misplaced.map((action) => Action.implement(action, () => Effect.die("unused")));

  const lifted = Action.implement(Shot, () => Effect.succeed({ screen, image }));

  it("refuses media where no tool lifts it when the server is made, naming every such action", () => {
    const message =
      "MCP media must be the success or an array of it, or a top-level field of a struct " +
      `success, one, optional or a required array: ${misplaced.map(({ name }) => name).join(", ")}`;

    expect(() => ActionMcp.layerHttp([lifted, ...refused], options)).toThrow(message);
    expect(() => ActionMcp.runStdio(refused, options)).toThrow(message);
    expect(() =>
      ActionMcp.layerHttp([lifted, ...refused], { ...options, actions: [Shot] }),
    ).not.toThrow();
    expect(() => ActionHttp.make(misplaced)).not.toThrow();
  });
});
