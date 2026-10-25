# Webhook failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [Webhook.md](Webhook.md).

## At startup

- `Type 'Dns | HttpClient' is not assignable to type 'never'`, or `Type 'Dns' is not assignable to type 'never'`, at `Layer.launch` or `it.effect`: `Webhook.layer` needs an `HttpClient` to POST and `Dns` to check callbacks. Provide `FetchHttpClient.layer` and `NodeDns.layer` where the server starts, or in a test `Testing.layer(receiver)` and `Dns.layerStatic`.
