import { getAddress, type Address } from 'viem';
import { getClient } from '../rpc.js';

const lendingManagerAbi = [
  { type: 'function', name: 'borrowerLimits', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getCurrentTotalBorrowed', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;

const strategyAbi = [
  { type: 'function', name: 'lendingManager', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
] as const;

export interface BorrowerLimitState {
  manager: Address;
  borrower: Address;
  limitRaw: bigint;
  usedRaw: bigint;
  headroomRaw: bigint;
  /** 8-decimal USD (Aave/MM oracle base). */
  limitUsd: number;
  usedUsd: number;
  headroomUsd: number;
}

const USD_DECIMALS = 8;
function toUsd(raw: bigint): number {
  return Number(raw) / 10 ** USD_DECIMALS;
}

export async function readBorrowerLimit(
  chainId: number,
  manager: string,
  borrower: string,
  blockNumber?: bigint,
): Promise<BorrowerLimitState | null> {
  const client = getClient(chainId);
  try {
    const [limitRaw, usedRaw] = (await Promise.all([
      client.readContract({ address: getAddress(manager), abi: lendingManagerAbi, functionName: 'borrowerLimits', args: [getAddress(borrower)], blockNumber }),
      client.readContract({ address: getAddress(manager), abi: lendingManagerAbi, functionName: 'getCurrentTotalBorrowed', args: [getAddress(borrower)], blockNumber }),
    ])) as [bigint, bigint];
    const headroomRaw = limitRaw > usedRaw ? limitRaw - usedRaw : 0n;
    return {
      manager: getAddress(manager),
      borrower: getAddress(borrower),
      limitRaw,
      usedRaw,
      headroomRaw,
      limitUsd: toUsd(limitRaw),
      usedUsd: toUsd(usedRaw),
      headroomUsd: toUsd(headroomRaw),
    };
  } catch {
    return null;
  }
}

/** If `addr` is a strategy/vault that borrows, return the manager it borrows from. */
export async function getLendingManagerOf(chainId: number, addr: string): Promise<Address | null> {
  try {
    const client = getClient(chainId);
    const mgr = (await client.readContract({ address: getAddress(addr), abi: strategyAbi, functionName: 'lendingManager' })) as Address;
    return getAddress(mgr);
  } catch {
    return null;
  }
}
