export function objectKeys<T extends object>(obj: T): Array<keyof T> {
  return Object.keys(obj) as Array<keyof T>;
}

export function objectEntries<T extends object>(
  obj: T,
): Array<[keyof T, T[keyof T]]> {
  return Object.entries(obj) as Array<[keyof T, T[keyof T]]>;
}

export function objectMap<T extends object, U>(
  obj: T,
  fn: (value: T[keyof T], key: keyof T) => U,
): Record<keyof T, U> {
  return objectKeys(obj).reduce(
    (acc, key) => {
      acc[key] = fn(obj[key], key);
      return acc;
    },
    {} as Record<keyof T, U>,
  );
}

export function pick<T extends object, K extends keyof T>(
  obj: T,
  keys: K[],
): Pick<T, K> {
  return keys.reduce(
    (acc, key) => {
      acc[key] = obj[key];
      return acc;
    },
    {} as Pick<T, K>,
  );
}

export function grouped<T, K extends string = string>(
  arr: ReadonlyArray<T>,
  getKey: (item: T) => K,
): [K, T[]][] {
  return objectEntries(
    arr.reduce(
      (acc, item) => {
        const key = getKey(item);
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(item);
        return acc;
      },
      {} as Record<K, T[]>,
    ),
  );
}

/** Deep partial type for nested config overrides */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/** Check if a value is a plain object (not an array or class instance) */
function isPlainObject(value: unknown): value is object {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.constructor === Object
  );
}

/**
 * Deep merge two objects, with overrides taking precedence.
 * Only plain objects are recursively merged; arrays and class instances are replaced.
 */
export function deepMerge<T extends object>(
  base: T,
  overrides: DeepPartial<T>,
): T {
  const result = { ...base };
  for (const key in overrides) {
    const override = overrides[key];
    if (override !== undefined) {
      if (isPlainObject(override) && isPlainObject(base[key])) {
        result[key] = deepMerge(
          base[key] as object,
          override as DeepPartial<object>,
        ) as T[typeof key];
      } else {
        result[key] = override as T[typeof key];
      }
    }
  }
  return result;
}
export function getAllMethods(entity: object): string[] {
  const methods: string[] = [];
  let current = entity;

  // Traverse up the prototype chain
  while (
    current !== null &&
    current !== undefined &&
    current !== Object.prototype
  ) {
    // Get own property names of the current object
    const propertyNames = Object.getOwnPropertyNames(current);

    // Filter out non-function properties and already added methods
    for (const name of propertyNames as [keyof typeof current]) {
      // Access on entity and not currentObject because we're looking at prototypes
      if (typeof entity[name] === "function" && !methods.includes(name)) {
        methods.push(name);
      }
    }

    // Move up the prototype chain
    current = Object.getPrototypeOf(current);
  }

  return methods;
}
