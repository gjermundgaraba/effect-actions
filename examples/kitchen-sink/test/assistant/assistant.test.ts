import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Deferred, Effect, Fiber, flow, Layer } from "effect";
import type { LanguageModel } from "effect/ai";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Http } from "../../src/Api.js";
import {
  AssistantFailed,
  ConversationNotFound,
} from "../../src/assistant/Assistant.js";
import { publicRoutes } from "../../src/routes.js";
import { down, scripted } from "../support/scripted.js";
import { services } from "../support/services.js";

// The assistant as its callers reach it: over HTTP, a request per turn, on the real routes in
// memory. Each test gives the routes the model it is about, in place of the demo one: the
// first `Layer.provide` is what the routes get.
const served = (model: Layer.Layer<LanguageModel.LanguageModel>) =>
  Effect.provide(
    Testing.layer(publicRoutes).pipe(
      Layer.provide(model),
      Layer.provide(services())
    )
  );

const signedIn = (token: string) => ({
  transformClient: HttpClient.mapRequest(
    flow(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeader("x-workspace", "acme")
    )
  ),
});

// Ada may write in acme. Linus, in the same workspace, may only read.
const asAda = ActionHttp.client(Http, signedIn("ada"));

const asLinus = ActionHttp.client(Http, signedIn("linus"));

const call = (
  id: string,
  name: string,
  params: Readonly<Record<string, string>>
) => ({ type: "tool-call", id, name, params }) as const;

const says = (text: string) => [{ type: "text", text }] as const;

const approving = (waiting: ReadonlyArray<{ readonly approvalId: string }>) =>
  waiting.map(({ approvalId }) => ({ approvalId, approved: true }));

