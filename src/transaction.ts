import { CellDep, Hash, Header, Hexadecimal, PackedSince, Transaction, TxStatus } from "@ckb-lumos/base";
import { BI, BIish } from "@ckb-lumos/bi";
import { TransactionSkeletonType, createTransactionFromSkeleton } from "@ckb-lumos/helpers";
import { Map as ImmutableMap, List, Record } from "immutable";
import { epochSinceCompare, I8Cell } from "./cell";
import { bytes } from "@ckb-lumos/codec";
import { parseAbsoluteEpochSince } from "@ckb-lumos/base/lib/since";
import { Transaction as TransactionCodec, WitnessArgs } from "@ckb-lumos/base/lib/blockchain";
import { hexify } from "@ckb-lumos/codec/lib/bytes";

export const errorDifferentIOFixedEntries = "Unable to modify entries without messing up fixed entries";
export const errorDifferentIOLength = "Input and output have different length";
export const errorNotEmptySigningEntries = "Signing Entries are not empty"
export function addCells(
    tx: TransactionSkeletonType,
    mode: "matched" | "append",
    inputs: List<I8Cell>,
    outputs: List<I8Cell>,
): TransactionSkeletonType {
    const fixedEntries = parseFixedEntries(tx);

    if (mode === "matched") {
        //Check if it's safe to add same index cells
        if (inputs.size !== outputs.size) {
            throw Error(errorDifferentIOLength);
        }
        if (fixedEntries.inputs !== fixedEntries.outputs) {
            throw Error(errorDifferentIOFixedEntries);
        }
        if (tx.signingEntries.size > 0) {
            throw Error(errorNotEmptySigningEntries);
        }
    }

    const fix = mode == "matched";
    const inputSplicingIndex = fix ? fixedEntries.inputs + 1 : tx.inputs.size;
    const outputSplicingIndex = fix ? fixedEntries.outputs + 1 : tx.outputs.size;

    //Add all the ancillary to the cells
    tx = addCellDepsFrom(tx, inputs, outputs);
    tx = addHeaderDepsFrom(tx, inputs, outputs);
    tx = addSincesFrom(tx, inputSplicingIndex, inputs);
    tx = addWitnessesFrom(tx, inputSplicingIndex, inputs, outputSplicingIndex, outputs);

    //Add the cells themselves
    tx = tx.update("inputs", i => i.splice(inputSplicingIndex, 0, ...inputs));
    tx = tx.update("outputs", o => o.splice(outputSplicingIndex, 0, ...outputs));

    if (fix) {
        tx = addFixedEntries(tx,
            { field: "inputs", index: fixedEntries.inputs + inputs.size },
            { field: "outputs", index: fixedEntries.outputs + outputs.size });
    }

    return tx;
}

const witnessPadding = hexify(WitnessArgs.pack({ lock: "0x" }));
function addWitnessesFrom(
    tx: TransactionSkeletonType,
    inputSplicingIndex: number,
    inputs: List<I8Cell>,
    outputSplicingIndex: number,
    outputs: List<I8Cell>
) {
    //Unfold witnesses
    let witnessesLength = [tx.inputs.size, tx.outputs.size, tx.witnesses.size, inputSplicingIndex, outputSplicingIndex]
        .reduce((a, b) => a > b ? a : b);
    let lockWs: (string)[] = [];
    let inputTypeWs: (string | undefined)[] = [];
    let outputTypeWs: (string | undefined)[] = [];
    for (let i = 0; i < witnessesLength; i++) {
        const { lock, inputType, outputType } = WitnessArgs.unpack(tx.witnesses.get(i, witnessPadding));
        lockWs.push(lock ?? "0x");
        inputTypeWs.push(inputType);
        outputTypeWs.push(outputType);
    }

    //Add new witnesses
    lockWs.splice(inputSplicingIndex, 0, ...inputs.map(c => c.lock.witness ?? "0x"));
    inputTypeWs.splice(inputSplicingIndex, 0, ...inputs.map(c => c.type?.witness));
    outputTypeWs.splice(outputSplicingIndex, 0, ...outputs.map(c => c.type?.witness));

    //Fold witnesses
    witnessesLength = inputTypeWs.length > outputTypeWs.length ? inputTypeWs.length : outputTypeWs.length;
    let witnesses: string[] = [];
    for (let i = 0; i < witnessesLength; i++) {
        witnesses.push(bytes.hexify(WitnessArgs.pack({
            lock: lockWs.at(i) ?? "0x",
            inputType: inputTypeWs.at(i),
            outputType: outputTypeWs.at(i),
        })));
    }

    //Trim padding at the end
    while (witnesses.at(-1) === witnessPadding) {
        witnesses.pop();
    }

    return tx.set("witnesses", List(witnesses));
}

function addSincesFrom(
    tx: TransactionSkeletonType,
    inputSplicingIndex: number,
    inputs: List<I8Cell>
) {
    // Convert tx.inputSinces to sinces
    let sinces = Array.from({ length: tx.inputs.size }, (_, index) => tx.inputSinces.get(index, ""));//"" for no since

    // Convert cells to their sinces
    let newSinces: PackedSince[] = [];
    for (const c of inputs) {
        const lockSince = c.lock.since;
        const typeSince = c.type?.since;
        if (lockSince === undefined || typeSince === undefined || lockSince === typeSince) {
            newSinces.push(lockSince ?? typeSince ?? "");//"" for no since
        } else if (epochSinceCompare(parseAbsoluteEpochSince(lockSince), parseAbsoluteEpochSince(typeSince)) == -1) {
            newSinces.push(typeSince);
        } else {
            newSinces.push(lockSince);
        }
    }

    //Insert newSinces in the correct location
    sinces.splice(inputSplicingIndex, 0, ...newSinces);

    return tx.set("inputSinces", ImmutableMap(sinces
        .map((since, index) => [index, since] as [number, string])
        .filter(([_, since]) => since !== "")));
}


