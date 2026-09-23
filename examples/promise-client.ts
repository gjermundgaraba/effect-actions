import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import * as ActionHttpClient from "../src/ActionHttpClient.js";
import { Http, UserNotFound } from "./contracts.js";

// Promises in, Promises out: for code that does not run Effects, such as a browser page.
// The options are the native `HttpApiClient.make` options plus `fetch`; a bearer token is
// a `transformClient`.
const client = ActionHttpClient.promise(Http, {
  baseUrl: "http://127.0.0.1:3000",
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("alice")),
});

export const userName = async (id: string): Promise<string> => {
  try {
    return (await client.users.getUser({ id })).name;
  } catch (error) {
    // A declared error rejects as its own value...
    if (error instanceof UserNotFound) return "(no such user)";

    // ...and what the contract cannot account for as Effect's own `HttpClientError`.
    if (HttpClientError.isHttpClientError(error) && error.response === undefined) {
      return "(server unreachable)";
    }

    throw error;
  }
};
