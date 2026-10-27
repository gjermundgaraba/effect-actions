/**
 * The text a match holds in the named group `name`, which its pattern captures in every match:
 * a pattern that lacks the group fails the test naming it, rather than reading as empty.
 */
export const captured = (match: RegExpExecArray, name: string): string => {
  const text = match.groups?.[name];

  if (text === undefined) {
    throw new Error(`No group named ${name} in the match ${match[0]}`);
  }

  return text;
};
