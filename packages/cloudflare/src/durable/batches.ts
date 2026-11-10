import { Array as Arr, Effect } from "effect";

/**
 * The most keys one storage call takes: `get`, `put` and `delete` take at most 128 each, as
 * Cloudflare's storage API documents, though local workerd takes more.
 */
export const batchSize = 128;

/** `keys`, or entries, in the batches one storage call takes. */
export const batches = <A>(keys: readonly A[]): ReadonlyArray<readonly A[]> =>
  Arr.chunksOf(keys, batchSize);

export const deleted = (
  storage: DurableObjectStorage,
  keys: readonly string[]
) =>
  Effect.forEach(
    batches(keys),
    (batch) => Effect.promise(async () => await storage.delete([...batch])),
    {
      discard: true,
    }
  );
