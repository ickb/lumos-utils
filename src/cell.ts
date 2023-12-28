import { Hash, Header, HexNumber, HexString, Script, OutPoint, PackedSince, Cell, DepType } from "@ckb-lumos/base";
import { List, Record } from "immutable";
import { BI } from "@ckb-lumos/bi";
import { defaultScript } from "./config";
import { DEPOSIT_DATA } from "./dao";
import { minimalCellCapacityCompatible } from "@ckb-lumos/helpers";
import { EpochSinceValue } from "@ckb-lumos/base/lib/since";
import { CellOutput } from "@ckb-lumos/ckb-indexer/lib/indexerType";

export function I8Cellify(...cells: Cell[]): List<I8Cell> {
    let extCells = List<I8Cell>();
    for (const c of cells) {
        const o = c.cellOutput;
        const capacity = o.capacity;
        const lock = I8ScriptFrom(o.lock);
        const type = o.type ? I8ScriptFrom(o.type) : undefined;
        const outPoint = c.outPoint ? I8OutPointFrom(c.outPoint) : undefined;
        const extCell = I8CellFrom({ ...c, capacity, lock, type, outPoint });
        extCells = extCells.push(extCell);
    }
    return extCells;
}

export const errorBothScriptUndefined = "Comparing two Scripts that both are undefined";
export function scriptEq(s0: Script | undefined, s1: Script | undefined) {
    if (!s0 && !s1) {
        throw Error(errorBothScriptUndefined);
    }
    if (!s0 || !s1) {
        return false;
    }
    return s0.codeHash === s1.codeHash &&
        s0.hashType === s1.hashType &&
        s0.args === s1.args;
}

export function scriptIs(s0: Script, name: string) {
    return scriptEq(s0, { ...defaultScript(name), args: s0.args });
}

export function epochSinceCompare(
    e0: EpochSinceValue,
    e1: EpochSinceValue
): 1 | 0 | -1 {
    if (e0.number < e1.number) {
        return -1;
    }
    if (e0.number > e1.number) {
        return 1;
    }

    const v0 = BI.from(e0.index).mul(e1.length);
    const v1 = BI.from(e1.index).mul(e0.length);
    if (v0.lt(v1)) {
        return -1;
    }
    if (v0.gt(v1)) {
        return 1;
    }

    return 0;
}

export function epochSinceAdd(e: EpochSinceValue, delta: EpochSinceValue): EpochSinceValue {
    if (e.length !== delta.length) {
        delta = {
            length: e.length,
            index: Math.ceil(delta.index * e.length / delta.length),
            number: delta.number
        };
    }

    const rawIndex = e.index + delta.index;

    const length = e.length;
    const index = rawIndex % length;
    const number = e.number + (rawIndex - index) / length;

    return { length, index, number };
}

export function isCapacity(c: Cell) {
    return c.cellOutput.type === undefined && c.data === "0x";
}

//Declarations of immutable data structures
const defaultHex = DEPOSIT_DATA;

export interface I8Scriptable extends Script {
    cellDeps: List<I8CellDep>;
    headerDeps: List<I8Header>;
    witness?: HexString;
    since?: PackedSince;
    //Extra information is an escape hatch for future uses
    extra?: unknown;
}
export type I8Script = Record<I8Scriptable> & Readonly<I8Scriptable>;
export const I8ScriptFrom = Record<I8Scriptable>({
    codeHash: defaultHex,
    hashType: "data",
    args: "0x",
    cellDeps: List(),
    headerDeps: List()
});

export interface I8OutPointable extends OutPoint { };
export type I8OutPoint = Record<I8OutPointable> & Readonly<I8OutPointable>;
export const I8OutPointFrom = Record<I8OutPointable>({
    txHash: defaultHex,
    index: defaultHex,
});

export interface I8Cellable {
    //cellOutput properties
    capacity: HexNumber;
    lock: I8Script;
    type?: I8Script;

    data: HexString;
    outPoint?: I8OutPoint;
    blockHash?: Hash;
    blockNumber?: HexNumber;
    txIndex?: HexNumber;
}
export type I8Cell = Record<I8Cellable> & Readonly<I8Cellable & { cellOutput: CellOutput }>;
class _I8Cell extends Record<I8Cellable>({
    capacity: "0x40",
    lock: I8ScriptFrom(),
    data: "0x"
}) implements Cell {
    get cellOutput(): Readonly<CellOutput> { return this; }
}
export function I8CellFrom(values?: Partial<I8Cellable> | Iterable<[string, unknown]>): I8Cell {
    let c: I8Cell = new _I8Cell(values);
    if (c.capacity === c.clear().capacity) {
        c = c.set("capacity", minimalCellCapacityCompatible(c, { validate: false }).toHexString())
    }
    return c;
}

export interface I8CellDepable {
    outPoint: I8OutPoint;
    depType: DepType;
}
export type I8CellDep = Record<I8CellDepable> & Readonly<I8CellDepable>;
export const I8CellDepFrom = Record<I8CellDepable>({
    outPoint: I8OutPointFrom(),
    depType: "code"
});

export interface I8Headerable extends Header { };
export type I8Header = Record<I8Headerable> & Readonly<I8Headerable>;
export const I8HeaderFrom = Record<I8Headerable>({
    timestamp: defaultHex,
    number: defaultHex,
    epoch: defaultHex,
    compactTarget: defaultHex,
    dao: defaultHex,
    hash: defaultHex,
    nonce: defaultHex,
    parentHash: defaultHex,
    proposalsHash: defaultHex,
    transactionsRoot: defaultHex,
    extraHash: defaultHex,
    version: defaultHex,
});