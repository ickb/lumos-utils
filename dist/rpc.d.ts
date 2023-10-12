import { RPC } from "@ckb-lumos/rpc";
import { Indexer } from "@ckb-lumos/ckb-indexer";
import { Header, Hexadecimal } from "@ckb-lumos/base";
export declare function initializeRpcHubFrom(url: string): void;
export declare function getRpcUrl(): string;
export declare function getRpc(): RPC;
export declare function getRpcBatcher(): {
    get: <T>(request: string, cacheable: boolean) => Promise<T>;
    process: () => void;
};
export declare function getHeaderByNumber(blockNumber: Hexadecimal): Promise<Header>;
export declare function getSyncedIndexer(): Promise<Indexer>;
