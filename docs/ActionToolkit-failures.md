# ActionToolkit failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [ActionToolkit.md](ActionToolkit.md).

- An approved call never runs, and nothing is raised: a `tool-approval-response` finds its request by `approvalId` in the prompt history, and was sent without it. Use a `Chat`, or resend the assistant message holding the call and its request before the response.
- `Type 'X' is not assignable to type 'never'` where a turn or a call by hand runs, or `Service not found` in plain JavaScript: a request service is provided around the turn, or around the whole call effect, not to the stream alone, and a protected tool owes its identity whatever its handler reads. A startup service's Layer is provided to `layer`.
- A returned failure whose `result` is an `AiError` with reason `ToolParameterValidationError` (`failureOrigin: "parameters"`), not a declared error: the arguments did not decode. Neither `authorize` nor the handler ran.
- A call dies with the handler's failure and a `SchemaError` beside it: the handler failed with an error its action does not declare, which a cast or plain JavaScript lets through. Declare it on the action.
- A turn fails with an `AiError`, `Failed to encode result for tool '<name>'`: the handler's success does not encode, such as `Infinity` for a `Schema.Finite`.
- A model reads base64 text where an image was meant: a tool's success holds an `Action.Image`, which a Toolkit gives the model as JSON text. Leave the action out of `actions`, or serve it over MCP, which sends an image block ([ActionMcp.md](ActionMcp.md#return-images-and-other-media)).
- `Listed in actions, but no implementation holds it: <names>` thrown at `make`: those actions are not the implementations', by identity. `(another contract)` marks one whose name an implementation holds, as a second copy of the contracts module makes. Pass the implementation holding the action, or list the contract it implements.
- `Duplicate tool: <name>` thrown at `make`: two implementations serve actions of one name. Rename one action; of two implementations of one contract, pass one.
- A defect when a tool handles a call: the `layer` provided is another implementation's, with tools of the same names, which the types accept. Provide the `layer` that `make` returned with the `toolkit`.
- Two toolkits of one implementation answer with one set of startup services: their `layer`s, given different services, were provided together, and one serves both. Use separate implementations for separate services.
- A job or an agent beside `HttpRouter.serve` reads other state than the routes, or its builder runs twice: the toolkit's `layer` builds in another layer graph than the routes. Provide that `layer` inside the layer the server serves, or `Action.layer` and the services they share above both ([Action-in-process.md](Action-in-process.md#share-one-build-across-servers)).
