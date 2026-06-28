import { type Address } from 'viem';
import { getClient, explorerTxUrl, DEFAULT_CHAIN_ID } from './rpc.js';
import { resolveContract } from './decode/calls.js';
import { buildCallTree, failurePath, countNodes, type TraceNode } from './trace/callTrace.js';
import { explainFailure, type Explanation } from './diagnose/explain.js';
import { type SourceResult } from './source/fetchSource.js';
import { getTokenInfo, fmtUsd } from './price.js';

export type Progress = (msg: string) => void;

export interface AnalysisReport {
  chainId: number;
  hash: string;
  explorerUrl?: string;
  status: 'success' | 'reverted';
  block: string;
  from: Address;
  to: Address | null;
  toLabel?: string;
  entry: { selector: string; functionName?: string };
  tree: TraceNode;
  nodeCount: number;
  failurePathIds: string[];
  reason?: {
    message?: string;
    kind: string;
    errorName?: string;
    originId: string;
    originContract: string;
    originAddress?: string;
  };
  explanation?: Explanation;
  sources?: { origin: string; contractName?: string; file?: string; code?: string }[];
  participants?: { address: string; label?: string; symbol?: string; decimals?: number; usdPrice?: number; isSender?: boolean; isActor?: boolean }[];
  summary: string[];
}

function fnLabel(n: TraceNode): string {
  return n.fn?.functionName ?? (n.fn?.selector ?? '(no calldata)');
}

