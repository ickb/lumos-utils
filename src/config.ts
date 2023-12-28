import { BI } from "@ckb-lumos/bi"
import { Block, Hash, HashType, Hexadecimal, OutPoint, Transaction, blockchain } from "@ckb-lumos/base";
import { vector } from "@ckb-lumos/codec/lib/molecule";
import {
    Config, ScriptConfigs, ScriptConfig, generateGenesisScriptConfigs,
    predefined, getConfig, initializeConfig as unadaptedInitializeConfig
} from "@ckb-lumos/config-manager/lib";
import { I8CellDepFrom, I8Cell, I8ScriptFrom, I8Script, I8OutPointFrom, I8OutPoint, I8CellFrom } from "./cell";
import { List } from "immutable";
import { LightClientRPC } from "@ckb-lumos/light-client";
import { RPC } from "@ckb-lumos/rpc";
import { CKBComponents } from "@ckb-lumos/rpc/lib/types/api";

const chain2RpcUrl = Object.freeze({
    mainnet: "https://rpc.ankr.com/nervos_ckb",
    testnet: "https://testnet.ckb.dev",
    devnet: "http://127.0.0.1:8114/"
});

export type Chain = keyof typeof chain2RpcUrl;

export function isChain(x: string): x is Chain {
    return chain2RpcUrl.hasOwnProperty(x);
}

export function defaultRpcUrl(chain: Chain) {
    return chain2RpcUrl[chain];
}

function newChainInfo(chain: Chain, rpcUrl: string = defaultRpcUrl(chain), isLightClientRpc: boolean = false) {
    return <ChainInfo>Object.freeze({
        chain,
        rpcUrl,
        isLightClientRpc
    });
}

export type ChainInfo = {
    chain: Chain,
    rpcUrl: string,
    isLightClientRpc: boolean
}

let _chainInfo = newChainInfo(addressPrefix() == "ckb" ? "mainnet" : "testnet");

export const errorUnresponsiveRpcUrl = "The provided RPC Url is either unresponsive or invalid";
export async function initializeChainAdapter(
    chain: Chain,
    config?: Config,
    rpcUrl: string = defaultRpcUrl(chain),
    isLightClientRpc: boolean = false
) {
    if (chain != _chainInfo.chain || rpcUrl !== _chainInfo.rpcUrl) {
        _chainInfo = newChainInfo(chain, rpcUrl, isLightClientRpc);
    }

    if (config !== undefined) {
        initializeConfig(config);
    } else if (chain === "mainnet") {
        initializeConfig(predefined.LINA);
    } else if (chain === "testnet") {
        initializeConfig(predefined.AGGRON4);
    } else {//Devnet        
        initializeConfig({
            PREFIX: "ckt",
            SCRIPTS: generateGenesisScriptConfigs(await getGenesisBlock()),
        });
    }
}

export function getChainInfo() {
    return Object.freeze({ ..._chainInfo });
}

export async function sendTransaction(tx: Transaction) {
    //Same signature for both RPC and light client RPC
    return new RPC(_chainInfo.rpcUrl).sendTransaction(tx);
}

export async function getTipHeader() {
    //Same signature for both RPC and light client RPC
    return new RPC(_chainInfo.rpcUrl).getTipHeader();
}

export async function getGenesisBlock() {
    if (_chainInfo.isLightClientRpc) {
        return new LightClientRPC(_chainInfo.rpcUrl).getGenesisBlock();
    } else {
        return new RPC(_chainInfo.rpcUrl).getBlockByNumber('0x0');
    }
}

export async function getHeader(blockHash: Hash) {
    //Same signature for both RPC and light client RPC
    return new RPC(_chainInfo.rpcUrl).getHeader(blockHash);
}


export async function getTransaction(txHash: Hash) {
    //Same signature for both RPC and light client RPC
    return new RPC(_chainInfo.rpcUrl).getTransaction(txHash);
}

export async function localNodeInfo() {
    //Same signature for both RPC and light client RPC
    return new RPC(_chainInfo.rpcUrl).localNodeInfo();
}

export async function getCells<WithData extends boolean = true>(
    searchKey: CKBComponents.GetCellsSearchKey<WithData>,
    order: CKBComponents.Order = "asc",
    limit: CKBComponents.Hash | bigint = "0xffffffff",
    cursor?: CKBComponents.Hash256) {
    //Same signature for both RPC and light client RPC
    return new RPC(_chainInfo.rpcUrl).getCells(searchKey, order, limit, cursor);
}

export async function getTransactions<Group extends boolean = false>(
    searchKey: CKBComponents.GetTransactionsSearchKey<Group>,
    order: CKBComponents.Order = "asc",
    limit: CKBComponents.Hash | bigint = "0xffffffff",
    cursor?: CKBComponents.Hash256) {
    //Same signature for both RPC and light client RPC
    return new RPC(_chainInfo.rpcUrl).getTransactions(searchKey, order, limit, cursor);
}

export async function getCellsCapacity(searchKey: CKBComponents.SearchKey) {
    //Same signature for both RPC and light client RPC
    return new RPC(_chainInfo.rpcUrl).getCellsCapacity(searchKey);
}

//Try not to be over-reliant on getConfig as it may become an issue in the future. Use the provided abstractions.
export { getConfig } from "@ckb-lumos/config-manager/lib";

export function initializeConfig(config: Config) {
    unadaptedInitializeConfig(configAdapterFrom(config));
}

export function addressPrefix() {
    return getConfig().PREFIX;
}

