import { Buffer } from "node:buffer";

import { Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { Printer } from "../printers/Printers.js";

export const picture = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64"
  )
);

const token = "demo-session";

const Login = Schema.fromJsonString(
  Schema.Struct({
    user: Schema.NonEmptyString,
    password: Schema.NonEmptyString,
  })
);

const Job = Schema.fromJsonString(
  Schema.Struct({ file: Schema.NonEmptyString })
);

const refuse = (status: number, error: string) =>
  Response.json({ error }, { status });

export const fakeFarm = Layer.sync(HttpClient.HttpClient, () => {
  const printers = new Map<string, Printer>([
    [
      "mk4-1",
      {
        id: "mk4-1",
        name: "MK4 by the door",
        state: "printing",
        job: { file: "bracket.gcode", progress: 62 },
      },
    ],
    [
      "mk4-2",
      { id: "mk4-2", name: "MK4 by the window", state: "idle", job: null },
    ],
    [
      "mini-1",
      { id: "mini-1", name: "Mini on the shelf", state: "offline", job: null },
    ],
  ]);

  const answer = (
    method: string,
    path: string,
    authorization: string | undefined,
    body: string
  ): Response => {
    if (method === "POST" && path === "/api/login") {
      return Option.match(Schema.decodeOption(Login)(body), {
        onNone: () => refuse(400, "Give a user and a password."),
        onSome: () => Response.json({ token }),
      });
    }

    if (authorization !== `Bearer ${token}`) {
      return refuse(401, "Sign in first.");
    }

    if (method === "GET" && path === "/api/printers") {
      return Response.json({ printers: [...printers.values()] });
    }

    const [id = "", action = ""] = path
      .replace("/api/printers/", "")
      .split("/");

    const printer = printers.get(id);

    if (printer === undefined) {
      return refuse(404, `No printer has the id ${id}.`);
    }

    const becomes = (state: Printer["state"], job: Printer["job"]) => {
      const changed = { ...printer, state, job };

      printers.set(printer.id, changed);

      return Response.json(changed);
    };

    if (printer.state === "offline" && action !== "") {
      return refuse(409, `${printer.name} is offline.`);
    }

    switch (`${method} ${action}`) {
      case "GET ": {
        return Response.json(printer);
      }

      case "GET camera": {
        return new Response(picture, {
          headers: { "content-type": "image/png" },
        });
      }

      case "POST job": {
        return printer.job === null
          ? Option.match(Schema.decodeOption(Job)(body), {
              onNone: () => refuse(400, "Name the file to print."),
              onSome: ({ file }) => becomes("printing", { file, progress: 0 }),
            })
          : refuse(409, `${printer.name} is busy with ${printer.job.file}.`);
      }

      case "POST pause":
      case "POST resume": {
        return printer.job === null
          ? refuse(409, `${printer.name} has no job.`)
          : becomes(action === "pause" ? "paused" : "printing", printer.job);
      }

      case "DELETE job": {
        return becomes("idle", null);
      }

      default: {
        return refuse(404, `No such route: ${method} ${path}.`);
      }
    }
  };

  return HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const sent = yield* Effect.orDie(HttpClientRequest.toWeb(request));
      const body = yield* Effect.promise(async () => await sent.text());

      return HttpClientResponse.fromWeb(
        request,
        answer(
          request.method,
          url.pathname,
          request.headers["authorization"],
          body
        )
      );
    })
  );
});
