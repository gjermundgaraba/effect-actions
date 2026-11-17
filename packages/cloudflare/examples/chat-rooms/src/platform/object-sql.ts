import * as ActionCluster from "@gjermundgaraba/effect-actions-cloudflare/ActionCluster";
import { Layer } from "effect";
import { SqlClient } from "effect/sql";

export const layerObjectSql = Layer.effect(SqlClient.SqlClient)(
  ActionCluster.Sql.orDie
);
