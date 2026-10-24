type PresentFacts<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Projects validated wire facts to exact optional owner inputs; null and nested JSON remain unchanged. */
export function presentControlFacts<const T extends object>(input: T): PresentFacts<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as PresentFacts<T>;
}
