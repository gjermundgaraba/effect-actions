import { Layer } from "effect";
import { Dns } from "effect/net";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { memory } from "../../src/memory.js";

// What the public routes need, in memory: the application's services, and for webhook delivery
// a client and a resolver. `subscribers` answers each POST in place of a member's server, and
// hooks.example.com resolves to a public address: delivery refuses a private or loopback one.
export const services = (subscribers = Testing.layer(unreached)) =>
  Layer.mergeAll(
    memory,
    subscribers,
    Dns.layerStatic({ hosts: { "hooks.example.com": ["93.184.216.34"] } }),
  );

async function unreached(): Promise<Response> {
  return new Response(null, { status: 503 });
}
