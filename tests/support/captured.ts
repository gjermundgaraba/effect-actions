export const captured = (match: RegExpExecArray, name: string): string => {
  const text = match.groups?.[name];

  if (text === undefined) {
    throw new Error(`No group named ${name} in the match ${match[0]}`);
  }

  return text;
};
