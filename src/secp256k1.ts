import { secp256k1Blake160 } from "@ckb-lumos/common-scripts";
import { TransactionSkeletonType, sealTransaction } from "@ckb-lumos/helpers";
import { I8Cell, I8ScriptFrom, I8Script, scriptEq, scriptIs } from "./cell";
import { List, Record } from "immutable";
import { encodeToAddress } from "@ckb-lumos/helpers";
import { randomBytes } from "crypto";
import { key } from "@ckb-lumos/hd";
import { hexify } from "@ckb-lumos/codec/lib/bytes";
import { defaultScript } from "./config";
import { DEPOSIT_DATA } from "./dao";
import { Script, blockchain } from "@ckb-lumos/base";
import { WitnessArgs } from "@ckb-lumos/base/lib/blockchain";

export function secp256k1Sifter(inputs: List<I8Cell>, account: I8Secp256k1Accountify) {
    let accountCells: typeof inputs = List();
    let unknowns: typeof inputs = List();

    for (const c of inputs) {
        if (!scriptEq(c.lock, account.lockScript)) {
            unknowns = unknowns.push(c);
            continue;
        }

        accountCells = accountCells.push(c.set("lock", account.lockScript));
    }

    return { accountCells, unknowns };
}

const witnessPadding = hexify(blockchain.WitnessArgs.pack({ lock: "0x" }));
export function secp256k1WitnessPlaceholder(tx: TransactionSkeletonType) {
    let ss = new Set<Script>();
    let index = 0;
    for (const c of tx.inputs) {
        index += 1;

        const lock = c.cellOutput.lock;

        if (!scriptIs(lock, "SECP256K1_BLAKE160") || ss.has(lock)) {
            continue;
        }

        ss = ss.add(lock);

        tx.update("witnesses", ww => ww.update(index, witnessPadding, w => {
            const unpacked = WitnessArgs.unpack(w);
            unpacked.lock = "0x" + "00".repeat(65);
            return hexify(WitnessArgs.pack(unpacked));
        }))
    }

    return tx;
}

export function secp256k1Signer(transaction: TransactionSkeletonType, account: I8Secp256k1Accountify) {
    transaction = secp256k1Blake160.prepareSigningEntries(transaction);
    const message = transaction.get("signingEntries").get(0)!.message;//How to improve in case of multiple locks?
    const Sig = key.signRecoverable(message!, account.privateKey);
    const tx = sealTransaction(transaction, [Sig]);

    return Promise.resolve(tx);
}

export function I8Secp256k1AccountFrom(privKey?: string) {
    const privateKey = privKey ?? hexify(randomBytes(32));
    const publicKey = key.privateToPublic(privateKey);
    const args = key.publicKeyToBlake160(publicKey);
    const lockScript = I8ScriptFrom({
        ...defaultScript("SECP256K1_BLAKE160"),
        args,
        witness: "0x"
    });
    const address = encodeToAddress(lockScript);

    return _I8Secp256k1AccountFrom({
        lockScript,
        address,
        publicKey,
        privateKey
    });
};

//Declarations of immutable data structures
const defaultHex = DEPOSIT_DATA;

export interface I8Secp256k1Accountify {
    lockScript: I8Script;
    address: string;
    publicKey: string;
    privateKey: string;
}
export type I8Secp256k1Account = Record<I8Secp256k1Accountify> & Readonly<I8Secp256k1Accountify>;
const _I8Secp256k1AccountFrom = Record<I8Secp256k1Accountify>({
    lockScript: I8ScriptFrom(),
    address: defaultHex,
    publicKey: defaultHex,
    privateKey: defaultHex,
});
