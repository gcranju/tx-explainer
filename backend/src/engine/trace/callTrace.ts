import { type Address } from 'viem';
import { CHAINS } from '../rpc.js';
import { decodeCall, decodeRevert, resolveContract, type DecodedFunctionCall, type DecodedRevert } from '../decode/calls.js';

// Raw node shape from geth's callTracer.
interface RawNode {
  type: string;
  from: string;
  to?: string;
  value?: string;
  gas?: string;
  gasUsed?: string;
  input?: string;
  output?: string;
  error?: string;
  revertReason?: string;
  calls?: RawNode[];
}

export interface TraceNode {
  id: string; // dotted path, e.g. "0.2.1"
  depth: number;
  type: string; // CALL | DELEGATECALL | STATICCALL | CREATE | ...
  from: Address;
  to?: Address;
  fromLabel: string;
  toLabel: string;
  toKind: string;
  valueWei?: string;
  gasUsed?: number;
  fn: DecodedFunctionCall | null;
  failed: boolean;
  errorRaw?: string; // e.g. "execution reverted"
  revert?: DecodedRevert; // decoded reason (on failing nodes)
  children: TraceNode[];
}

export async function fetchRawCallTrace(chainId: number, hash: string): Promise<RawNode> {
  const url = CHAINS[chainId]?.rpcUrl;
  if (!url) throw new Error(`No RPC for chain ${chainId}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'debug_traceTransaction',
      params: [hash, { tracer: 'callTracer', tracerConfig: { onlyTopCall: false } }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const json: any = await res.json();
  if (json.error) throw new Error(`trace failed: ${json.error.message}`);
  if (!json.result) throw new Error('trace returned no result');
  return json.result as RawNode;
}

const STATEFUL = new Set(['CALL', 'DELEGATECALL', 'CALLCODE']);

async function normalize(raw: RawNode, chainId: number, id: string, depth: number): Promise<TraceNode> {
  const input = raw.input ?? '0x';
  const failed = !!raw.error;
  const [fromC, toC] = await Promise.all([
    resolveContract(raw.from, chainId),
    raw.to ? resolveContract(raw.to, chainId) : Promise.resolve(null),
  ]);

  const fn = input.length >= 10 && raw.type !== 'CREATE' && raw.type !== 'CREATE2' ? await decodeCall(input) : null;

  let revert: DecodedRevert | undefined;
  if (failed) {
    // Prefer the returned revert data; fall back to the tracer's revertReason string.
    if (raw.output && raw.output !== '0x') revert = await decodeRevert(raw.output);
    if ((!revert || revert.kind === 'unknown') && raw.revertReason) {
      revert = { raw: '0x', kind: 'string', message: raw.revertReason };
    }
  }

  const node: TraceNode = {
    id,
    depth,
    type: raw.type,
    from: fromC.address,
    to: toC?.address,
    fromLabel: fromC.name,
    toLabel: toC?.name ?? 'unknown',
    toKind: toC?.kind ?? 'Unknown',
    valueWei: raw.value && raw.value !== '0x0' ? BigInt(raw.value).toString() : undefined,
    gasUsed: raw.gasUsed ? Number(BigInt(raw.gasUsed)) : undefined,
    fn,
    failed,
    errorRaw: raw.error,
    revert,
    children: [],
  };

  const kids = raw.calls ?? [];
  node.children = await Promise.all(kids.map((c, i) => normalize(c, chainId, `${id}.${i}`, depth + 1)));
  return node;
}

export async function buildCallTree(chainId: number, hash: string): Promise<TraceNode> {
  const raw = await fetchRawCallTrace(chainId, hash);
  return normalize(raw, chainId, '0', 0);
}

/** Walk to the deepest failing node (the revert origin) following failed children. */
export function failurePath(root: TraceNode): TraceNode[] {
  const path: TraceNode[] = [];
  let cur: TraceNode | undefined = root.failed ? root : undefined;
  while (cur) {
    path.push(cur);
    cur = cur.children.find((c) => c.failed);
  }
  return path;
}

/** Count nodes for reporting. */
export function countNodes(n: TraceNode): number {
  return 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
}
