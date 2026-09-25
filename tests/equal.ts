/** `true` exactly when `Left` and `Right` are the same type, not merely assignable. */
export type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
