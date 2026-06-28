import './engine/env.js';
import { analyzeTx } from './engine/analyze.js';
import { DEFAULT_CHAIN_ID } from './engine/rpc.js';
import type { TraceNode } from './engine/trace/callTrace.js';

const hash = process.argv[2];
const chainId = process.argv[3] ? Number(process.argv[3]) : DEFAULT_CHAIN_ID;
const showAll = process.argv.includes('--all');
if (!hash) {
  console.error('usage: npm run analyze <txHash> [chainId] [--all]');
  process.exit(1);
}

const report = await analyzeTx(hash, chainId, (m) => console.error(`  · ${m}`));

function argline(n: TraceNode): string {
  if (!n.fn) return '';
  if (!n.fn.args.length) return n.fn.partial ? '(…)' : '()';
  return '(' + n.fn.args.map((a) => `${a.value.length > 18 ? a.value.slice(0, 18) + '…' : a.value}`).join(', ') + ')';
}
function printNode(n: TraceNode, failing: Set<string>) {
  const onPath = failing.has(n.id);
  // Hide deep successful STATICCALL noise unless --all.
  if (!showAll && n.type === 'STATICCALL' && !onPath) return;
  const pad = '  '.repeat(n.depth);
  const mark = n.failed ? '✗' : ' ';
  const fn = n.fn?.functionName ?? n.fn?.selector ?? '';
  const t = n.type === 'CALL' ? '' : `[${n.type}] `;
  console.log(`${mark} ${pad}${t}${n.toLabel}.${fn}${argline(n)}`);
  for (const c of n.children) printNode(c, failing);
}

console.log('\n================ TX REPORT ================');
console.log(`status : ${report.status}`);
console.log(`to     : ${report.toLabel ?? report.to}`);
console.log(`calls  : ${report.nodeCount}`);
console.log('\nSummary:');
for (const l of report.summary) console.log(`  • ${l}`);

console.log(`\nCall tree${showAll ? '' : ' (failing path + CALLs; --all for everything)'}:`);
printNode(report.tree, new Set(report.failurePathIds));

if (report.reason) {
  console.log(`\nReason: ${report.reason.message ?? '(undecodable)'}`);
  console.log(`  origin: ${report.reason.originContract} node ${report.reason.originId}`);
}
if (report.explanation) {
  const e = report.explanation;
  console.log(`\nExplanation [confidence: ${e.confidence}] (grounded in: ${e.groundedIn})`);
  console.log(`\nWhat it means: ${e.summary}`);
  console.log(`\nWhy it happened: ${e.why}`);
  if (e.howToFix.length) { console.log('\nHow to fix:'); for (const f of e.howToFix) console.log(`  → ${f}`); }
}
console.log('==========================================\n');