function addHeaderDepsFrom(tx: TransactionSkeletonType, inputs: List<I8Cell>, outputs: List<I8Cell>) {
    const headerDeps: Header[] = [];

    for (const c of inputs) {
        const lock = c.lock;
        headerDeps.push(...lock.headerDeps);
    }
    for (const c of [...inputs, ...outputs]) {
        const type = c.type;
        if (type === undefined) {
            continue;
        }
        headerDeps.push(...type.headerDeps);
    }

    return addHeaderDeps(tx, ...headerDeps.map(h => h.hash));
}

export function addHeaderDeps(tx: TransactionSkeletonType, ...headers: Hexadecimal[]) {
    const fixedEntries = parseFixedEntries(tx);
    let headerDeps = tx.headerDeps.push(...headers);
    //Use a Set (preserving order) to remove duplicates
    headerDeps = List(new Set(headerDeps));
    tx = addFixedEntries(tx, { field: "headerDeps", index: headerDeps.size - 1 });
    return tx.set("headerDeps", headerDeps);
}

function addCellDepsFrom(tx: TransactionSkeletonType, inputs: List<I8Cell>, outputs: List<I8Cell>) {
    const cellDeps: CellDep[] = [];

    for (const c of inputs) {
        const lock = c.lock;
        cellDeps.push(...lock.cellDeps);
    }
    for (const c of [...inputs, ...outputs]) {
        const type = c.type;
        if (type === undefined) {
            continue;
        }
        cellDeps.push(...type.cellDeps);
    }

    return addCellDeps(tx, ...cellDeps);
}

const serializeCellDep = (d: CellDep) => `${d.outPoint.txHash}-${d.outPoint.index}-${d.depType}`;
export function addCellDeps(tx: TransactionSkeletonType, ...deps: CellDep[]) {
    const fixedEntries = parseFixedEntries(tx);
    let cellDeps = tx.cellDeps.push(...deps);
    //Use a Map (preserving order) to remove duplicates
    cellDeps = List(new Map(cellDeps.map(d => [serializeCellDep(d), d])).values());
    tx = addFixedEntries(tx, { field: "cellDeps", index: cellDeps.size - 1 });
    return tx.set("cellDeps", cellDeps);
}

export function addFixedEntries(tx: TransactionSkeletonType, ...entries: I8AFixedEntriable[]) {
    const parsed = parseFixedEntries(tx.update("fixedEntries", e => e.push(...entries)))
    const fixedEntries = List([...parsed].filter(([_, index]) => index >= 0)
        .map(([field, index]) => I8AFixedEntryFrom({ field, index })));
    return tx.set("fixedEntries", fixedEntries);
}

export function parseFixedEntries(tx: TransactionSkeletonType) {
    const entriesObject = Object.fromEntries(
        tx.fixedEntries.sort((a, b) => a.index - b.index)
            .map(e => [e.field, e.index])
    );
    return I8FixedEntriesFrom(entriesObject);
}

export function txSize(transaction: TransactionSkeletonType) {
    const serializedTx = TransactionCodec.pack(createTransactionFromSkeleton(transaction));
    // 4 is serialized offset bytesize;
    return serializedTx.byteLength + 4;
}

export function calculateFee(size: number, feeRate: BIish): BI {
    const ratio = BI.from(1000);
    const base = BI.from(size).mul(feeRate);
    const fee = base.div(ratio);
    if (fee.mul(ratio).lt(base)) {
        return fee.add(1);
    }
    return fee;
}

export const errorUnexpectedTxState = "Unexpected transaction state";
export const errorTimeOut = "Transaction timed out";
export async function sendAndWaitForTransaction(
    signedTransaction: Transaction,
    send: (tx: Transaction) => Promise<Hash>,
    getStatus: (txHash: Hash) => Promise<"pending" | "proposed" | "committed" | "unknown" | "rejected">,
    secondsTimeout: number = 600
) {
    //Send the transaction
    const txHash = await send(signedTransaction);

    //Wait until the transaction is committed or time out the timeout
    for (let i = 0; i < secondsTimeout; i++) {
        let status = await getStatus(txHash);
        switch (status) {
            case "committed":
                return txHash;
            case "pending":
            case "proposed":
                await new Promise(r => setTimeout(r, 1000));
                break;
            // case "rejected":
            // case "unknown":
            default:
                throw Error(errorUnexpectedTxState);
        }
    }

    throw Error(errorTimeOut);
}

//Declarations of immutable data structures

export interface I8FixedEntriable {
    cellDeps: number;
    headerDeps: number;
    inputs: number;
    outputs: number;
}
export type I8FixedEntries = Record<I8FixedEntriable> & Readonly<I8FixedEntriable>;
export const I8FixedEntriesFrom = Record<I8FixedEntriable>({
    cellDeps: -1,
    headerDeps: -1,
    inputs: -1,
    outputs: -1,
});

export interface I8AFixedEntriable {
    field: string;
    index: number;
}
export type I8AFixedEntry = Record<I8AFixedEntriable> & Readonly<I8AFixedEntriable>;
export const I8AFixedEntryFrom = Record<I8AFixedEntriable>({
    field: "fixedEntries",
    index: -1
});