export function scriptNames() {
    let res = List<string>();
    for (const scriptName in getConfig().SCRIPTS) {
        res = res.push(scriptName);
    }
    return res;
}

export const errorScriptNameNotFound = "Script name not found"
export function defaultScript(name: string): ScriptConfigAdapter {
    let config = getConfig();

    let scriptConfig = config.SCRIPTS[name];
    if (!scriptConfig) {
        throw Error(errorScriptNameNotFound);
    }

    return scriptConfigAdapterFrom(scriptConfig);
}

class ScriptConfigAdapter extends I8ScriptFrom implements ScriptConfig {
    get CODE_HASH() { return this.codeHash; }
    get HASH_TYPE() { return this.hashType; }
    get TX_HASH() { return this.cellDeps.get(0)!.outPoint.txHash; }
    get INDEX() { return this.cellDeps.get(0)!.outPoint.index; }
    get DEP_TYPE() { return this.cellDeps.get(0)!.depType; }
}

export function scriptConfigAdapterFrom(scriptConfig: ScriptConfig): ScriptConfigAdapter {
    if (scriptConfig instanceof ScriptConfigAdapter) {
        return scriptConfig;
    }

    const dep = I8CellDepFrom({
        outPoint: I8OutPointFrom({
            txHash: scriptConfig.TX_HASH,
            index: scriptConfig.INDEX,
        }),
        depType: scriptConfig.DEP_TYPE,
    })

    return new ScriptConfigAdapter({
        codeHash: scriptConfig.CODE_HASH,
        hashType: scriptConfig.HASH_TYPE,
        args: "0x",
        cellDeps: List([dep])
    });
}

export function configAdapterFrom(config: Config) {
    const adaptedScriptConfig: ScriptConfigs = {};
    for (const scriptName in config.SCRIPTS) {
        adaptedScriptConfig[scriptName] = scriptConfigAdapterFrom(config.SCRIPTS[scriptName]!);
    }
    return Object.freeze({
        PREFIX: config.PREFIX,
        SCRIPTS: Object.freeze(adaptedScriptConfig)
    })
}

export const errorIOLengthMismatch = "List of input cells and output outPoints are of different lengths"
export async function deploy(
    scriptData: List<{
        name: string;
        hexData: Hexadecimal;
        codeHash: Hexadecimal;
        hashType: HashType;
    }>,
    commit: (cells: List<I8Cell>) => Promise<List<I8OutPoint>>,
    lock: I8Script = defaultScript("SECP256K1_BLAKE160"),
    type?: I8Script
) {
    let dataCells: List<I8Cell> = List();
    for (const { hexData: data } of scriptData) {
        const dataCell = I8CellFrom({ lock, type, data });
        dataCells = dataCells.push(dataCell);
    }

    const outPoints = await commit(dataCells);
    if (outPoints.size != dataCells.size) {
        throw Error(errorIOLengthMismatch);
    }

    const newScriptConfig: ScriptConfigs = {};
    const oldConfig = getConfig();
    scriptData.forEach(({ name, codeHash, hashType }, i) => {
        newScriptConfig[name] = new ScriptConfigAdapter({
            codeHash,
            hashType,
            args: "0x",
            cellDeps: List([new I8CellDepFrom({ outPoint: outPoints.get(i) })])
        })
    });

    initializeConfig({
        PREFIX: oldConfig.PREFIX,
        SCRIPTS: { ...oldConfig.SCRIPTS, ...newScriptConfig }
    });

    return getConfig();
}

export const errorScriptNotFound = "Script not found in Config";
export async function createDepGroup(
    scriptNames: List<string>,
    commit: (cells: List<I8Cell>) => Promise<List<I8OutPoint>>,
    getCell: (outPoint: I8OutPoint) => Promise<I8Cell>,
    lock: I8Script = defaultScript("SECP256K1_BLAKE160"),
    type?: I8Script
) {
    const outPointsCodec = vector(blockchain.OutPoint);
    const serializeOutPoint = (p: OutPoint) => `${p.txHash}-${p.index}`;
    const serializedOutPoint2OutPoint: Map<string, I8OutPoint> = new Map();
    for (const name of scriptNames) {
        const s = defaultScript(name);
        if (s === undefined) {
            throw Error(errorScriptNotFound);
        }
        for (const cellDep of s.cellDeps) {
            if (cellDep.depType === "code") {
                serializedOutPoint2OutPoint.set(serializeOutPoint(cellDep.outPoint), cellDep.outPoint);
            } else { //depGroup
                const cell = await getCell(cellDep.outPoint);
                for (const o_ of outPointsCodec.unpack(cell.data)) {
                    const o = new I8OutPointFrom({ ...o_, index: BI.from(o_.index).toHexString() });
                    serializedOutPoint2OutPoint.set(serializeOutPoint(o), o);
                }
            }
        }
    }

    const packedOutPoints = outPointsCodec.pack([...serializedOutPoint2OutPoint.values()]);
    const data = "0x" + Buffer.from(packedOutPoints).toString('hex');
    const cell = I8CellFrom({ lock, type, data });
    const [outPoint] = await commit(List([cell]));

    const newScriptConfig: ScriptConfigs = {};
    for (const name of scriptNames) {
        const s = defaultScript(name);
        newScriptConfig[name] = s.set("cellDeps", List([new I8CellDepFrom({ outPoint, depType: "depGroup" })]));
    }

    const oldConfig = getConfig();
    initializeConfig({
        PREFIX: oldConfig.PREFIX,
        SCRIPTS: { ...oldConfig.SCRIPTS, ...newScriptConfig }
    });

    return getConfig();
}