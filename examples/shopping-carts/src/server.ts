import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";

import { layerSingleRunner } from "./platform/cluster.js";
import { layerSqlCarts } from "./platform/sql-carts.js";
import { entities, routes } from "./routes.js";

const demoListen = { host: "127.0.0.1", port: 3000 };

const demoDatabase = SqliteClient.layer({ filename: "shopping-carts.db" });

HttpRouter.serve(routes).pipe(
  Layer.provideMerge(entities),
  Layer.provide([layerSingleRunner, layerSqlCarts]),
  Layer.provide(Layer.orDie(demoDatabase)),
  Layer.provide(NodeHttpServer.layer(createServer, demoListen)),
  Layer.launch,
  NodeRuntime.runMain()
);
