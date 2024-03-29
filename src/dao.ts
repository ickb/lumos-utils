import { Cell, Hexadecimal, PackedDao, PackedSince } from "@ckb-lumos/base";
import { BI, BIish } from "@ckb-lumos/bi";
import { TransactionSkeletonType } from "@ckb-lumos/helpers";
import { defaultScript } from "./config";
import { hexify } from "@ckb-lumos/codec/lib/bytes";
import { Uint64 } from "@ckb-lumos/codec/lib/number/uint";
import { EpochSinceValue, generateHeaderEpoch, parseAbsoluteEpochSince, parseEpoch } from "@ckb-lumos/base/lib/since";
import {
    calculateDaoEarliestSinceCompatible, calculateMaximumWithdrawCompatible
} from "@ckb-lumos/common-scripts/lib/dao";
import { I8Cell, I8Script, I8Header, headerDeps, since, witness } from "./cell";
import { addCells, addHeaderDeps, calculateFee, txSize } from "./transaction";
import { binarySearch, epochSinceAdd, epochSinceCompare, scriptEq } from "./utils";

const zero = BI.from(0);

export const errorUndefinedBlockNumber = "Encountered an input cell with blockNumber undefined";
export function daoSifter(
    inputs: readonly Cell[],
    accountLockExpander: (c: Cell) => I8Script | undefined,
    getHeader: (blockNumber: string, context: Cell) => I8Header
) {
    const deposits: I8Cell[] = [];
    const withdrawalRequests: I8Cell[] = [];
    const notDaos: Cell[] = [];

    const defaultDaoScript = defaultScript("DAO");
    const extendCell = (
        c: Cell,
        lock: I8Script,
        header: I8Header,
        previousHeader?: I8Header,
        packedSince?: PackedSince
    ) => I8Cell.from({
        ...c,
        cellOutput: {
            lock,
            type: I8Script.from({
                ...defaultDaoScript,
                [headerDeps]: previousHeader ? [header, previousHeader] : [header],
                [since]: packedSince ?? defaultDaoScript[since]
            }),
            capacity: c.cellOutput.capacity,
        },
        blockHash: header.hash,
    });

    for (const c of inputs) {
        const lock = accountLockExpander(c);
        if (!lock || !isDao(c)) {
            notDaos.push(c);
            continue;
        }

        if (!c.blockNumber) {
            throw Error(errorUndefinedBlockNumber);
        }

        const h = getHeader(c.blockNumber!, c);
        if (c.data === DEPOSIT_DATA) {
            deposits.push(extendCell(c, lock, h));
        } else {
            const h1 = getHeader(Uint64.unpack(c.data).toHexString(), c);
            const since = calculateDaoEarliestSinceCompatible(h1.epoch, h.epoch).toHexString();
            withdrawalRequests.push(extendCell(c, lock, h, h1, since));
        }
    }

    return { deposits, withdrawalRequests, notDaos };
}

export const DEPOSIT_DATA = "0x0000000000000000";

export function isDao(c: Cell) {
    return scriptEq(c.cellOutput.type, defaultScript("DAO"));
}

export function isDaoDeposit(c: Cell) {
    return isDao(c) && c.data === DEPOSIT_DATA;
}

export function isDaoWithdrawalRequest(c: Cell) {
    return isDao(c) && c.data !== DEPOSIT_DATA;
}

export function daoDeposit(
    tx: TransactionSkeletonType,
    capacities: readonly BI[],
    accountLock: I8Script
) {
    const baseDeposit = I8Cell.from({
        lock: accountLock,
        type: defaultScript("DAO"),
        data: DEPOSIT_DATA,
    });

    const deposits = capacities.map(c => I8Cell.from({ ...baseDeposit, capacity: c.toHexString() }));

    return addCells(tx, "append", [], deposits);
}

export const errorDifferentSizeLock = "Withdrawal request lock has different size";
export function daoRequestWithdrawalFrom(
    tx: TransactionSkeletonType,
    deposits: readonly I8Cell[],
    accountLock: I8Script
) {

    const withdrawalRequests: I8Cell[] = [];
    for (const d of deposits) {
        if (d.cellOutput.lock.args.length != accountLock.args.length) {
            throw Error(errorDifferentSizeLock);
        }

        withdrawalRequests.push(I8Cell.from({
            cellOutput: d.cellOutput,
            data: hexify(Uint64.pack(BI.from(d.blockNumber!))),
        }));
    }

    return addCells(tx, "matched", deposits, withdrawalRequests);
}

export function daoWithdrawFrom(tx: TransactionSkeletonType, withdrawalRequests: readonly I8Cell[]) {
    const headerHashes: Hexadecimal[] = [];
    for (const r of withdrawalRequests) {
        headerHashes.push(...r.cellOutput.type![headerDeps].map(h => h.hash));
    }
    tx = addHeaderDeps(tx, ...headerHashes);

    const processedRequests: I8Cell[] = [];
    const header2index = new Map(tx.headerDeps.map((h, i) => [h, i]));
    for (const r of withdrawalRequests) {
        const depositHeader = r.cellOutput.type![headerDeps].at(-1)!;
        processedRequests.push(I8Cell.from({
            ...r,
            type: I8Script.from({
                ...r.cellOutput.type!,
                [witness]: hexify(Uint64.pack(header2index.get(depositHeader.hash)!))
            })
        }));
    }

    return addCells(tx, "append", processedRequests, []);
}

