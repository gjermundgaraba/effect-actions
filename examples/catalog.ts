import { NodeRuntime } from "@effect/platform-node";
import { Console } from "effect";
import * as ActionCatalog from "../src/ActionCatalog.js";
import { AuditActions, PublicActions, UserActions } from "./contracts.js";

// Contract inspection requires no implementation or domain-service Layer.
Console.log(
  JSON.stringify(ActionCatalog.make(PublicActions, UserActions, AuditActions), null, 2),
).pipe(NodeRuntime.runMain);
