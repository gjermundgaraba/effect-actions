import { Schema } from "effect";

import worker, { ClusterEntity as Counted } from "../src/worker.js";

export {
  ClusterDurableQueue,
  ClusterSingleton,
  ClusterWorkflow,
  RoomsEntrypoint,
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

const instances: string[] = [];

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
      return await super.invoke(...args);
    } finally {
      invokes[invokes.indexOf(counted)] = { ...counted, settled: true };
    }
  }

  override async hold() {
    others.hold += 1;
    await super.hold();
  }

  override async acknowledge(requestId: string, replyId: string) {
    others.acknowledge += 1;

    return await super.acknowledge(requestId, replyId);
  }
}

export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    if (new URL(request.url).pathname === "/stub-calls") {
      return Response.json({ invokes, others, instances });
    }

    return await worker.fetch(request, env);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
