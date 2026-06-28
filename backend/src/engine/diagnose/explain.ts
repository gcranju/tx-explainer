import { gatherSource, type SourceResult } from '../source/fetchSource.js';
import { llmJson, resolveLlm, getLastLlmError } from './llm.js';
import { makeExecutor } from './tools.js';

export interface ExplainInput {
  chainId: number;
  txHash: string;
  /** label + address of the contract that reverted (logical origin) */
  contract: string;
  address?: string;
  /** the function that was executing, e.g. "borrow(address,uint256)" */
  functionSignature?: string;
  functionName?: string;
  /** decoded arguments to that function */
  args?: { name: string; type: string; value: string }[];
  /** the EOA / account that submitted the transaction */
  originSender?: string;
  /** the caller (msg.sender) into the reverting contract */
  caller?: string;
  callerLabel?: string;
  /** labeled addresses involved (tokens carry symbol/decimals/usdPrice) */
  participants?: { address: string; label?: string; symbol?: string; decimals?: number; usdPrice?: number }[];
  /** decoded revert reason */
  reason?: string;
  errorName?: string;
  /** the chain of contracts from entrypoint down to the revert origin */
  callPath?: string[];
  /** pre-computed human + USD values for amount-like args (avoids LLM math errors) */
  valuedAmounts?: string[];
  /** block to read on-chain state at (parent of the tx block = failure-time state) */
  blockNumber?: bigint;
}

export interface Explanation {
  summary: string;
  why: string;
  howToFix: string[];
  confidence: 'high' | 'medium' | 'low';
  groundedIn: string; // where the reasoning came from
  model?: string;
}

function buildPrompt(input: ExplainInput, sources: SourceResult[]): string {
  const argLines = (input.args ?? []).map((a) => `  - ${a.name} (${a.type}) = ${a.value}`).join('\n') || '  (none decoded)';
  const sourceBlocks = sources
    .map((s) => {
      if (s.origin === 'none') return null;
      const header = s.origin === 'sonicscan-verified'
        ? `Verified source of ${s.contractName ?? 'contract'}${s.note ? ` [${s.note}]` : ''}`
        : `Local Sodax source (${s.file})`;
      return `### ${header}\n\`\`\`solidity\n${s.code}\n\`\`\``;
    })
    .filter(Boolean)
    .join('\n\n') || '(no source could be located — reason from the revert and call data alone, and lower your confidence)';

  const participantLines = (input.participants ?? [])
    .map((p) => {
      const bits = [p.label, p.symbol ? `token ${p.symbol}` : undefined, p.decimals !== undefined ? `${p.decimals} decimals` : undefined, p.usdPrice !== undefined ? `~$${p.usdPrice} each` : undefined].filter(Boolean);
      return `  - ${p.address}${bits.length ? ` — ${bits.join(', ')}` : ''}`;
    })
    .join('\n') || '  (none)';

  return `A transaction on Sonic (chain ${input.chainId}) reverted. Determine, from the contract source below, what the error means, why it arose in THIS transaction, and how to fix it.

## Transaction context
- Tx sender (submitter): ${input.originSender ?? '(unknown)'}
- Participant addresses (tokens carry symbol/decimals/USD price):
${participantLines}

## The failing call
- Reverting contract: ${input.contract}${input.address ? ` (${input.address})` : ''}
- Function: ${input.functionSignature ?? input.functionName ?? '(unknown)'}
- Called by (msg.sender): ${input.callerLabel ?? ''} ${input.caller ?? ''}
- Arguments:
${argLines}${input.valuedAmounts?.length ? `\n- Pre-computed amounts (use these verbatim — do NOT recompute decimals/USD yourself):\n${input.valuedAmounts.map((v) => `  - ${v}`).join('\n')}` : ''}
- Decoded revert reason: ${input.reason ?? '(none)'}${input.errorName ? ` (error ${input.errorName})` : ''}
${input.callPath?.length ? `- Call path: ${input.callPath.join(' → ')}` : ''}

## Relevant source code
${sourceBlocks}

## Instructions
- Find the exact \`require\`/\`revert\`/error in the source that produced this revert reason, and base your explanation on that condition.
- You have tools: \`read_contract\` (call any view function at the failing block) and \`get_source\` (fetch any contract's source). When the failing condition depends on on-chain state or another contract's logic, USE THEM to confirm the actual values — e.g. read the variables/registry/limits the condition compares, and fetch the source of collaborators the function calls. Ground "why" in values you actually read, not assumptions.
- "why" must be specific to this transaction: tie the failing condition to the actual arguments and the on-chain values you read.
- Always identify the ACTOR — the address that triggered the failing condition (the \`msg.sender\` into the reverting contract, i.e. the borrower/caller/spender for this revert). State its address AND, if it is a contract, its contract name (from the participants list or via get_source). When a limit/balance/cap is per-account, read that account's specific value with read_contract and quote it.
- Name the relevant participant addresses and tokens; express token amounts in human units AND USD where possible (use the \`token_info\` tool for decimals + USD price). Do not give generic advice.
- "howToFix" must be concrete and actionable for an operator/integrator of these contracts.
- If the provided source does not actually contain the failing condition, say so in "why" and set confidence to "low" — do not invent code.
- Keep it tight; no preamble.

## How to investigate (important)
You work in rounds. Instead of saying you "could" read something, REQUEST the read and I will execute it and return the value to you next round.

Respond with ONLY a JSON object:
{
  "reads":  [ { "address": "0x..", "signature": "borrowerLimits(address) view returns (uint256)", "args": ["0x.."] }, ... ],   // on-chain reads you need; [] if none
  "done":   true|false,                 // false if you still need read results before concluding
  "summary": "...", "why": "...", "howToFix": ["..."], "confidence": "high|medium|low"   // fill ONLY when done=true
}
- When the failing condition compares against on-chain state (a per-account limit, balance, cap, registry entry, current total, owner, etc.), set done=false and put the exact reads in "reads" — read the account-specific value the condition uses (e.g. the actor's own limit AND current usage). To reach a collaborator you only know by getter, first read that getter (e.g. assetManager()), then use its result next round.
- When you have the concrete numbers, set done=true and quote them in "why" (human + USD where applicable). Do not leave "we can read X" in the final answer — actually request it first.
- IMPORTANT — read results are RAW integers (base units), not human numbers. Before quoting one, determine its scale FROM THE SOURCE: token amounts divide by the token's decimals; USD/price/limit values in these money-market / lending contracts are 8-decimal fixed-point (divide by 1e8) — e.g. a limit of 1000000000000 is $10,000, not $1,000,000,000. Cross-check against the pre-computed amounts above, which are already human + USD.`;
}