describe("the assistant, behind a route", () => {
  it.effect(
    "reads at once, and writes in the request that carries its member's approval",
    () =>
      Effect.gen(function* () {
        const ada = yield* asAda;

        const { id } = yield* ada.createIssue({
          title: "Crash",
          body: "On save.",
        });

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

        expect(answered).toStrictEqual({
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
            says("Closed.")
          )
        )
      )
  );

  it.effect(
    "lets only the member who was asked answer, or continue the conversation",
    () =>
      Effect.gen(function* () {
        const ada = yield* asAda;
        const linus = yield* asLinus;

        const { id } = yield* ada.createIssue({
          title: "Crash",
          body: "On save.",
        });

        const asked = yield* ada.askAssistant({ prompt: "Close it." });
        const { conversation } = asked;

        expect(
          yield* Effect.flip(
            linus.answerAssistant({
              conversation,
              answers: approving(asked.waiting),
            })
          )
        ).toStrictEqual(new ConversationNotFound({ conversation }));
        expect(
          yield* Effect.flip(
            linus.askAssistant({ conversation, prompt: "Go on." })
          )
        ).toStrictEqual(new ConversationNotFound({ conversation }));
        expect(yield* ada.getIssue({ id })).toMatchObject({ status: "open" });
      }).pipe(served(scripted([call("1", "closeIssue", { id: "ACME-1" })])))
  );

  it.effect(
    "runs an approved call as its caller: approval lets no one do what they may not",
    () =>
      Effect.gen(function* () {
        const ada = yield* asAda;
        const linus = yield* asLinus;

        const { id } = yield* ada.createIssue({
          title: "Crash",
          body: "On save.",
        });

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
          scripted(
            [call("1", "closeIssue", { id: "ACME-1" })],
            says("You may not close issues.")
          )
        )
      )
  );

  it.effect(
    "ends the conversation when the model fails after an approved call ran",
    () =>
      Effect.gen(function* () {
        const ada = yield* asAda;

        const { id } = yield* ada.createIssue({
          title: "Crash",
          body: "On save.",
        });

        const asked = yield* ada.askAssistant({ prompt: "Say it is fixed." });

        const answer = ada.answerAssistant({
          conversation: asked.conversation,
          answers: approving(asked.waiting),
        });

        // The approved call ran, then the model failed: the error says so.
        expect(yield* Effect.flip(answer)).toBeInstanceOf(AssistantFailed);
        expect((yield* ada.getIssue({ id })).comments).toStrictEqual([
          { author: "ada", text: "Fixed." },
        ]);

        // The same answer, sent again, runs nothing: its conversation is gone.
        expect(yield* Effect.flip(answer)).toStrictEqual(
          new ConversationNotFound({ conversation: asked.conversation })
        );
        expect((yield* ada.getIssue({ id })).comments).toHaveLength(1);
      }).pipe(
        served(
          scripted(
            [call("1", "commentOnIssue", { id: "ACME-1", text: "Fixed." })],
            down
          )
        )
      )
  );

  it.effect("runs nothing for a denied call, and lists none as run", () =>
    Effect.gen(function* () {
      const ada = yield* asAda;

      const { id } = yield* ada.createIssue({
        title: "Crash",
        body: "On save.",
      });

      const asked = yield* ada.askAssistant({ prompt: "Close it." });

      const denied = yield* ada.answerAssistant({
        conversation: asked.conversation,
        answers: asked.waiting.map(({ approvalId }) => ({
          approvalId,
          approved: false,
        })),
      });

      expect(denied).toMatchObject({
        text: "Left open.",
        ran: [],
        waiting: [],
      });
      expect(yield* ada.getIssue({ id })).toMatchObject({ status: "open" });
    }).pipe(
      served(
        scripted(
          [call("1", "closeIssue", { id: "ACME-1" })],
          says("Left open.")
        )
      )
    )
  );

  it.effect(
    "lists no call of a reply the provider cut short: none of them ran",
    () =>
      Effect.gen(function* () {
        const ada = yield* asAda;

        yield* ada.createIssue({ title: "Crash", body: "On save." });

        expect(
          yield* ada.askAssistant({ prompt: "What is open?" })
        ).toMatchObject({
          text: "I was cut off.",
          ran: [],
          waiting: [],
        });
      }).pipe(
        served(
          scripted(
            [
              call("1", "listIssues", { status: "open" }),
              {
                type: "finish",
                reason: "length",
                usage: { inputTokens: {}, outputTokens: {} },
              },
            ],
            says("I was cut off.")
          )
        )
      )
  );

  it.effect(
    "runs the one call of two that is approved, and leaves the other open",
    () =>
      Effect.gen(function* () {
        const ada = yield* asAda;

        const { id } = yield* ada.createIssue({
          title: "Crash",
          body: "On save.",
        });

        const asked = yield* ada.askAssistant({
          prompt: "Say it is fixed, and close it.",
        });

        const [first, second] = approving(asked.waiting);

        expect(asked.waiting.map(({ tool }) => tool)).toStrictEqual([
          "commentOnIssue",
          "closeIssue",
        ]);

        const answered = yield* ada.answerAssistant({
          conversation: asked.conversation,
          answers: first === undefined ? [] : [first],
        });

        // The call left open is listed again, in every turn until it is answered.
        expect(answered).toMatchObject({ ran: [{ tool: "commentOnIssue" }] });
        expect(answered.waiting).toStrictEqual([
          {
            approvalId: second?.approvalId,
            tool: "closeIssue",
            arguments: '{"id":"ACME-1"}',
          },
        ]);
        expect(yield* ada.getIssue({ id })).toMatchObject({ status: "open" });

        const closed = yield* ada.answerAssistant({
          conversation: asked.conversation,
          answers: second === undefined ? [] : [second],
        });

        expect(closed.waiting).toStrictEqual([]);
        expect(yield* ada.getIssue({ id })).toMatchObject({ status: "closed" });
        expect((yield* ada.getIssue({ id })).comments).toHaveLength(1);
      }).pipe(
        served(
          scripted(
            [
              call("1", "commentOnIssue", { id: "ACME-1", text: "Fixed." }),
              call("2", "closeIssue", { id: "ACME-1" }),
            ],
            says("Said."),
            says("Closed.")
          )
        )
      )
  );

  it.effect(
    "keeps listing a request left open while its member asks for something else",
    () =>
      Effect.gen(function* () {
        const ada = yield* asAda;

        const { id } = yield* ada.createIssue({
          title: "Crash",
          body: "On save.",
        });

        const first = yield* ada.askAssistant({ prompt: "Say it is fixed." });

        const second = yield* ada.askAssistant({
          conversation: first.conversation,
          prompt: "Close it too.",
        });

        expect(second.waiting.map(({ tool }) => tool)).toStrictEqual([
          "commentOnIssue",
          "closeIssue",
        ]);

        const [, close] = approving(second.waiting);

        const closed = yield* ada.answerAssistant({
          conversation: first.conversation,
          answers: close === undefined ? [] : [close],
        });

        // Each answer runs its own call: the close ran, the comment still waits.
        expect(closed.ran).toStrictEqual([
          { tool: "closeIssue", failed: false },
        ]);
        expect(closed.waiting).toStrictEqual(first.waiting);
        expect(yield* ada.getIssue({ id })).toMatchObject({
          status: "closed",
          comments: [],
        });
      }).pipe(
        served(
          scripted(
            [call("1", "commentOnIssue", { id: "ACME-1", text: "Fixed." })],
            [call("2", "closeIssue", { id: "ACME-1" })],
            says("Closed.")
          )
        )
      )
  );

  // A provider gives each call an id of its own. Where a model does not, Effect runs the last
  // call with the id an approval names: the list shows that call, not the one first asked.
  it.effect(
    "lists, for a call id a model used twice, the call an approval would run",
    () =>
      Effect.gen(function* () {
        const ada = yield* asAda;

        const { id } = yield* ada.createIssue({
          title: "Crash",
          body: "On save.",
        });

        const first = yield* ada.askAssistant({ prompt: "Say it is fixed." });

        const second = yield* ada.askAssistant({
          conversation: first.conversation,
          prompt: "Close it too.",
        });

        expect(second.waiting.map(({ tool }) => tool)).toStrictEqual([
          "closeIssue",
          "closeIssue",
        ]);

        const answered = yield* ada.answerAssistant({
          conversation: first.conversation,
          answers: approving(first.waiting),
        });

        expect(answered).toMatchObject({
          ran: [{ tool: "closeIssue" }],
          waiting: [],
        });
        expect(yield* ada.getIssue({ id })).toMatchObject({
          status: "closed",
          comments: [],
        });
      }).pipe(
        served(
          scripted(
            [call("same", "commentOnIssue", { id: "ACME-1", text: "Fixed." })],
            [call("same", "closeIssue", { id: "ACME-1" })],
            says("Closed.")
          )
        )
      )
  );

  it.effect(
    "runs what its member approves in a later turn of the demo model",
    () =>
      Effect.gen(function* () {
        const ada = yield* asAda;

        yield* ada.createIssue({ title: "Crash", body: "On save." });

        const first = yield* ada.askAssistant({ prompt: "Tidy up." });

        yield* ada.answerAssistant({
          conversation: first.conversation,
          answers: approving(first.waiting),
        });

        const again = yield* ada.askAssistant({
          conversation: first.conversation,
          prompt: "Once more.",
        });

        const answered = yield* ada.answerAssistant({
          conversation: first.conversation,
          answers: approving(again.waiting),
        });

        expect(again.waiting.map(({ tool }) => tool)).toStrictEqual([
          "closeIssue",
        ]);
        expect(answered).toMatchObject({
          ran: [{ tool: "closeIssue" }],
          waiting: [],
        });
      }).pipe(
        Effect.provide(
          Testing.layer(publicRoutes).pipe(Layer.provide(services()))
        )
      )
  );

  it.effect(
    "refuses a request answering one approval twice, and runs nothing of it",
    () =>
      Effect.gen(function* () {
        const ada = yield* asAda;

        const { id } = yield* ada.createIssue({
          title: "Crash",
          body: "On save.",
        });

        const asked = yield* ada.askAssistant({ prompt: "Say it is fixed." });
        const [answer] = approving(asked.waiting);

        expect(
          yield* Effect.flip(
            ada.answerAssistant({
              conversation: asked.conversation,
              answers: answer === undefined ? [] : [answer, answer],
            })
          )
        ).toBeInstanceOf(Action.InvalidInput);
        expect((yield* ada.getIssue({ id })).comments).toHaveLength(0);

        yield* ada.answerAssistant({
          conversation: asked.conversation,
          answers: approving(asked.waiting),
        });

        expect((yield* ada.getIssue({ id })).comments).toHaveLength(1);
      }).pipe(
        served(
          scripted(
            [call("1", "commentOnIssue", { id: "ACME-1", text: "Fixed." })],
            says("Said.")
          )
        )
      )
  );

  it.effect(
    "runs an approved call once when its answer arrives twice at once",
    () =>
      Effect.gen(function* () {
        const ada = yield* asAda;

        const { id } = yield* ada.createIssue({
          title: "Crash",
          body: "On save.",
        });

        const asked = yield* ada.askAssistant({ prompt: "Say it is fixed." });

        const answer = Effect.flip(
          ada.answerAssistant({
            conversation: asked.conversation,
            answers: approving(asked.waiting),
          })
        );

        // A double click, or a client's retry. One turn runs at a time, and the one that waited
        // finds its conversation ended by the one that failed.
        const refusals = yield* Effect.all([answer, answer], {
          concurrency: 2,
        });

        expect(refusals.map(({ _tag }) => _tag).toSorted()).toStrictEqual([
          "AssistantFailed",
          "ConversationNotFound",
        ]);
        expect((yield* ada.getIssue({ id })).comments).toHaveLength(1);
      }).pipe(
        served(
          scripted(
            [call("1", "commentOnIssue", { id: "ACME-1", text: "Fixed." })],
            down,
            down
          )
        )
      )
  );

  it.effect(
    "ends the conversation of a turn that is interrupted after its approved call ran",
    () => {
      // Completed when the model is asked what to say about the approved call's result.
      const thinking = Deferred.makeUnsafe<undefined>();

      return Effect.gen(function* () {
        const ada = yield* asAda;

        const { id } = yield* ada.createIssue({
          title: "Crash",
          body: "On save.",
        });

        const asked = yield* ada.askAssistant({ prompt: "Say it is fixed." });

        const answer = ada.answerAssistant({
          conversation: asked.conversation,
          answers: approving(asked.waiting),
        });

        // The client goes away while the model is thinking, after the approved call ran.
        const leaving = yield* Effect.forkChild(answer);

        yield* Deferred.await(thinking);
        yield* Fiber.interrupt(leaving);

        expect(yield* Effect.flip(answer)).toStrictEqual(
          new ConversationNotFound({ conversation: asked.conversation })
        );
        expect((yield* ada.getIssue({ id })).comments).toHaveLength(1);
      }).pipe(
        served(
          scripted(
            [call("1", "commentOnIssue", { id: "ACME-1", text: "Fixed." })],
            Effect.andThen(Deferred.succeed(thinking, undefined), Effect.never)
          )
        )
      );
    }
  );
});
