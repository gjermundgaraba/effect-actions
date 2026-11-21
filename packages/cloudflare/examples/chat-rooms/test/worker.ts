import * as CloudflareDurableObjects from "@effect/platform-cloudflare/CloudflareDurableObjects";
import { Predicate, Schema } from "effect";

import worker, { ClusterEntity as Counted } from "../src/worker.js";

export {
  ClusterDurableQueue,
  ClusterSingleton,
  ClusterWorkflow,
  McpEndpoint,
} from "../src/worker.js";

const Envelope = Schema.Struct({ tag: Schema.String });

const decodeEnvelope = Schema.decodeUnknownSync(
  Schema.fromJsonString(Envelope)
);

const invokes: Array<{
  readonly object: string;
  readonly tag: string;
  readonly settled: boolean;
}> = [];

const others = { hold: 0, acknowledge: 0 };

const messages = { received: 0, settled: 0 };

const instances: string[] = [];

let failingAfter: string | undefined;

export class ClusterEntity extends Counted {
  constructor(...args: ConstructorParameters<typeof Counted>) {
    super(...args);
    instances.push(`${this.ctx.id.name ?? ""}#${crypto.randomUUID()}`);
  }

  override async webSocketMessage(
    ...args: Parameters<Counted["webSocketMessage"]>
  ) {
    messages.received += 1;

    try {
      await super.webSocketMessage(...args);
    } finally {
      messages.settled += 1;
    }
  }
}

const effects = CloudflareDurableObjects.ClusterEntity.prototype;

const methodOf = (name: string) => {
  const method: unknown = Object.getOwnPropertyDescriptor(effects, name)?.value;

  if (!Predicate.isFunction(method)) {
    throw new TypeError(`ClusterEntity has no ${name} to count`);
  }

  return method;
};

const invoke = methodOf("invoke");

Object.defineProperty(ClusterEntity.prototype, "invoke", {
  async value(this: ClusterEntity, ...args: unknown[]): Promise<unknown> {
    const counted = {
      object: this.ctx.id.name ?? "",
      tag: decodeEnvelope(args[0]).tag,
      settled: false,
    };

    invokes.push(counted);

    try {
      const answer: unknown = await invoke.apply(this, args);

      if (counted.tag === failingAfter) {
        failingAfter = undefined;

        throw new Error(`planted failure after ${counted.tag}`);
      }

      return answer;
    } finally {
      invokes[invokes.indexOf(counted)] = { ...counted, settled: true };
    }
  },
});

for (const name of ["hold", "acknowledge"] as const) {
  const method = methodOf(name);

  Object.defineProperty(ClusterEntity.prototype, name, {
    async value(this: ClusterEntity, ...args: unknown[]): Promise<unknown> {
      others[name] += 1;

      return await method.apply(this, args);
    },
  });
}

export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    const url = new URL(request.url);

    if (url.pathname === "/stub-calls") {
      return Response.json({ invokes, others, messages, instances });
    }

    if (url.pathname === "/fail-after") {
      failingAfter = url.searchParams.get("tag") ?? undefined;

      return new Response(null, { status: 204 });
    }

    return await worker.fetch(request, env);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