export function daoRequestWithdrawalWith(
    tx: TransactionSkeletonType,
    deposits: readonly I8Cell[],
    accountLock: I8Script,
    tipHeader: I8Header,
    maxWithdrawalAmount: BI,
    maxWithdrawalCells: number = Number.POSITIVE_INFINITY,
    minLocking?: EpochSinceValue,
    additionalMaxLocking?: EpochSinceValue
) {
    let extendedDeposits = deposits
        .filter(d => maxWithdrawalAmount.gte(d.cellOutput.capacity))
        .map(d => Object.freeze({
            deposit: d,
            withdrawalAmount: withdrawalAmountEstimation(d, tipHeader.dao),
            withdrawalEpoch: { length: 1, index: 0, number: 0 },//Placeholder for type purposes
        }));

    if (minLocking) {
        //Let's fast forward the tip header of minLockingPeriod to avoid withdrawals having to wait 180 more epochs
        const withdrawalRequestEpoch = epochSinceAdd(parseEpoch(tipHeader.epoch), minLocking);
        extendedDeposits = extendedDeposits
            .filter(({ withdrawalAmount }) => maxWithdrawalAmount.gte(withdrawalAmount))
            .map(({ deposit, withdrawalAmount }) => Object.freeze({
                deposit,
                withdrawalAmount,
                withdrawalEpoch: withdrawalEpochEstimation(deposit, withdrawalRequestEpoch),
            }))
            .sort((a, b) => epochSinceCompare(a.withdrawalEpoch, b.withdrawalEpoch));

        if (additionalMaxLocking) {
            const maxWithdrawalEpoch = epochSinceAdd(withdrawalRequestEpoch, additionalMaxLocking);
            extendedDeposits = extendedDeposits
                .filter(d => epochSinceCompare(d.withdrawalEpoch, maxWithdrawalEpoch) <= 0);
        }
    }

    //This does NOT attempt to solve the Knapsack problem, it just withdraw the earliest deposits under budget
    let currentWithdrawalAmount = zero;
    const optimalDeposits: I8Cell[] = []
    for (const { deposit, withdrawalAmount } of extendedDeposits) {
        const newWithdrawalAmount = currentWithdrawalAmount.add(withdrawalAmount);
        if (newWithdrawalAmount.gt(maxWithdrawalAmount)) {
            continue;
        }
        currentWithdrawalAmount = newWithdrawalAmount;
        optimalDeposits.push(deposit);
        if (optimalDeposits.length >= maxWithdrawalCells) {
            break;
        }
    }

    if (optimalDeposits.length > 0) {
        tx = daoRequestWithdrawalFrom(tx, optimalDeposits, accountLock);
    }

    return tx;
}

export function withdrawalEpochEstimation(deposit: I8Cell, withdrawalRequestEpoch: EpochSinceValue) {
    const withdrawalRequestEpochString = generateHeaderEpoch(withdrawalRequestEpoch);
    const depositEpoch = deposit.cellOutput.type![headerDeps][0]!.epoch;
    return parseAbsoluteEpochSince(
        calculateDaoEarliestSinceCompatible(depositEpoch, withdrawalRequestEpochString).toHexString()
    );
}

export function withdrawalAmountEstimation(deposit: I8Cell, withdrawalRequestDao: PackedDao) {
    const depositDao = deposit.cellOutput.type![headerDeps][0]!.dao;
    return calculateMaximumWithdrawCompatible(deposit, depositDao, withdrawalRequestDao);
}

export function ckbDelta(tx: TransactionSkeletonType, feeRate: BIish) {
    let ckbDelta = zero;
    for (const c of tx.inputs) {
        //Second Withdrawal step from NervosDAO
        if (isDaoWithdrawalRequest(c)) {
            const withdrawalRequest = c as I8Cell;
            const [withdrawalHeader, depositHeader] = withdrawalRequest.cellOutput.type![headerDeps];
            const maxWithdrawable = calculateMaximumWithdrawCompatible(c, depositHeader.dao, withdrawalHeader.dao);
            ckbDelta = ckbDelta.add(maxWithdrawable);
        } else {
            ckbDelta = ckbDelta.add(c.cellOutput.capacity);
        }
    }

    tx.outputs.forEach((c) => ckbDelta = ckbDelta.sub(c.cellOutput.capacity));

    //Don't account for the tx fee if there are no outputs
    if (tx.outputs.size > 0 && BI.from(feeRate).gt(zero)) {
        ckbDelta = ckbDelta.sub(calculateFee(txSize(tx), feeRate));
    }

    return ckbDelta;
}