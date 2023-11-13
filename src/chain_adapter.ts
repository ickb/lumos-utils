import { RPC } from "@ckb-lumos/rpc";
import { Config, initializeConfig, predefined } from "@ckb-lumos/config-manager/lib";
import { Indexer } from "@ckb-lumos/ckb-indexer";
import { Mutex } from "./mutex";
import { Header, Hexadecimal } from "@ckb-lumos/base";
import { addressPrefix, daoConfig, secp256k1Blake160Config } from "./config";

const chain2RpcUrl = {
    mainnet: "https://rpc.ankr.com/nervos_ckb",
    testnet: "https://testnet.ckb.dev",
    devnet: "http://127.0.0.1:8114/"
};

export type Chain = keyof typeof chain2RpcUrl;

export function isChain(x: string): x is Chain {
    return chain2RpcUrl.hasOwnProperty(x);
}

export function defaultRpcUrl(chain: Chain) {
    return chain2RpcUrl[chain];
}

function newChainAdapter(chain: Chain, url: string = defaultRpcUrl(chain)) {
    const rpc = new RPC(url, { timeout: 10000 })
    return <ChainAdapter>{
        chain,
        url,
        rpc,
        rpcBatcher: createRPCBatcher(rpc),
        indexer: new Indexer(url)
    };
}

type ChainAdapter = {
    chain: Chain,
    url: string,
    rpc: RPC,
    rpcBatcher: {
        get: <T>(request: string, cacheable: boolean) => Promise<T>,
        process: () => void
    }
    indexer: Indexer
}

let chainAdapter = newChainAdapter(addressPrefix() == "ckb" ? "mainnet" : "testnet");

export async function initializeChainAdapter(chain: Chain, config?: Config, url: string = defaultRpcUrl(chain)) {
    if (chain != chainAdapter.chain || url !== chainAdapter.url) {
        chainAdapter = newChainAdapter(chain, url);
    }
    if (config !== undefined) {
        //Do nothing
    } else if (chain === "mainnet") {
        config = predefined.LINA;
    } else if (chain === "testnet") {
        config = predefined.AGGRON4;
    } else {//Devnet
        config = {
            PREFIX: "ckt",
            SCRIPTS: {
                SECP256K1_BLAKE160: await secp256k1Blake160Config(),
                DAO: await daoConfig(),
            }
        }
    }
    initializeConfig(config);
}

export function getRpcUrl() {
    return chainAdapter.url;
}

export function getRpc() {
    return chainAdapter.rpc;
}

// Comment out to change in the future the query implementation details and cache parameters
// export function getRpcBatcher() {
//     return chainAdapter.rpcBatcher;
// }

export async function getHeaderByNumber(blockNumber: Hexadecimal): Promise<Header> {
    const get = chainAdapter.rpcBatcher.get;
    const res = await get("getHeaderByNumber/" + blockNumber, true);//query encoding, change to reimplement batching
    if (res === undefined) {
        throw Error("Header not found from blockNumber " + blockNumber);
    }
    return res as Header;
}

export async function getSyncedIndexer() {
    const indexer = chainAdapter.indexer;
    await indexer.waitForSync();
    return indexer;
}

type Callback = {
    resolve: (x: any) => void;
    reject: (x: any) => void;
}

function createRPCBatcher(rpc: RPC) {
    const batcherState = new Mutex(
        {
            pending: new Map<string, { cacheable: boolean, callbacks: Callback[] }>(),
            cache: new Map<string, any>()
        }
    );

    function process() {
        batcherState.update(async ({ pending, cache }) => {
            if (pending.size > 0) {
                _process(rpc, pending);
            }
            return { pending: new Map(), cache };
        });
    }

    async function get<T>(request: string, cacheable: boolean) {//Add a lifetime and force invalidation parameters?
        return new Promise<T>((resolve, reject) =>
            batcherState.update(async ({ pending, cache }) => {
                if (cacheable && cache.has(request)) {
                    const res = cache.get(request);
                    resolve(res);
                    cache.set(request, res);
                    return { pending, cache }
                }

                //Set delayed executor for new batch request
                if (pending.size == 0) {
                    setTimeout(process, 50);
                }

                let { callbacks } = pending.get(request) || { callbacks: [] };
                callbacks = [...callbacks, { resolve, reject }];
                pending = pending.set(request, { cacheable, callbacks })
                return { pending, cache };
            })
        );
    }

    async function _process(rpc: RPC, requests: Map<string, { cacheable: boolean, callbacks: Callback[] }>) {
        const batch = rpc.createBatchRequest();
        for (const k of requests.keys()) {
            batch.add(...k.split('/'));//query decoding, change to reimplement batching
        }

        try {
            const results = await (batch.exec() as Promise<any[]>);
            const entries = [...requests.entries()];
            const newCache = new Map<string, any>();
            for (const i of results.keys()) {
                const res = results[i];
                const [request, { cacheable, callbacks }] = entries[i];
                if (cacheable && res !== undefined) {
                    newCache.set(request, res);
                }
                for (const callback of callbacks) {
                    callback.resolve(res);
                }
            }

            if (newCache.size > 0) {
                batcherState.update(async ({ pending, cache }) => {
                    for (const [req, res] of newCache.entries()) {
                        if (cache.size >= 65536) {
                            cache.delete(cache.keys().next().value);
                        }
                        cache.set(req, res);
                    }
                    return { pending, cache };
                });
            }

        } catch (error) {
            for (const { callbacks } of requests.values()) {
                for (const callback of callbacks) {
                    callback.reject(error);
                }
            }
        }
    }

    return { get, process }
}