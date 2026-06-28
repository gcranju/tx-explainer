import { getAddress, type Address } from 'viem';
import { getClient } from '../rpc.js';
import { wikiLabel } from './wiki.js';

export type ContractKind =
  | 'SolverRouter'
  | 'ATokenLendingManager'
  | 'Intents'
  | 'MarketMakingStrategy'
  | 'AssetManager'
  | 'Token'
  | 'Unknown';

export interface KnownContract {
  address: Address;
  name: string;
  kind: ContractKind;
  /** artifact name(s) in forge out/ whose ABI should be tried first */
  abiHints?: string[];
  notes?: string;
}

// Curated Sodax mainnet (Sonic, chain 146) addresses. Extend freely.
const RAW: Omit<KnownContract, 'address'> & { address: string }[] = [] as any;

const KNOWN: Record<string, KnownContract> = {};
function reg(c: { address: string; name: string; kind: ContractKind; abiHints?: string[]; notes?: string }) {
  const a = getAddress(c.address);
  KNOWN[a.toLowerCase()] = { ...c, address: a };
}

reg({ address: '0xc3391bDEcf3f5c40bF2E1B30606B60d3f22bf962', name: 'SolverRouter', kind: 'SolverRouter', abiHints: ['Router'] });
reg({ address: '0x73135D19C488EA5b002E0e07135D992FF7e6f070', name: 'ATokenLendingManager', kind: 'ATokenLendingManager', abiHints: ['ATokenLendingManager'] });
reg({ address: '0x6382d6ccd780758c5e8a6123c33ee8f4472f96ef', name: 'Intents', kind: 'Intents', abiHints: ['Intents'] });
reg({ address: '0x44f5830bed0916e26746095aac195794ecad1e07', name: 'MarketMakingStrategy', kind: 'MarketMakingStrategy', abiHints: ['MarketMakingStrategy'], notes: 'Borrows from ATokenLendingManager under its OWN per-msg.sender limit' });
reg({ address: '0x60c5681bd1db4e50735c4ca3386005a4ba4937c0', name: 'AssetManager', kind: 'AssetManager', abiHints: ['AssetManager', 'SpokeAssetManager'] });

export function getKnown(address: string): KnownContract | undefined {
  return KNOWN[address.toLowerCase()];
}

const erc20Abi = [
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
] as const;

export interface ResolvedContract extends KnownContract {
  symbol?: string;
  decimals?: number;
}

const enrichCache = new Map<string, ResolvedContract>();

/** Resolve a label for any address: curated registry first, then ERC20 probe. */
export async function resolveContract(address: string, chainId: number): Promise<ResolvedContract> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const hit = enrichCache.get(key);
  if (hit) return hit;

  const known = getKnown(address);
  const base: ResolvedContract = known
    ? { ...known }
    : { address: getAddress(address), name: '', kind: 'Unknown' };

  // Probe ERC20 metadata (cheap, labels tokens nicely).
  try {
    const client = getClient(chainId);
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: getAddress(address), abi: erc20Abi, functionName: 'symbol' }).catch(() => undefined),
      client.readContract({ address: getAddress(address), abi: erc20Abi, functionName: 'decimals' }).catch(() => undefined),
    ]);
    // Only accept clean printable symbols (some tokens return binary/garbage).
    const sym = typeof symbol === 'string' ? symbol.trim() : '';
    const cleanSym = /^[\x20-\x7E]{1,32}$/.test(sym) ? sym : undefined;
    if (cleanSym) {
      base.symbol = cleanSym;
      if (base.kind === 'Unknown') {
        base.kind = 'Token';
        base.name = cleanSym;
      }
    }
    if (decimals !== undefined) base.decimals = Number(decimals);
  } catch {
    // ignore probe failures
  }

  // Wiki.md name takes precedence over a bare symbol/placeholder (but not a
  // curated registry name, which is set above).
  if (!known) {
    const wl = wikiLabel(address);
    if (wl) base.name = wl;
  }
  if (!base.name) base.name = `${address.slice(0, 8)}…`;
  enrichCache.set(key, base);
  return base;
}
