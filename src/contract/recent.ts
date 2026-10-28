export interface Recent {
  readonly has: (id: string) => boolean;
  readonly add: (id: string) => void;
}

export const makeRecent = (size: number): Recent => {
  const ids = new Set<string>();

  return {
    has: (id) => ids.has(id),
    add: (id) => {
      ids.add(id);

      if (ids.size > size) {
        ids.delete(ids.values().next().value ?? id);
      }
    },
  };
};
