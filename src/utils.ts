import { I8Cell, I8Script, type I8Header } from "./cell.js";
import type { Cell, Script } from "@ckb-lumos/base";
import {
  parseAbsoluteEpochSince,
  parseEpoch,
  type EpochSinceValue,
} from "@ckb-lumos/base/lib/since.js";

//CKB is one ckb expressed in shannons
export const CKB = 100000000n;

export function hex(n: number | bigint) {
  return "0x" + n.toString(16);
}

export function max<T>(...numbers: T[]) {
  return numbers.reduce((a, b) => (a > b ? a : b));
}

export function min<T>(...numbers: T[]) {
  return numbers.reduce((a, b) => (a < b ? a : b));
}

export function lockExpanderFrom(s: I8Script) {
  return (c: Cell) => (scriptEq(c.cellOutput.lock, s) ? s : undefined);
}

export function capacitySifter(
  inputs: readonly Cell[],
  lockExpander: (c: Cell) => I8Script | undefined,
) {
  const capacities: I8Cell[] = [];
  const notCapacities: Cell[] = [];

  for (const c of inputs) {
    if (c.cellOutput.type !== undefined || c.data !== "0x") {
      notCapacities.push(c);
      continue;
    }

    const lock = lockExpander(c);
    if (!lock) {
      notCapacities.push(c);
      continue;
    }

    capacities.push(
      I8Cell.from({
        ...c,
        cellOutput: {
          lock,
          capacity: c.cellOutput.capacity,
        },
      }),
    );
  }

  return { capacities, notCapacities };
}

export function typeSifter(
  inputs: readonly Cell[],
  type: I8Script,
  lockExpander: (c: Cell) => I8Script | undefined,
) {
  const types: I8Cell[] = [];
  const notTypes: Cell[] = [];

  for (const c of inputs) {
    if (!scriptEq(c.cellOutput.type, type)) {
      notTypes.push(c);
      continue;
    }

    const lock = lockExpander(c);
    if (!lock) {
      notTypes.push(c);
      continue;
    }

    types.push(
      I8Cell.from({
        ...c,
        cellOutput: {
          lock,
          type: type,
          capacity: c.cellOutput.capacity,
        },
      }),
    );
  }

  return { types, notTypes };
}

export function simpleSifter(
  inputs: readonly Cell[],
  type: I8Script,
  accountLockExpander: (c: Cell) => I8Script | undefined,
) {
  const { capacities, notCapacities } = capacitySifter(
    inputs,
    accountLockExpander,
  );
  const { types, notTypes } = typeSifter(
    notCapacities,
    type,
    accountLockExpander,
  );

  return {
    capacities,
    types,
    notSimples: notTypes,
  };
}

export function maturityDiscriminator<T>(
  tt: readonly Readonly<T>[],
  sinceOf: (t: T) => string,
  tipHeader: I8Header,
) {
  const tipEpoch = parseEpoch(tipHeader.epoch);
  const mature: Readonly<T>[] = [];
  const notMature: Readonly<T>[] = [];
  for (const t of tt) {
    const c = epochSinceCompare(tipEpoch, parseAbsoluteEpochSince(sinceOf(t)));
    if (c >= 0) {
      mature.push(t);
    } else {
      notMature.push(t);
    }
  }
  return { mature, notMature };
}

export const errorBothScriptUndefined =
  "Comparing two Scripts that both are undefined";
export function scriptEq(s0: Script | undefined, s1: Script | undefined) {
  if (!s0 && !s1) {
    throw Error(errorBothScriptUndefined);
  }
  if (!s0 || !s1) {
    return false;
  }
  return (
    s0.codeHash === s1.codeHash &&
    s0.hashType === s1.hashType &&
    s0.args === s1.args
  );
}

export function epochSinceCompare(
  e0: EpochSinceValue,
  e1: EpochSinceValue,
): 1 | 0 | -1 {
  if (e0.number < e1.number) {
    return -1;
  }
  if (e0.number > e1.number) {
    return 1;
  }

  const v0 = e0.index * e1.length;
  const v1 = e1.index * e0.length;
  if (v0 < v1) {
    return -1;
  }
  if (v0 > v1) {
    return 1;
  }

  return 0;
}

const errorZeroEpochLength = "Zero EpochSinceValue length";
export function epochSinceAdd(
  e: EpochSinceValue,
  delta: EpochSinceValue,
): EpochSinceValue {
  if (e.length === 0 || delta.length === 0) {
    throw Error(errorZeroEpochLength);
  }
  if (e.length !== delta.length) {
    delta = {
      length: e.length,
      index: Math.ceil((delta.index * e.length) / delta.length),
      number: delta.number,
    };
  }

  const rawIndex = e.index + delta.index;

  const length = e.length;
  const index = rawIndex % length;
  const number = e.number + (rawIndex - index) / length;

  return { length, index, number };
}

export function logSplit<T>(array: readonly T[]) {
  const splits: T[][] = [];

  while (array.length > 0) {
    const half = Math.floor(array.length / 2);
    splits.push(array.slice(half));
    array = array.slice(0, half);
  }

  return splits;
}

// Durstenfeld shuffle, see https://en.wikipedia.org/wiki/Fisher%E2%80%93Yates_shuffle
export function shuffle<T>(a: readonly T[]) {
  const array = [...a];
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// BinarySearch is translated from https://go.dev/src/sort/search.go, credits to the respective authors.

// BinarySearch uses binary search to find and return the smallest index i
// in [0, n) at which f(i) is true, assuming that on the range [0, n),
// f(i) == true implies f(i+1) == true. That is, Search requires that
// f is false for some (possibly empty) prefix of the input range [0, n)
// and then true for the (possibly empty) remainder; Search returns
// the first true index. If there is no such index, Search returns n.
// Search calls f(i) only for i in the range [0, n).
export function binarySearch(n: number, f: (i: number) => boolean): number {
  // Define f(-1) == false and f(n) == true.
  // Invariant: f(i-1) == false, f(j) == true.
  let [i, j] = [0, n];
  while (i < j) {
    const h = Math.trunc((i + j) / 2);
    // i ≤ h < j
    if (!f(h)) {
      i = h + 1; // preserves f(i-1) == false
    } else {
      j = h; // preserves f(j) == true
    }
  }
  // i == j, f(i-1) == false, and f(j) (= f(i)) == true  =>  answer is i.
  return i;
}