export async function analyzeTx(
  hash: string,
  chainId: number = DEFAULT_CHAIN_ID,
  onProgress: Progress = () => {},
): Promise<AnalysisReport> {
  const client = getClient(chainId);
  onProgress('Fetching transaction + receipt…');
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: hash as `0x${string}` }),
    client.getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null),
  ]);
  const status: 'success' | 'reverted' = receipt?.status === 'success' ? 'success' : 'reverted';

  onProgress('Fetching execution trace (callTracer)…');
  const tree = await buildCallTree(chainId, hash);
  onProgress('Decoding call tree…');
  const nodeCount = countNodes(tree);

  const report: AnalysisReport = {
    chainId,
    hash,
    explorerUrl: explorerTxUrl(chainId, hash),
    status,
    block: tx.blockNumber?.toString() ?? 'pending',
    from: tx.from,
    to: tx.to,
    toLabel: tx.to ? (await resolveContract(tx.to, chainId)).name : undefined,
    entry: { selector: tx.input.slice(0, 10), functionName: tree.fn?.functionName },
    tree,
    nodeCount,
    failurePathIds: [],
    summary: [],
  };

  if (status === 'reverted' || tree.failed) {
    const path = failurePath(tree);
    report.failurePathIds = path.map((n) => n.id);
    const deepest = path[path.length - 1]; // revert origin — carries the reason string
    // Logical attribution: deepest failing CALL (delegatecalls run in the caller's
    // context, so their from/to don't reflect the real msg.sender/contract).
    const logical = [...path].reverse().find((n) => n.type === 'CALL') ?? deepest;
    if (deepest) {
      onProgress(`Reason traced to ${logical.toLabel}.${fnLabel(logical)} (node ${deepest.id})…`);
      const revert = deepest.revert ?? logical.revert;
      report.reason = {
        message: revert?.message,
        kind: revert?.kind ?? 'unknown',
        errorName: revert?.errorName,
        originId: logical.id,
        originContract: logical.toLabel,
        originAddress: logical.to,
      };

      // Code-grounded explanation: read the failing contract's source
      // (verified on Sonicscan, else our local repo) and reason about it.
      onProgress('Reading contract source and analyzing root cause…');
      const callerC = logical.from ? await resolveContract(logical.from, chainId) : null;
      const blockNumber = tx.blockNumber !== undefined ? tx.blockNumber - 1n : undefined;

      // Collect participant addresses: tx sender, the caller/contract, and any
      // address-typed args of the failing call. Label them + value tokens.
      const addrRe = /^0x[0-9a-fA-F]{40}$/;
      const candidate = new Set<string>();
      if (tx.from) candidate.add(tx.from);
      if (logical.from) candidate.add(logical.from);
      if (logical.to) candidate.add(logical.to);
      for (const a of logical.fn?.args ?? []) {
        const m = a.value.match(/0x[0-9a-fA-F]{40}/g);
        if (m) m.forEach((x) => candidate.add(x));
      }
      const participants = await Promise.all(
        [...candidate].slice(0, 16).map(async (addr) => {
          if (!addrRe.test(addr)) return null;
          const [c, ti] = await Promise.all([
            resolveContract(addr, chainId),
            getTokenInfo(chainId, addr, blockNumber).catch(() => null),
          ]);
          return {
            address: addr,
            label: c.name,
            symbol: ti?.symbol,
            decimals: ti?.decimals,
            usdPrice: ti?.usdPrice,
          };
        }),
      );

      // Pre-compute human + USD for amount-like args, valued against the
      // failing call's token arg(s), so the LLM never does decimal/USD math.
      const tokenArgs = (await Promise.all(
        (logical.fn?.args ?? [])
          .filter((a) => /address/.test(a.type) && /^0x[0-9a-fA-F]{40}$/.test(a.value))
          .map(async (a) => ({ addr: a.value, info: await getTokenInfo(chainId, a.value, blockNumber).catch(() => null) })),
      )).filter((t) => t.info?.decimals !== undefined);
      const valuedAmounts: string[] = [];
      const uintArgs = (logical.fn?.args ?? []).filter((a) => /^uint/.test(a.type) && /^\d+$/.test(a.value));
      for (const ua of uintArgs) {
        const raw = BigInt(ua.value);
        // value against each priced token arg (usually just one, e.g. borrow(token, amount))
        for (const t of tokenArgs) {
          const dec = t.info!.decimals!;
          const human = Number(raw) / 10 ** dec;
          const sym = t.info!.symbol ?? 'token';
          const usd = t.info!.usdPrice !== undefined ? ` ≈ ${fmtUsd(human * t.info!.usdPrice!)}` : '';
          valuedAmounts.push(`${ua.name} = ${human.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${sym}${usd} (raw ${ua.value}, ${dec} decimals${tokenArgs.length > 1 ? `, if ${sym}` : ''})`);
        }
      }

      const { explanation, sources } = await explainFailure({
        chainId,
        txHash: hash,
        contract: logical.toLabel,
        address: logical.to,
        functionSignature: logical.fn?.signature,
        functionName: logical.fn?.functionName,
        args: logical.fn?.args,
        originSender: tx.from,
        caller: logical.from,
        callerLabel: callerC?.name,
        participants: participants.filter(Boolean) as any[],
        valuedAmounts,
        reason: revert?.message,
        errorName: revert?.errorName,
        callPath: path.map((n) => `${n.toLabel}.${fnLabel(n)}`),
        blockNumber,
      });
      report.explanation = explanation;
      report.sources = sources
        .filter((s: SourceResult) => s.origin !== 'none')
        .map((s: SourceResult) => ({ origin: s.origin, contractName: s.contractName, file: s.file, code: s.code }));
      report.participants = (participants.filter(Boolean) as any[]).map((p) => ({
        ...p,
        isSender: p.address.toLowerCase() === tx.from?.toLowerCase(),
        isActor: !!logical.from && p.address.toLowerCase() === logical.from.toLowerCase(),
      }));
    }
  }

  report.summary = buildSummary(report);
  onProgress('Done.');
  return report;
}

function buildSummary(r: AnalysisReport): string[] {
  const lines: string[] = [];
  const verb = r.status === 'success' ? 'succeeded' : 'REVERTED';
  lines.push(`${r.toLabel ?? r.to}.${r.entry.functionName ?? r.entry.selector} — ${verb} (${r.nodeCount} internal calls).`);
  if (r.reason) {
    const where = `${r.reason.originContract}${r.reason.originAddress ? ` (${r.reason.originAddress.slice(0, 10)}…)` : ''}`;
    if (r.reason.message) lines.push(`Reverted in ${where}: ${r.reason.message}.`);
    else lines.push(`Reverted in ${where} (reason not decodable).`);
  }
  if (r.explanation?.summary) lines.push(`Root cause: ${r.explanation.summary}`);
  return lines;
}
