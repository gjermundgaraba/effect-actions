export interface Recent {
  readonly has: (id: string) => boolean;
  readonly add: (id: string) => void;
}

const keptIds = 1000;

export const makeRecent = (): Recent => {
  const ids = new Set<string>();

  return {
    has: (id) => ids.has(id),
    add: (id) => {
      ids.add(id);

      if (ids.size > keptIds) {
        ids.delete(ids.values().next().value ?? id);
      }
    },
  };
};
