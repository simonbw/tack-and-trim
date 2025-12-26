export function identity<T>(a: T): T {
  return a;
}

export function last<T>(a: T[]): T {
  return a[a.length - 1];
}

export function pairs<T>(arr: T[]): [T, T][] {
  const result: [T, T][] = [];
  for (let i = 0; i < arr.length - 1; i++) {
    result.push([arr[i], arr[i + 1]]);
  }
  return result;
}

export function range(n: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < n; i++) {
    result.push(i);
  }
  return result;
}
