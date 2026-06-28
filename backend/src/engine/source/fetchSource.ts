import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Local Sodax contract sources (for contracts not verified on the explorer).
const LOCAL_CONTRACTS_DIR =
  process.env.LOCAL_CONTRACTS_DIR ?? '/Users/meera/work/sodax-contracts/evm/contracts';

// Etherscan v2 multichain API (covers Sonic, chainid 146). Optional key.
const EXPLORER_API = process.env.EXPLORER_API ?? 'https://api.etherscan.io/v2/api';
const EXPLORER_API_KEY = process.env.SONICSCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY ?? '';

export interface SourceResult {
  origin: 'sonicscan-verified' | 'local-repo' | 'none';
  contractName?: string;
  /** concatenated source (possibly trimmed) */
  code?: string;
  /** path/snippet when located locally */
  file?: string;
  note?: string;
}

interface VerifiedSource {
  contractName: string;
  code: string;
  isProxy: boolean;
  implementation?: string;
}

const verifiedCache = new Map<string, VerifiedSource | null>();

/** Fetch verified source for an address from the explorer. Handles multi-file JSON. */
export async function getVerifiedSource(chainId: number, address: string): Promise<VerifiedSource | null> {
  const key = `${chainId}:${address.toLowerCase()}`;
  if (verifiedCache.has(key)) return verifiedCache.get(key)!;
  try {
    const url = `${EXPLORER_API}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}${EXPLORER_API_KEY ? `&apikey=${EXPLORER_API_KEY}` : ''}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const data: any = await res.json();
    const entry = data?.result?.[0];
    if (!entry || !entry.SourceCode || entry.ABI === 'Contract source code not verified') {
      verifiedCache.set(key, null);
      return null;
    }
    let code = entry.SourceCode as string;
    // Standard-JSON input is wrapped in an extra brace: {{ ... }}
    if (code.startsWith('{{') || code.startsWith('{')) {
      try {
        const parsed = JSON.parse(code.startsWith('{{') ? code.slice(1, -1) : code);
        const sources = parsed.sources ?? parsed;
        code = Object.entries(sources)
          .map(([path, v]: [string, any]) => `// === ${path} ===\n${v.content ?? v}`)
          .join('\n\n');
      } catch {
        // leave as-is (flattened single file)
      }
    }
    const isProxy = entry.Proxy === '1';
    const implementation = entry.Implementation || undefined;
    // Proxy contracts hold no logic — follow to the implementation's source.
    if (isProxy && implementation && implementation.toLowerCase() !== address.toLowerCase()) {
      const impl = await getVerifiedSource(chainId, implementation);
      if (impl) {
        const result: VerifiedSource = {
          contractName: impl.contractName,
          code: impl.code,
          isProxy: true,
          implementation,
        };
        verifiedCache.set(key, result);
        return result;
      }
    }
    const result: VerifiedSource = {
      contractName: entry.ContractName || 'Unknown',
      code,
      isProxy,
      implementation,
    };
    verifiedCache.set(key, result);
    return result;
  } catch {
    verifiedCache.set(key, null);
    return null;
  }
}

function walkSol(dir: string, out: string[]) {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkSol(p, out);
    else if (e.endsWith('.sol')) out.push(p);
  }
}

let solFilesCache: string[] | null = null;
function solFiles(): string[] {
  if (!solFilesCache) { solFilesCache = []; walkSol(LOCAL_CONTRACTS_DIR, solFilesCache); }
  return solFilesCache;
}

/**
 * Find the revert site in our local sources by searching for the revert string
 * or the custom error name, and return a focused snippet around it.
 */
export function findLocalRevertSite(reasonMessage?: string, errorName?: string): { file: string; snippet: string } | null {
  // Needles to search for, in rough priority.
  const needles: string[] = [];
  if (errorName) needles.push(errorName);
  let constName: string | undefined;
  if (reasonMessage) {
    constName = reasonMessage.split(' ')[0]; // Aave-mapped: "BORROW_CAP_EXCEEDED — ..."
    if (/^[A-Z0-9_]+$/.test(constName)) needles.push(constName);
    needles.push(reasonMessage);
  }
  if (!needles.length) return null;

  interface Cand { file: string; lineNo: number; line: string; score: number }
  const cands: Cand[] = [];
  for (const file of solFiles()) {
    let lines: string[];
    try { lines = readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!needles.some((n) => line.includes(n))) continue;
      let score = 0;
      if (/\brequire\s*\(/.test(line)) score += 10; // the actual check
      if (/\brevert\b/.test(line)) score += 8;
      if (constName && line.includes(`Errors.${constName}`)) score += 6; // usage of the code
      if (/=\s*['"]\d+['"]\s*;/.test(line)) score -= 6; // a constant *definition* line
      if (errorName && line.includes(`error ${errorName}`)) score += 6;
      if (file.endsWith('Errors.sol')) score -= 3; // prefer the throw-site over the codes file
      cands.push({ file, lineNo: i, line, score });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  const lines = readFileSync(best.file, 'utf8').split('\n');
  const from = Math.max(0, best.lineNo - 14);
  const to = Math.min(lines.length, best.lineNo + 8);
  const snippet = lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join('\n');
  return { file: best.file.replace(LOCAL_CONTRACTS_DIR, 'contracts'), snippet };
}

/** Gather best-available source context for a failing contract. */
export async function gatherSource(
  chainId: number,
  address: string | undefined,
  reasonMessage?: string,
  errorName?: string,
): Promise<SourceResult> {
  // 1. Verified source from the explorer (handles external + our verified contracts).
  if (address) {
    const v = await getVerifiedSource(chainId, address);
    if (v) {
      // Prefer a focused window around the revert site to keep token usage low;
      // only send the whole thing when small and no match is found.
      let code = v.code;
      const site = findInString(code, reasonMessage, errorName);
      if (site) code = site;
      else if (code.length > 8000) code = code.slice(0, 8000);
      return { origin: 'sonicscan-verified', contractName: v.contractName, code, note: v.isProxy ? `proxy → ${v.implementation}` : undefined };
    }
  }
  // 2. Local repo fallback by revert string / error name.
  const local = findLocalRevertSite(reasonMessage, errorName);
  if (local) return { origin: 'local-repo', file: local.file, code: local.snippet };

  return { origin: 'none' };
}

function findInString(code: string, reasonMessage?: string, errorName?: string): string | null {
  const needles = [errorName, reasonMessage?.split(' ')[0], reasonMessage].filter(Boolean) as string[];
  for (const n of needles) {
    const idx = code.indexOf(n);
    if (idx >= 0) return code.slice(Math.max(0, idx - 1200), idx + 800);
  }
  return null;
}
