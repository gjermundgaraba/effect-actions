# Testing a web handler

`Testing.layer` also takes a web handler the test serves, `layer(handler)`: the client `layer(routes)` gives, building nothing, the handler the test's to dispose. Three downstream projects serve their app to Promise tests through one web handler, which `layer(routes)` would build a second time. This partly reverses the 0.10.0 migration's mapping of `Testing.httpClient(api, handler)` to `layer(routes)` alone: the bridge they wrote instead, `FetchHttpClient.Fetch` provided around the program, also sent the program's other fetch clients to the handler.
