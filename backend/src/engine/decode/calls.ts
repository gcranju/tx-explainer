import { decodeFunctionData, decodeErrorResult, parseAbiItem } from 'viem';
import { lookupFunction, lookupError, lookupSelectorRemote } from '../registry/abis.js';
import { resolveContract, type ResolvedContract } from '../registry/contracts.js';
import aaveErrors from './aaveErrors.json' with { type: 'json' };

const AAVE: Record<string, { name: string; desc: string }> = aaveErrors as any;

export interface DecodedArg {
  name: string;
  type: string;
  value: string;
}

export interface DecodedFunctionCall {
  selector: `0x${string}`;
  functionName?: string;
  signature?: string;
  args: DecodedArg[];
  /** true if signature was resolved but args couldn't be decoded */
  partial: boolean;
  source: 'local-abi' | 'signature-db' | 'unknown';
}

function stringify(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return `[${v.map(stringify).join(', ')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v).map(([k, x]) => `${k}: ${stringify(x)}`).join(', ')}}`;
  }
  return String(v);
}

export async function decodeCall(payload: string): Promise<DecodedFunctionCall> {
  const selector = payload.slice(0, 10).toLowerCase() as `0x${string}`;
  const fn = lookupFunction(selector);

  if (fn) {
    try {
      const { args } = decodeFunctionData({ abi: [fn.item], data: payload as `0x${string}` });
      const inputs = fn.item.inputs ?? [];
      return {
        selector,
        functionName: fn.item.name,
        signature: fn.signature,
        args: (args ?? []).map((a, idx) => ({
          name: inputs[idx]?.name || `arg${idx}`,
          type: inputs[idx]?.type || '',
          value: stringify(a),
        })),
        partial: false,
        source: 'local-abi',
      };
    } catch {
      return { selector, functionName: fn.item.name, signature: fn.signature, args: [], partial: true, source: 'local-abi' };
    }
  }

  // Fall back to the on-chain signature DB (handles deployed-but-divergent contracts).
  const remoteSig = await lookupSelectorRemote(selector, 'function');
  if (remoteSig) {
    try {
      const item = parseAbiItem(`function ${remoteSig}`) as any;
      const { args, functionName } = decodeFunctionData({ abi: [item], data: payload as `0x${string}` });
      return {
        selector,
        functionName,
        signature: remoteSig,
        args: (args ?? []).map((a, idx) => ({ name: item.inputs[idx]?.name || `arg${idx}`, type: item.inputs[idx]?.type || '', value: stringify(a) })),
        partial: false,
        source: 'signature-db',
      };
    } catch {
      return { selector, signature: remoteSig, args: [], partial: true, source: 'signature-db' };
    }
  }

  return { selector, args: [], partial: true, source: 'unknown' };
}

export interface DecodedRevert {
  raw: `0x${string}`;
  kind: 'string' | 'panic' | 'custom' | 'empty' | 'unknown';
  message?: string;
  errorName?: string;
  signature?: string;
}

const PANIC_REASONS: Record<number, string> = {
  0x01: 'assert(false)',
  0x11: 'arithmetic overflow/underflow',
  0x12: 'division or modulo by zero',
  0x21: 'invalid enum conversion',
  0x32: 'array index out of bounds',
  0x41: 'out-of-memory / oversized allocation',
};

export async function decodeRevert(data?: string): Promise<DecodedRevert> {
  if (!data || data === '0x') return { raw: '0x', kind: 'empty' };
  const raw = data as `0x${string}`;
  const sel = raw.slice(0, 10).toLowerCase();

  // Error(string)
  if (sel === '0x08c379a0') {
    try {
      const { args } = decodeErrorResult({ abi: [parseAbiItem('error Error(string)') as any], data: raw });
      const s = args?.[0] as string;
      // Aave/money-market uses bare numeric string codes — map to meaning from our Errors.sol.
      if (/^\d+$/.test(s) && AAVE[s]) {
        return { raw, kind: 'string', message: `${AAVE[s].name} — ${AAVE[s].desc} (code ${s})`, errorName: AAVE[s].name };
      }
      return { raw, kind: 'string', message: s };
    } catch {/* fallthrough */}
  }
  // Panic(uint256)
  if (sel === '0x4e487b71') {
    try {
      const { args } = decodeErrorResult({ abi: [parseAbiItem('error Panic(uint256)') as any], data: raw });
      const code = Number(args?.[0] ?? 0n);
      return { raw, kind: 'panic', message: PANIC_REASONS[code] ?? `panic 0x${code.toString(16)}`, errorName: 'Panic' };
    } catch {/* fallthrough */}
  }

  // Custom error from local ABIs
  const local = lookupError(sel);
  if (local) {
    try {
      const { args } = decodeErrorResult({ abi: [local.item], data: raw });
      const named = (local.item.inputs ?? []).map((inp, i) => `${inp.name || i}: ${stringify((args as any)?.[i])}`);
      return { raw, kind: 'custom', errorName: local.item.name, signature: local.signature, message: named.length ? `${local.item.name}(${named.join(', ')})` : local.item.name };
    } catch {
      return { raw, kind: 'custom', errorName: local.item.name, signature: local.signature, message: local.item.name };
    }
  }

  // Remote signature DB
  const remote = await lookupSelectorRemote(sel, 'error');
  if (remote) return { raw, kind: 'custom', signature: remote, message: remote.split('(')[0], errorName: remote.split('(')[0] };

  return { raw, kind: 'unknown' };
}

export type { ResolvedContract };
export { resolveContract };
