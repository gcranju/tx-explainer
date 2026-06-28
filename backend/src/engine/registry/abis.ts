import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { toFunctionSelector, type AbiFunction } from 'viem';

type AbiError = { type: 'error'; name: string; inputs?: any[] };

// Where the foundry build output lives. Override with FORGE_OUT_DIR.
const FORGE_OUT_DIR =
  process.env.FORGE_OUT_DIR ?? '/Users/meera/work/sodax-contracts/evm/out';

export interface FnEntry {
  selector: `0x${string}`;
  signature: string; // human readable, e.g. "borrow(address,uint256)"
  item: AbiFunction;
  contracts: string[]; // contract artifact names that expose this selector
}

export interface ErrEntry {
  selector: `0x${string}`;
  signature: string;
  item: AbiError;
}

interface AbiIndex {
  functions: Map<string, FnEntry>;
  errors: Map<string, ErrEntry>;
  abiByContract: Map<string, any[]>;
}

let cached: AbiIndex | null = null;

function humanType(input: any): string {
  if (input.type?.startsWith('tuple')) {
    const inner = (input.components ?? []).map(humanType).join(',');
    return `(${inner})${input.type.slice('tuple'.length)}`;
  }
  return input.type;
}

function signatureOf(item: { name: string; inputs?: any[] }): string {
  const inputs = (item.inputs ?? []).map(humanType).join(',');
  return `${item.name}(${inputs})`;
}

function walkJson(dir: string, out: string[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walkJson(p, out);
    else if (e.endsWith('.json')) out.push(p);
  }
}

export function getAbiIndex(): AbiIndex {
  if (cached) return cached;
  const functions = new Map<string, FnEntry>();
  const errors = new Map<string, ErrEntry>();
  const abiByContract = new Map<string, any[]>();

  const files: string[] = [];
  walkJson(FORGE_OUT_DIR, files);

  for (const file of files) {
    let json: any;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const abi = json.abi;
    if (!Array.isArray(abi)) continue;
    const contractName = file.split('/').pop()!.replace('.json', '');
    if (!abiByContract.has(contractName)) abiByContract.set(contractName, abi);

    for (const item of abi) {
      try {
        if (item.type === 'function') {
          const sel = toFunctionSelector(item as AbiFunction);
          const sig = signatureOf(item);
          const existing = functions.get(sel);
          if (existing) {
            if (!existing.contracts.includes(contractName)) existing.contracts.push(contractName);
          } else {
            functions.set(sel, { selector: sel, signature: sig, item, contracts: [contractName] });
          }
        } else if (item.type === 'error') {
          const sel = toFunctionSelector(signatureOf(item));
          if (!errors.has(sel)) {
            errors.set(sel, { selector: sel, signature: signatureOf(item), item });
          }
        }
      } catch {
        // skip malformed items
      }
    }
  }

  cached = { functions, errors, abiByContract };
  return cached;
}

export function lookupFunction(selector: string): FnEntry | undefined {
  return getAbiIndex().functions.get(selector.toLowerCase());
}

export function lookupError(selector: string): ErrEntry | undefined {
  return getAbiIndex().errors.get(selector.toLowerCase());
}

// On-chain signature DB fallback for selectors not present in local ABIs
// (e.g. a deployed contract built from a different source revision).
const sigCache = new Map<string, string | null>();

export async function lookupSelectorRemote(
  selector: string,
  kind: 'function' | 'error' = 'function',
): Promise<string | null> {
  const key = `${kind}:${selector}`;
  if (sigCache.has(key)) return sigCache.get(key)!;
  try {
    const url = `https://api.openchain.xyz/signature-database/v1/lookup?${kind}=${selector}&filter=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data: any = await res.json();
    const arr = data?.result?.[kind]?.[selector.toLowerCase()];
    const sig = Array.isArray(arr) && arr.length ? arr[0].name : null;
    sigCache.set(key, sig);
    return sig;
  } catch {
    sigCache.set(key, null);
    return null;
  }
}
