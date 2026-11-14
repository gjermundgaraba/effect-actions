import { Schema } from "effect";

import worker, { ClusterEntity as Counted } from "../src/worker.js";

export {
  ClusterDurableQueue,
  ClusterSingleton,
  ClusterWorkflow,
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

  override async invoke(...args: Parameters<Counted["invoke"]>) {
    const counted = {
      object: this.ctx.id.name ?? "",
      tag: decodeEnvelope(args[0]).tag,
      settled: false,
    };

    invokes.push(counted);

    try {
      const answer = await super.invoke(...args);

      if (counted.tag === failingAfter) {
        failingAfter = undefined;

        throw new Error(`planted failure after ${counted.tag}`);
      }

      return answer;
    } finally {
      invokes[invokes.indexOf(counted)] = { ...counted, settled: true };
    }
  }

  override async hold() {
    others.hold += 1;
    await super.hold();
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

  override async acknowledge(requestId: string, replyId: string) {
    others.acknowledge += 1;

    return await super.acknowledge(requestId, replyId);
  }
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
