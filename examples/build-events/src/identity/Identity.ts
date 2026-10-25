import { Context, Schema } from "effect";

/** A member, and the pipelines whose builds it may see. */
export const Member = Schema.Struct({
  id: Schema.String,
  pipelines: Schema.Array(Schema.String),
});

export type Member = typeof Member.Type;

/**
 * Who is subscribing or calling. Every event and action here declares it, `caller:
 * CurrentMember`; whoever runs a watch or a call provides it, as `test/support/as.ts` does.
 */
export class CurrentMember extends Context.Service<CurrentMember, Member>()(
  "build-events/CurrentMember",
) {}
