import { List } from "immutable";
import { Cell, Hexadecimal, PackedSince } from "@ckb-lumos/base";
import { BI, BIish } from "@ckb-lumos/bi";
import { TransactionSkeletonType } from "@ckb-lumos/helpers";
import { defaultScript } from "./config";
import { hexify } from "@ckb-lumos/codec/lib/bytes";
import { Uint64 } from "@ckb-lumos/codec/lib/number/uint";
import { EpochSinceValue, generateHeaderEpoch, parseAbsoluteEpochSince, parseEpoch } from "@ckb-lumos/base/lib/since";
import {
    calculateDaoEarliestSinceCompatible,
    calculateMaximumWithdrawCompatible
} from "@ckb-lumos/common-scripts/lib/dao";
import { epochSinceAdd, epochSinceCompare, I8Cell, I8Script, I8HeaderFrom, I8Header, I8CellFrom, scriptEq } from "./cell";
import { addCells, addHeaderDeps, calculateFee, txSize } from "./transaction";

export const errorUndefinedBlockNumber = "Encountered an input cell with blockNumber undefined";
export function daoSifter(inputs: List<I8Cell>, getHeader: (blockNumber: string, context: I8Cell) => I8Header) {
    let deposits: typeof inputs = List();
    let withdrawalRequests: typeof inputs = List();
    let unknowns: typeof inputs = List();

    const deps = defaultScript("DAO").cellDeps;
    const extendCell = (c: I8Cell, header: I8Header, oldHeader?: I8Header, since?: PackedSince) =>
        c.set("blockHash", header.hash).update("type",
            type => type!.update("headerDeps", hh => oldHeader ? hh.push(header, oldHeader) : hh.push(header))
                .set("cellDeps", deps)
                .set("since", since)
        );

    for (const c of inputs) {
        if (!isDao(c)) {
            unknowns = unknowns.push(c);
            continue;
        }

        if (!c.blockNumber) {
            throw Error(errorUndefinedBlockNumber);
        }

        const h = getHeader(c.blockNumber!, c);
        if (c.data === DEPOSIT_DATA) {
            deposits = deposits.push(extendCell(c, h));
        } else {
            const h1 = getHeader(Uint64.unpack(c.data).toHexString(), c);
            let since: PackedSince | undefined;
            const dummyEpoch = I8HeaderFrom().epoch;
            if (h.epoch !== dummyEpoch && h1.epoch !== dummyEpoch) {
                since = calculateDaoEarliestSinceCompatible(h1.epoch, h.epoch).toString();
            }
            withdrawalRequests = withdrawalRequests.push(extendCell(c, h, h1, since));
        }
    }

    return { deposits, withdrawalRequests, unknowns };
}

export const DEPOSIT_DATA = "0x0000000000000000";

export function isDao(c: Cell) {
    return scriptEq(c.cellOutput.type, defaultScript("DAO"));
}

export function isDaoDeposit(c: Cell) {
    return isDao(c) && c.data === DEPOSIT_DATA;
}

export function isDaoWithdrawal(c: Cell) {
    return isDao(c) && c.data !== DEPOSIT_DATA;
}

export function deposit(tx: TransactionSkeletonType, accountLock: I8Script, capacities: BI[]): TransactionSkeletonType {
    const baseDeposit = I8CellFrom({
        lock: accountLock,
        type: defaultScript("DAO"),
        data: DEPOSIT_DATA,
    });

    const deposits = List(capacities.map((c) => baseDeposit.update("capacity", _ => c.toHexString())));

    return addCells(tx, "append", List(), deposits);
}

export const errorDifferentSizeLock = "Withdrawal request lock has different size";
export function requestWithdrawalFrom(
    tx: TransactionSkeletonType,
    accountLock: I8Script,
    ...deposits: I8Cell[]
): TransactionSkeletonType {
    const withdrawalRequests = deposits.map((d) => {
        if (d.lock.args.length != accountLock.args.length) { throw Error(errorDifferentSizeLock); }
        return I8CellFrom({
            capacity: d.capacity,
            lock: d.lock,
            type: d.type,
            data: hexify(Uint64.pack(BI.from(d.blockNumber!))),
        });
    })

    return addCells(tx, "matched", List(deposits), List(withdrawalRequests));
}

export function withdrawFrom(tx: TransactionSkeletonType, ...withdrawalRequests: I8Cell[]): TransactionSkeletonType {
    const headerHashes: Hexadecimal[] = [];
    for (let r of withdrawalRequests) {
        headerHashes.push(...r.type!.headerDeps.map(h => h.hash));
    }
    tx = addHeaderDeps(tx, ...headerHashes);

    let processedRequests: List<I8Cell> = List();
    const header2index = new Map(tx.headerDeps.map((h, i) => [h, i]));
    for (let r of withdrawalRequests) {
        const depositHeader = r.type!.headerDeps.last()!;
        const w = hexify(Uint64.pack(header2index.get(depositHeader.hash)!));
        processedRequests = processedRequests.push(
            r.update("type", t => t!.set("witness", w))
        );
    }

    return addCells(tx, "append", processedRequests, List());
}

export const errorNotEnoughFunds = "Not enough funds to execute the transaction";
export function fund(
    tx: TransactionSkeletonType,
    accountLock: I8Script,
    feeRate: BIish,
    withdrawalRequests: List<I8Cell>,
    capacities: List<I8Cell>) {
    let changeCell = I8CellFrom({ lock: accountLock });
    for (const addFunds of [
        ...withdrawalRequests.map(wr => (tx: TransactionSkeletonType) => withdrawFrom(tx, wr)),
        ...capacities.map(c => (tx: TransactionSkeletonType) => addCells(tx, "append", List([c]), List()))
    ]) {
        //Add funding cells
        tx = addFunds(tx);
        const delta = ckbDelta(tx, feeRate);
        if (delta.gte(changeCell.cellOutput.capacity)) {
            //Add change cell
            changeCell = changeCell.set("capacity", delta.toHexString());
            return addCells(tx, "append", List(), List([changeCell]));
        }
    }

    throw Error(errorNotEnoughFunds);
}

