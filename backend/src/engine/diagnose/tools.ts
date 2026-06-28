import { getAddress, parseAbiItem, encodeFunctionData, decodeFunctionResult, type Hex } from 'viem';
import { getClient } from '../rpc.js';
import { gatherSource } from '../source/fetchSource.js';
import { getTokenInfo, usdValue } from '../price.js';
import type { ToolSpec, ToolExecutor } from './llm.js';

// Generic on-chain investigation tools handed to the LLM. They are NOT specific
// to any contract or error — the model decides what to read and whose source to
// inspect. State reads default to the block just before the tx (failure-time state).

export const INVESTIGATION_TOOLS: ToolSpec[] = [
  {
    name: 'read_contract',
    description:
      'Call a read-only (view/pure) function on any contract at the failing block and get the decoded result. Use this to inspect on-chain state relevant to the revert (limits, balances, registries, config, ownership, etc.).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        address: { type: 'string', description: 'Contract address to call.' },
        signature: {
          type: 'string',
          description:
            'Full human-readable function signature INCLUDING the return types, e.g. "borrowerLimits(address) view returns (uint256)" or "assetInfo(address) view returns (uint256, bytes)".',
        },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments as strings (addresses, decimal numbers, true/false).' },
      },
      required: ['address', 'signature'],
    },
  },
  {
    name: 'get_source',
    description:
      'Fetch the Solidity source of any contract address (verified on the explorer, following proxy→implementation; else the local repo). Use to inspect collaborators referenced by the failing function.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { address: { type: 'string', description: 'Contract address whose source to fetch.' } },
      required: ['address'],
    },
  },
  {
    name: 'token_info',
    description:
      'Get a token\'s symbol, decimals, and USD price (from the hub oracle). Optionally pass a raw amount to also get the human amount and its USD value. Use to express token amounts in human + USD terms.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        address: { type: 'string', description: 'Token address.' },
        amount: { type: 'string', description: 'Optional raw (base-unit) amount to convert to human + USD.' },
      },
      required: ['address'],
    },
  },
];

function coerce(type: string, raw: string): any {
  const t = type.trim();
  if (t.endsWith('[]')) {
    try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr.map((x) => coerce(t.slice(0, -2), String(x))) : raw; } catch { return raw; }
  }
  if (/^u?int\d*$/.test(t)) return BigInt(raw);
  if (t === 'bool') return raw === 'true' || raw === '1';
  if (t === 'address') return getAddress(raw);
  return raw; // bytes/string/etc.
}

function jsonSafe(v: unknown): any {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

export function makeExecutor(chainId: number, blockNumber?: bigint): ToolExecutor {
  return async (name, args) => {
    if (name === 'read_contract') {
      const client = getClient(chainId);
      const sig = String(args.signature).replace(/^function\s+/, '');
      const item = parseAbiItem(`function ${sig}`) as any;
      const inputs = item.inputs ?? [];
      const rawArgs: string[] = args.args ?? [];
      const typedArgs = inputs.map((inp: any, i: number) => coerce(inp.type, String(rawArgs[i] ?? '')));
      const data = encodeFunctionData({ abi: [item], functionName: item.name, args: typedArgs });
      let res;
      try {
        res = await client.call({ to: getAddress(args.address), data, blockNumber });
      } catch {
        return JSON.stringify({
          result: null,
          error: 'call reverted',
          hint: `The function ${item.name}(...) reverted on ${args.address} — it likely does not live on this contract. If the source shows it is reached via a getter (e.g. assetManager(), pool(), oracle(), addressesProvider()), read that getter on this contract first to get the collaborator address, then call ${item.name} on the returned address.`,
        });
      }
      if (!res.data || res.data === '0x') {
        return JSON.stringify({ result: null, note: 'empty return — function may not exist on this address; try the collaborator that actually implements it.' });
      }
      const decoded = decodeFunctionResult({ abi: [item], functionName: item.name, data: res.data as Hex });
      return JSON.stringify({ result: jsonSafe(decoded) });
    }
    if (name === 'get_source') {
      const s = await gatherSource(chainId, args.address);
      if (s.origin === 'none') return JSON.stringify({ found: false });
      return JSON.stringify({ origin: s.origin, contractName: s.contractName, file: s.file, code: (s.code ?? '').slice(0, 12000) });
    }
    if (name === 'token_info') {
      const info = await getTokenInfo(chainId, args.address, blockNumber);
      const out: any = { address: info.address, symbol: info.symbol, decimals: info.decimals, usdPrice: info.usdPrice };
      if (args.amount && info.decimals !== undefined) {
        const raw = BigInt(args.amount);
        out.humanAmount = Number(raw) / 10 ** info.decimals;
        const usd = usdValue(raw, info);
        if (usd !== undefined) out.usdValue = usd;
      }
      return JSON.stringify(out);
    }
    return `unknown tool: ${name}`;
  };
}
