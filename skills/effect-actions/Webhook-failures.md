# Webhook failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message. The tasks are in [Webhook.md](Webhook.md).

## At startup

- `Type 'Dns | HttpClient' is not assignable to type 'never'`, or `Type 'Dns' is not assignable to type 'never'`, at `Layer.launch` or `it.effect`: `Webhook.layer` needs an `HttpClient` to POST and `Dns` to check callbacks. Provide `FetchHttpClient.layer` and `NodeDns.layer` where the server starts, or in a test `Testing.layer(receiver)` and `Dns.layerStatic`.
- `Type 'Receiving' is not assignable to type 'never'`, where a watch given `mode: Webhook.delivery(...)` runs: the watch requires this process's receiver. Provide `Webhook.layerReceiver({ path })` to it, the layer that also serves the route (`Layer.provideMerge`).
