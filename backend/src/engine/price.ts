import { getAddress, formatUnits } from 'viem';
import { getClient } from './rpc.js';

// Sodax money-market PoolAddressesProvider → PriceOracle.getAssetPrice(token)
// returns USD with 8 decimals. Used as the hub USD price source.
const ADDRESSES_PROVIDER = process.env.PRICE_ADDRESSES_PROVIDER ?? '0x036aDe0aBAA4c82445Cb7597f2d6d6130C118c7b';
const USD_DECIMALS = 8;

const providerAbi = [{ type: 'function', name: 'getPriceOracle', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }] as const;
const oracleAbi = [{ type: 'function', name: 'getAssetPrice', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }] as const;
const erc20Abi = [
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
] as const;

let oracleAddr: Record<number, `0x${string}` | null> = {};
async function getOracle(chainId: number): Promise<`0x${string}` | null> {
  if (oracleAddr[chainId] !== undefined) return oracleAddr[chainId];
  try {
    const o = (await getClient(chainId).readContract({ address: getAddress(ADDRESSES_PROVIDER), abi: providerAbi, functionName: 'getPriceOracle' })) as `0x${string}`;
    oracleAddr[chainId] = getAddress(o);
  } catch {
    oracleAddr[chainId] = null;
  }
  return oracleAddr[chainId];
}

export interface TokenInfo {
  address: string;
  symbol?: string;
  decimals?: number;
  usdPrice?: number; // price of 1 whole token in USD
}

const infoCache = new Map<string, TokenInfo>();

export async function getTokenInfo(chainId: number, token: string, blockNumber?: bigint): Promise<TokenInfo> {
  const key = `${chainId}:${token.toLowerCase()}:${blockNumber ?? 'latest'}`;
  const hit = infoCache.get(key);
  if (hit) return hit;
  const client = getClient(chainId);
  const addr = getAddress(token);
  const info: TokenInfo = { address: addr };
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: addr, abi: erc20Abi, functionName: 'symbol' }).catch(() => undefined),
    client.readContract({ address: addr, abi: erc20Abi, functionName: 'decimals' }).catch(() => undefined),
  ]);
  const sym = typeof symbol === 'string' && /^[\x20-\x7E]{1,32}$/.test(symbol.trim()) ? symbol.trim() : undefined;
  if (sym) info.symbol = sym;
  if (decimals !== undefined) info.decimals = Number(decimals);

  const oracle = await getOracle(chainId);
  if (oracle) {
    try {
      const raw = (await client.readContract({ address: oracle, abi: oracleAbi, functionName: 'getAssetPrice', args: [addr], blockNumber })) as bigint;
      if (raw > 0n) info.usdPrice = Number(formatUnits(raw, USD_DECIMALS));
    } catch { /* not a priced asset */ }
  }
  infoCache.set(key, info);
  return info;
}

/** USD value of a raw token amount, if both decimals and price are known. */
export function usdValue(amountRaw: bigint, info: TokenInfo): number | undefined {
  if (info.decimals === undefined || info.usdPrice === undefined) return undefined;
  return Number(formatUnits(amountRaw, info.decimals)) * info.usdPrice;
}

export function fmtUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
