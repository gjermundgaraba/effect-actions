import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Layer } from "effect";
import { Dns } from "effect/net";

import { memory } from "../../src/memory.js";

const unreached = async () => new Response(null, { status: 503 });

export const services = (subscribers = Testing.layer(unreached)) =>
  Layer.mergeAll(
    memory,
    subscribers,
    Dns.layerStatic({ hosts: { "hooks.example.com": ["93.184.216.34"] } })
  );
