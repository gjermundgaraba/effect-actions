# MCP over HTTP

MCP over HTTP serves 2026-07-28 only. The stateful revisions work over Effect's HTTP transport, and request identity stays per request, but each `initialize` registers a session that Effect's runtime never deletes, with no expiry and no `DELETE` termination, and any caller holding the session id may use it.
