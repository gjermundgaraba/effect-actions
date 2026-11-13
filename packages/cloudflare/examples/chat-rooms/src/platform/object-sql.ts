import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { Layer } from "effect";
import { SqlClient } from "effect/sql";

export const layerObjectSql = Layer.effect(SqlClient.SqlClient)(
  CloudflareCluster.DurableObjectSqlClient.orDie
);
