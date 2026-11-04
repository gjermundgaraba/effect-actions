# Handoff: branch `object-server` (2026-11-04)

The branch adds one module, `@gjermundgaraba/effect-actions-cloudflare/ObjectServer`, in a single commit on top of the 0.29.0 release. The CHANGELOG's "Unreleased" entry describes it, `packages/cloudflare/docs/ObjectServer.md` documents it, and `ObjectServer-failures.md` lists its failure modes. The tests are `packages/cloudflare/tests/durable/object-server.test.ts` and `object-server.test-d.ts`. `ActionDurableObject.ts` is unchanged.

## Why it exists

durable-clanker's branch `cluster` (see its `docs/handoff.md`) runs its agent as an Effect Cluster entity on the shared `ClusterEntity` Durable Object class from `@effect/platform-cloudflare`. That class builds per-object services as a Layer and runs each event as an Effect, so `ActionDurableObject.make` cannot build it and `ActionDurableObject.handlers` does not fit. `ObjectServer.layer(routes)` puts an object's routes, its storage-backed `Event.Events`, `Action.Idempotency`, and its sockets into that Layer. The class's `fetch` and `webSocket*` methods delegate to the `ObjectServer` service.

## State

- All tests pass (1730) on `6351f8e`.
- Not released. durable-clanker installs it from tarballs packed from this branch: `vp run -r build`, then `vp pm pack --pack-destination /tmp/ea-pack-object-server` at the root and again in `packages/cloudflare`.
- Next step: release it (minor, since it only adds a module), then pin that version in durable-clanker's pnpm catalog in place of the `file:` tarballs.
- Delete this file before merging.
