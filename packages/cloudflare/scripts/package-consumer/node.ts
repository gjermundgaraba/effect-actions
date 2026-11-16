import * as ActionCluster from "@gjermundgaraba/effect-actions-cloudflare/ActionCluster";
import { Predicate } from "effect";

if (!Predicate.isFunction(ActionCluster.layer)) {
  throw new TypeError(
    "ActionCluster, loaded in Node from the packed package, exports no layer"
  );
}
