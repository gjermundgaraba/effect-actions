import { describe, expect, it } from "@effect/vitest";
import { Effect, flow, Layer } from "effect";
import type { LanguageModel } from "effect/ai";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Http } from "../../src/Api.js";
import { AssistantFailed, ConversationNotFound } from "../../src/assistant/Assistant.js";
import { memory } from "../../src/memory.js";
import { publicRoutes } from "../../src/routes.js";
import { scripted } from "../support/scripted.js";

// The assistant as its callers reach it: over HTTP, a request per turn, on the real routes in
// memory. Each test gives the routes the model it is about, in place of the demo one: the
// first `Layer.provide` is what the routes get.
const served = (model: Layer.Layer<LanguageModel.LanguageModel>) =>
  Effect.provide(Testing.layer(publicRoutes).pipe(Layer.provide(model), Layer.provide(memory)));

const signedIn = (token: string) => ({
  transformClient: HttpClient.mapRequest(
    flow(HttpClientRequest.bearerToken(token), HttpClientRequest.setHeader("x-workspace", "acme")),
  ),
});

// Ada may write in acme. Linus, in the same workspace, may only read.
const asAda = ActionHttp.client(Http, signedIn("ada"));

const asLinus = ActionHttp.client(Http, signedIn("linus"));

const call = (id: string, name: string, params: Readonly<Record<string, string>>) =>
  ({ type: "tool-call", id, name, params }) as const;

const says = (text: string) => [{ type: "text", text }] as const;

const approving = (waiting: ReadonlyArray<{ readonly approvalId: string }>) =>
  waiting.map(({ approvalId }) => ({ approvalId, approved: true }));

describe("the assistant, behind a route", () => {
  it.effect("reads at once, and writes in the request that carries its member's approval", () =>
    Effect.gen(function* () {
      const ada = yield* asAda;
      const { id } = yield* ada.createIssue({ title: "Crash", body: "On save." });

      // One request, two requests to the model: the second lets it read its tool's result.
      const read = yield* ada.askAssistant({ prompt: "What is open?" });

      expect(read).toMatchObject({
        text: "One issue is open.",
        ran: [{ tool: "listIssues", failed: false }],
        waiting: [],
      });

      // The same conversation, a request later. The write has not run: the turn ended on it.
      const asked = yield* ada.askAssistant({
        conversation: read.conversation,
        prompt: "Close it.",
      });

      expect(asked).toMatchObject({
        conversation: read.conversation,
        ran: [],
        waiting: [{ tool: "closeIssue", arguments: JSON.stringify({ id }) }],
      });
      expect(yield* ada.getIssue({ id })).toMatchObject({ status: "open" });

      const answered = yield* ada.answerAssistant({
        conversation: asked.conversation,
        answers: approving(asked.waiting),
      });

      expect(answered).toEqual({
        conversation: asked.conversation,
        text: "Closed.",
        ran: [{ tool: "closeIssue", failed: false }],
        waiting: [],
      });
      expect(yield* ada.getIssue({ id })).toMatchObject({ status: "closed" });
    }).pipe(
      served(
        scripted(
          [call("1", "listIssues", { status: "open" })],
          says("One issue is open."),
          [call("2", "closeIssue", { id: "ACME-1" })],
          says("Closed."),
        ),
      ),
    ),
  );

  it.effect("lets only the member who was asked answer, or continue the conversation", () =>
    Effect.gen(function* () {
      const ada = yield* asAda;
      const linus = yield* asLinus;
      const { id } = yield* ada.createIssue({ title: "Crash", body: "On save." });
      const asked = yield* ada.askAssistant({ prompt: "Close it." });
      const { conversation } = asked;

      expect(
        yield* Effect.flip(
          linus.answerAssistant({ conversation, answers: approving(asked.waiting) }),
        ),
      ).toEqual(new ConversationNotFound({ conversation }));
      expect(yield* Effect.flip(linus.askAssistant({ conversation, prompt: "Go on." }))).toEqual(
        new ConversationNotFound({ conversation }),
      );
      expect(yield* ada.getIssue({ id })).toMatchObject({ status: "open" });
    }).pipe(served(scripted([call("1", "closeIssue", { id: "ACME-1" })]))),
  );

  it.effect("runs an approved call as its caller: approval lets no one do what they may not", () =>
    Effect.gen(function* () {
      const ada = yield* asAda;
      const linus = yield* asLinus;
      const { id } = yield* ada.createIssue({ title: "Crash", body: "On save." });

      // Anyone signed in may ask. The tool's own `authorize` then refuses the reader's write,
      // as a result the model reads.
      const asked = yield* linus.askAssistant({ prompt: "Close it." });

      const answered = yield* linus.answerAssistant({
        conversation: asked.conversation,
        answers: approving(asked.waiting),
      });

      expect(answered).toMatchObject({
        text: "You may not close issues.",
        ran: [{ tool: "closeIssue", failed: true }],
      });
      expect(yield* ada.getIssue({ id })).toMatchObject({ status: "open" });
    }).pipe(
      served(
        scripted([call("1", "closeIssue", { id: "ACME-1" })], says("You may not close issues.")),
      ),
    ),
  );

  it.effect("ends the conversation when the model fails after an approved call ran", () =>
    Effect.gen(function* () {
      const ada = yield* asAda;
      const { id } = yield* ada.createIssue({ title: "Crash", body: "On save." });
      const asked = yield* ada.askAssistant({ prompt: "Say it is fixed." });

      const answer = ada.answerAssistant({
        conversation: asked.conversation,
        answers: approving(asked.waiting),
      });

      // The approved call ran, then the model failed: the error says so.
      expect(yield* Effect.flip(answer)).toBeInstanceOf(AssistantFailed);
      expect((yield* ada.getIssue({ id })).comments).toEqual([{ author: "ada", text: "Fixed." }]);

      // The same answer, sent again, runs nothing: its conversation is gone.
      expect(yield* Effect.flip(answer)).toEqual(
        new ConversationNotFound({ conversation: asked.conversation }),
      );
      expect((yield* ada.getIssue({ id })).comments).toHaveLength(1);
    }).pipe(
      served(scripted([call("1", "commentOnIssue", { id: "ACME-1", text: "Fixed." })], "fails")),
    ),
  );
});
