import { createPublicClient, http, type PublicClient } from 'viem';

export interface ChainConfig {
  id: number;
  name: string;
  rpcUrl: string;
  explorer?: string;
}

// Sodax hub + common spokes. Add more as needed.
export const CHAINS: Record<number, ChainConfig> = {
  146: {
    id: 146,
    name: 'Sonic',
    rpcUrl: process.env.SONIC_RPC_URL ?? 'https://rpc.soniclabs.com',
    explorer: 'https://sonicscan.org',
  },
};

export const DEFAULT_CHAIN_ID = 146;

const clients = new Map<number, PublicClient>();

export function getClient(chainId: number = DEFAULT_CHAIN_ID): PublicClient {
  const cfg = CHAINS[chainId];
  if (!cfg) throw new Error(`Unsupported chain id ${chainId}`);
  let c = clients.get(chainId);
  if (!c) {
    c = createPublicClient({
      transport: http(cfg.rpcUrl, { timeout: 30_000, retryCount: 2 }),
    });
    clients.set(chainId, c);
  }
  return c;
}

export function explorerTxUrl(chainId: number, hash: string): string | undefined {
  const e = CHAINS[chainId]?.explorer;
  return e ? `${e}/tx/${hash}` : undefined;
}
