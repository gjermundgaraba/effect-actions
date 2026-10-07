# Request body size

Request body size is host configuration, not a library option: the host provides `HttpServerRequest.MaxBodySize` to `HttpRouter.serve`'s layer. It is Effect's server-wide setting and covers every route, the host's own included; an option per surface would duplicate it for only some of them. Node's server drops an over-limit request without a response. A web handler ignores the setting, so its platform limits bodies.
