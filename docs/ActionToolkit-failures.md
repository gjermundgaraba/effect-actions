# ActionToolkit failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [ActionToolkit.md](ActionToolkit.md).

- An approved call never runs, and nothing is raised: the `tool-approval-response` was sent without the history holding its request ([Ask for approval](ActionToolkit.md#ask-for-approval)).
- `Type 'X' is not assignable to type 'never'` for a request service where a turn or a call by hand runs, or `Service not found` at call time from plain JavaScript: a protected tool owes its identity whatever its handler reads, or the service was provided to the stream alone. Provide it around the turn, or around the whole call effect.
- Type error on `layer`'s requirements: a build-time service is missing. Provide its Layer to `layer`.
- Type error on `needsApproval`'s `Effect`: it yields a service such as the caller. Read it with `Effect.serviceOption`.
- `Property '<field>' does not exist` on `call.input`: another action's input lacks the field. Check `call.name` first.
- A returned failure whose `result` is an `AiError` with reason `ToolParameterValidationError` (`failureOrigin: "parameters"`), not a declared error: the arguments did not decode. Neither `authorize` nor the handler ran.
- A turn fails with an `AiError`, `Failed to encode result for tool '<name>'`: the handler failed with an error its action does not declare, which a cast or plain JavaScript lets through. Declare it.
- A model reads base64 text where an image was meant: a tool's success holds an `Action.Image`, which a Toolkit gives the model as JSON text. Leave the action out of `actions`, or serve it over MCP, which sends an image block ([ActionMcp.md](ActionMcp.md#return-images-and-other-media)).
- `Listed in actions, but no implementation holds it: <names>` thrown at `make`: those actions are not among the implementations', by identity. `(another contract)` marks one whose name an implementation holds, as a second copy of the contracts module makes. Pass the implementation holding it, or list the contract it implements.
- `Duplicate tool: <name>` thrown at `make`: two implementations serve actions of one name. Rename one action; of two implementations of one contract, pass one.
- A defect when a tool handles a call: the `layer` provided is another implementation's, with tools of the same names, which the types accept. Provide a `layer` made from the implementations the `toolkit` was made from.
- Every toolkit of an implementation answers with one set of startup services: two layers of it, given different services, were provided together, and one serves them all. Use separate implementations for separate services.
- A job or an agent beside `HttpRouter.serve` reads other state than the routes, or its builder runs twice: its `layer` builds in another layer graph than the routes. Put it inside the layer the server serves, or provide `Action.layer` and the services they share above both ([Action.md](Action-in-process.md#share-one-build-across-servers)).
