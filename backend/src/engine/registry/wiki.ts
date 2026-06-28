import { existsSync, readFileSync } from 'node:fs';

// Parse the repo's Wiki.md into an address → human label map. Supports both
//   "Some Name: [0xADDR](url)"
//   "| Some Name | [0xADDR](url) | ... |"
const WIKI_FILE = process.env.WIKI_FILE ?? '/Users/meera/work/sodax-contracts/Wiki.md';

let map: Map<string, string> | null = null;

function clean(s: string): string {
  return s
    .replace(/\[[^\]]*\]\([^)]*\)/g, '') // strip markdown links
    .replace(/[|*`#>]/g, '')
    .replace(/\(.*$/, '')
    .replace(/[:\-–—]\s*$/, '')
    .trim();
}

export function wikiMap(): Map<string, string> {
  if (map) return map;
  map = new Map();
  if (!existsSync(WIKI_FILE)) return map;
  let lines: string[];
  try { lines = readFileSync(WIKI_FILE, 'utf8').split('\n'); } catch { return map; }
  for (const line of lines) {
    const addrs = line.match(/0x[0-9a-fA-F]{40}\b/g);
    if (!addrs) continue;
    let label = '';
    if (line.trimStart().startsWith('|')) {
      // table row: label is the first non-empty cell that isn't the address
      const cells = line.split('|').map((c) => clean(c)).filter(Boolean);
      label = cells.find((c) => !/^0x[0-9a-fA-F]{40}$/i.test(c)) ?? '';
    } else {
      // "Label: [0x..]" — text before the first address / bracket / colon
      const before = line.slice(0, line.indexOf(addrs[0])).replace(/\[$/, '');
      label = clean(before.split(':')[0] ?? before);
    }
    if (!label || label.length > 60) continue;
    for (const a of addrs) if (!map.has(a.toLowerCase())) map.set(a.toLowerCase(), label);
  }
  return map;
}

export function wikiLabel(address: string): string | undefined {
  return wikiMap().get(address.toLowerCase());
}
