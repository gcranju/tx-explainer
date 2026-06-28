export interface DecodedArg { name: string; type: string; value: string }
export interface DecodedFunctionCall {
  selector: string;
  functionName?: string;
  signature?: string;
  args: DecodedArg[];
  partial: boolean;
  source: 'local-abi' | 'signature-db' | 'unknown';
}
export interface DecodedRevert {
  raw: string;
  kind: string;
  message?: string;
  errorName?: string;
  signature?: string;
}
export interface TraceNode {
  id: string;
  depth: number;
  type: string;
  from: string;
  to?: string;
  fromLabel: string;
  toLabel: string;
  toKind: string;
  valueWei?: string;
  gasUsed?: number;
  fn: DecodedFunctionCall | null;
  failed: boolean;
  errorRaw?: string;
  revert?: DecodedRevert;
  children: TraceNode[];
}
export interface Explanation {
  summary: string;
  why: string;
  howToFix: string[];
  confidence: 'high' | 'medium' | 'low';
  groundedIn: string;
  model?: string;
}
export interface SourceRef {
  origin: string;
  contractName?: string;
  file?: string;
  code?: string;
}
export interface AnalysisReport {
  chainId: number;
  hash: string;
  explorerUrl?: string;
  status: 'success' | 'reverted';
  block: string;
  from: string;
  to: string | null;
  toLabel?: string;
  entry: { selector: string; functionName?: string };
  tree: TraceNode;
  nodeCount: number;
  failurePathIds: string[];
  reason?: { message?: string; kind: string; errorName?: string; originId: string; originContract: string; originAddress?: string };
  explanation?: Explanation;
  sources?: SourceRef[];
  participants?: { address: string; label?: string; symbol?: string; decimals?: number; usdPrice?: number; isSender?: boolean; isActor?: boolean }[];
  summary: string[];
}