export function ckbDelta(tx: TransactionSkeletonType, feeRate: BIish) {
    let ckbDelta = BI.from(0);
    for (const c of tx.inputs) {
        //Second Withdrawal step from NervosDAO
        if (isDaoWithdrawal(c)) {
            const withdrawalRequest = c as I8Cell;
            const [withdrawalHeader, depositHeader] = withdrawalRequest.type!.headerDeps;
            const maxWithdrawable = calculateMaximumWithdrawCompatible(c, depositHeader.dao, withdrawalHeader.dao);
            ckbDelta = ckbDelta.add(maxWithdrawable);
        } else {
            ckbDelta = ckbDelta.add(c.cellOutput.capacity);
        }
    }

    tx.inputs.forEach((c) => ckbDelta = ckbDelta.sub(c.cellOutput.capacity));

    if (BI.from(feeRate).gt(0)) {
        ckbDelta.sub(calculateFee(txSize(tx), feeRate));
    }

    return ckbDelta;
}

export function requestWithdrawalWith(
    tx: TransactionSkeletonType,
    accountLock: I8Script,
    deposits: List<I8Cell>,
    maxWithdrawalAmount: BI,
    tipEpoch: EpochSinceValue,
    minLock: EpochSinceValue = { length: 4, index: 1, number: 0 },// 1/4 epoch (~ 1 hour)
    maxLock: EpochSinceValue = { length: 1, index: 0, number: 1 }// 1 epoch (~ 4 hours)
) {
    //Let's fast forward the tip header of minLock epoch to avoid withdrawals having to wait one more month
    const withdrawalRequestEpoch = epochSinceAdd(tipEpoch, minLock);
    const maxWithdrawalEpoch = epochSinceAdd(tipEpoch, maxLock);

    //Filter deposits as requested and sort by minimum withdrawal epoch
    deposits = deposits.filter(d => maxWithdrawalAmount.gte(d.cellOutput.capacity))
        .map(d => Object.freeze({ cell: d, withdrawalEpoch: withdrawalEpoch(d, withdrawalRequestEpoch) }))
        .filter(d => epochSinceCompare(d.withdrawalEpoch, maxWithdrawalEpoch) <= 0)
        .sort((a, b) => epochSinceCompare(a.withdrawalEpoch, b.withdrawalEpoch))
        .map(d => d.cell);

    //It does NOT attempt to solve the Knapsack problem, it just withdraw the earliest deposits under budget
    let withdrawalAmount = BI.from(0);
    const optimalDeposits: I8Cell[] = []
    for (const d of deposits) {
        const newWithdrawalAmount = withdrawalAmount.add(d.cellOutput.capacity);
        if (maxWithdrawalAmount.lte(newWithdrawalAmount)) {
            withdrawalAmount = newWithdrawalAmount;
            optimalDeposits.push(d);
        } else {
            break;
        }
    }

    if (optimalDeposits.length > 0) {
        tx = requestWithdrawalFrom(tx, accountLock, ...optimalDeposits);
    }

    return tx;
}

export const errorTooManyOutputs = "A transaction containing Nervos DAO script is currently limited to 64 output cells"
export const errorIOBalancing = "The transaction doesn't correctly even out input and output capacities";
export const errorLateWithdrawal = "The transaction includes some deposits whose minimum withdrawal epoch is after the maxLock epoch";
export function daoPreSendChecks(
    tx: TransactionSkeletonType,
    feeRate: BIish,
    tipEpoch: EpochSinceValue,
    minLock: EpochSinceValue = { length: 8, index: 1, number: 0 },// 1/8 epoch (~ 30 minutes)
    maxLock: EpochSinceValue = { length: 1, index: 0, number: 2 }// 2 epoch (~ 8 hours)
) {
    if ([...tx.inputs, ...tx.outputs].some(c => isDao(c)) && tx.outputs.size > 64) {
        throw Error(errorTooManyOutputs);
    }

    if (!ckbDelta(tx, feeRate).eq(0)) {
        throw Error(errorIOBalancing);
    }

    //Let's fast forward the tip header of minLock epoch to avoid withdrawals having to wait one more month
    const withdrawalRequestEpoch = epochSinceAdd(tipEpoch, minLock);
    const maxWithdrawalEpoch = epochSinceAdd(tipEpoch, maxLock);

    tx.inputs.filter(isDaoWithdrawal)
        .map(d => Object.freeze({ cell: d, withdrawalEpoch: withdrawalEpoch(d as I8Cell, withdrawalRequestEpoch) }))
        .filter(d => epochSinceCompare(d.withdrawalEpoch, maxWithdrawalEpoch) === 1)
        .forEach(_ => { throw Error(errorLateWithdrawal); })

    return tx;
}

export function withdrawalEpoch(deposit: I8Cell, withdrawalRequestEpoch: EpochSinceValue) {
    //Let's fast forward the tip header of slack epoch to avoid withdrawals having to wait one more month
    const withdrawalRequestEpochString = generateHeaderEpoch(withdrawalRequestEpoch);
    const depositEpoch = deposit.type!.headerDeps.get(0)!.epoch;
    return parseAbsoluteEpochSince(
        calculateDaoEarliestSinceCompatible(depositEpoch, withdrawalRequestEpochString).toHexString()
    );
}