const NO_LLM_HINT = 'No LLM configured. Set LLM_BASE_URL + LLM_MODEL (e.g. free Groq/Gemini/OpenRouter) or run a local Ollama, or set ANTHROPIC_API_KEY.';
const FALLBACK = (input: ExplainInput, sources: SourceResult[]): Explanation => ({
  summary: input.reason ? `Reverted with: ${input.reason}.` : 'Reverted without a decodable reason.',
  why: `${NO_LLM_HINT} Inspect the source snippet below for the failing condition.`,
  howToFix: sources.some((s) => s.origin !== 'none')
    ? ['Review the located source around the revert site.', 'Configure a free LLM (Groq/Gemini/OpenRouter) or local Ollama to enable automated root-cause analysis.']
    : ['Configure a free LLM (Groq/Gemini/OpenRouter) or local Ollama to enable analysis.', 'Verify the contract on Sonicscan or add it to LOCAL_CONTRACTS_DIR so source can be located.'],
  confidence: 'low',
  groundedIn: sources.map((s) => s.origin).filter((o) => o !== 'none').join(', ') || 'no source',
});

// Pre-divide single large integers at common scales so the model never has to
// do decimal arithmetic (it only picks the right scale from the source).
function scaleHints(out: string): string {
  const nums = out.match(/\d{7,}/g);
  if (!nums || nums.length !== 1) return '';
  const n = Number(nums[0]);
  if (!isFinite(n)) return '';
  const f = (d: number) => (n / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: 4 });
  return `  [if scaled: ÷1e6=${f(6)}, ÷1e8=${f(8)} (8-dec USD), ÷1e18=${f(18)}]`;
}

