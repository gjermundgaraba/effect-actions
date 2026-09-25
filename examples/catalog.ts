import { NodeRuntime } from "@effect/platform-node";
import { Console } from "effect";
import * as ActionCatalog from "../src/ActionCatalog.js";
import { Double, GetUser, ListChanges, RenameUser, Status, WhoAmI } from "./contracts.js";

// Contract inspection requires no implementation or domain-service Layer.
Console.log(
  JSON.stringify(
    ActionCatalog.make([Status, GetUser, RenameUser, Double, WhoAmI, ListChanges]),
    null,
    2,
  ),
).pipe(NodeRuntime.runMain);
