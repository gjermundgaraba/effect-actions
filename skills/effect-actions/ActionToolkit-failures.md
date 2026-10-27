# ActionToolkit failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message. The tasks are in [ActionToolkit.md](ActionToolkit.md).

- `Type 'X' is not assignable to type 'never'` where a turn or a call by hand runs, or `Service not found` in plain JavaScript: a request service, the caller first, is provided around the whole turn or call effect, never to the stream alone or to `layer`; a startup service's Layer is provided to `layer`.
- A returned failure whose `result` is an `AiError` with reason `ToolParameterValidationError` (`failureOrigin: "parameters"`), not a declared error: the arguments did not decode, and neither `authorize` nor the handler ran.
- A turn fails with an `AiError`, `Failed to encode result for tool '<name>'`: the handler's success does not encode, such as `Infinity` for a `Schema.Finite`.
- `TypeError: Cannot read properties of undefined (reading 'context')` when a tool handles a call: the `layer` provided is another implementation's, with tools of the same names, which the types accept. Provide the `layer` that `make` returned with the `toolkit`.