export async function explainFailure(input: ExplainInput): Promise<{ explanation: Explanation; sources: SourceResult[] }> {
  // Gather source for the reverting contract (verified → local fallback).
  const sources: SourceResult[] = [];
  const primary = await gatherSource(input.chainId, input.address, input.reason, input.errorName);
  sources.push(primary);
  // If the explorer gave us nothing, the local revert-site search may still find it (already inside gatherSource),
  // but also try a pure local lookup when verified source existed yet didn't contain the reason.
  if (primary.origin === 'sonicscan-verified') {
    const { findLocalRevertSite } = await import('../source/fetchSource.js');
    const local = findLocalRevertSite(input.reason, input.errorName);
    if (local) sources.push({ origin: 'local-repo', file: local.file, code: local.snippet });
  }

  const llm = await resolveLlm();
  if (llm.provider === 'none') return { explanation: FALLBACK(input, sources), sources };

  const groundedIn = sources
    .map((s) => (s.origin === 'sonicscan-verified' ? `verified:${s.contractName}` : s.origin === 'local-repo' ? `local:${s.file}` : ''))
    .filter(Boolean)
    .join(', ') || 'no source';

  const exec = makeExecutor(input.chainId, input.blockNumber);
  const base = buildPrompt(input, sources);
  const readLog: string[] = []; // human-readable "read → result" lines fed back each round
  let parsed: any = null;
  let lastModel = `${llm.provider}:${llm.model ?? '?'}`;

  const MAX_ROUNDS = 6;
  let badJson = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const force = round >= MAX_ROUNDS - 1; // last round: must conclude
    const prompt =
      base +
      (readLog.length ? `\n\n## Read results so far\n${readLog.join('\n')}` : '') +
      (badJson ? '\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object described above.' : '') +
      (force ? '\n\nFinal round — set done=true and answer with the values you already have.' : '');

    const result = await llmJson(prompt); // no native tools — deterministic read loop instead
    lastModel = result?.info ? `${result.info.provider}:${result.info.model ?? '?'}` : lastModel;
    const obj = result?.obj;
    if (!obj) { badJson = true; continue; } // retry rather than abort
    badJson = false;

    const reads = Array.isArray(obj.reads) ? obj.reads.slice(0, 8) : [];
    // The model often emits empty placeholder answer fields ("summary":"", …)
    // while still asking for reads with done:false. Only treat a NON-EMPTY
    // summary as a conclusion, and always run pending reads unless done:true.
    const hasAnswer = typeof obj.summary === 'string' && obj.summary.trim().length > 0;
    if (!force && reads.length && obj.done !== true) {
      for (const r of reads) {
        try {
          const out = await exec('read_contract', { address: r.address, signature: r.signature, args: r.args ?? [] });
          readLog.push(`- read ${r.signature} @ ${r.address} (${(r.args ?? []).join(', ')}) → ${out}${scaleHints(out)}`);
        } catch (e: any) {
          readLog.push(`- read ${r.signature} @ ${r.address} → error: ${e?.message ?? e}`);
        }
      }
      continue; // feed results back
    }
    const concluding = obj.done === true || hasAnswer;
    if (concluding) { parsed = obj; break; }
    if (force) { parsed = obj; break; } // accept whatever we have on the last round
    // obj had neither reads nor a conclusion — nudge it to conclude next round
    readLog.push('- (no further reads requested)');
  }

  if (!parsed) {
    const fb = FALLBACK(input, sources);
    const err = getLastLlmError();
    fb.why = err
      ? `LLM call failed: ${err}. (Provider: ${llm.provider}, model: ${llm.model}.) The decoded reason and source snippet below still stand; retry once the limit resets, or switch LLM_MODEL/provider.`
      : `LLM analysis returned no usable JSON (provider: ${llm.provider}, model: ${llm.model}). Source snippet is below.`;
    return { explanation: fb, sources };
  }

  return {
    explanation: {
      summary: parsed.summary ?? '',
      why: parsed.why ?? '',
      howToFix: Array.isArray(parsed.howToFix) ? parsed.howToFix : parsed.howToFix ? [String(parsed.howToFix)] : [],
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
      groundedIn: groundedIn + (readLog.length ? ` · ${readLog.length} on-chain reads` : ''),
      model: lastModel,
    },
    sources,
  };
}
