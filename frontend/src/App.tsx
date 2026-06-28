import { useState, useRef } from 'react';
import type { AnalysisReport, TraceNode } from './types.js';

const BACKEND = (import.meta as any).env?.VITE_BACKEND ?? 'http://localhost:8787';

export function App() {
  const [hash, setHash] = useState('0xf290216da139500a5c3bbfdb5d745cf6bdbf6d6394b371d147a32ce400e0d5d5');
  const [chainId, setChainId] = useState('146');
  const [progress, setProgress] = useState<string[]>([]);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  function analyze() {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash.trim())) { setError('Enter a valid 0x… 32-byte tx hash'); return; }
    esRef.current?.close();
    setReport(null); setError(null); setProgress([]); setRunning(true);
    const es = new EventSource(`${BACKEND}/analyze?hash=${hash.trim()}&chainId=${chainId}`);
    esRef.current = es;
    es.addEventListener('progress', (e) => setProgress((p) => [...p, JSON.parse((e as MessageEvent).data).msg]));
    es.addEventListener('report', (e) => { setReport(JSON.parse((e as MessageEvent).data)); setRunning(false); es.close(); });
    es.addEventListener('error', (e) => {
      const msg = (e as MessageEvent).data ? JSON.parse((e as MessageEvent).data).message : 'connection error';
      setError(msg); setRunning(false); es.close();
    });
  }

  return (
    <div className="wrap">
      <header>
        <h1>Sodax Tx Explainer</h1>
        <p className="sub">Decodes the full call tree of any transaction, finds the revert reason, and explains it.</p>
      </header>
      <div className="bar">
        <input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="0x… tx hash" spellCheck={false} />
        <input className="chain" value={chainId} onChange={(e) => setChainId(e.target.value)} title="chain id" />
        <button onClick={analyze} disabled={running}>{running ? 'Analyzing…' : 'Analyze'}</button>
      </div>
      {error && <div className="err">⚠ {error}</div>}
      {running && <div className="progress">{progress.map((p, i) => <div key={i}>· {p}</div>)}</div>}
      {report && <Report report={report} />}
    </div>
  );
}

function Report({ report }: { report: AnalysisReport }) {
  const failed = report.status === 'reverted';
  const failSet = new Set(report.failurePathIds);
  return (
    <div className="report">
      <div className={`statusbar ${failed ? 'reverted' : 'ok'}`}>
        <span className="badge">{failed ? 'REVERTED' : 'SUCCESS'}</span>
        <span>{report.toLabel ?? report.to}.{report.entry.functionName ?? report.entry.selector}</span>
        <span className="muted">{report.nodeCount} calls · block {report.block}</span>
        {report.explorerUrl && <a href={report.explorerUrl} target="_blank" rel="noreferrer">explorer ↗</a>}
      </div>

      <section className="summary">{report.summary.map((s, i) => <div key={i}>• {s}</div>)}</section>

      {report.reason && (
        <section className="reason">
          <div className="rlabel">REVERT REASON</div>
          <div className="rmsg">{report.reason.message ?? '(not decodable from trace)'}</div>
          <div className="rwhere">origin: <b>{report.reason.originContract}</b>{report.reason.originAddress ? ` · ${report.reason.originAddress}` : ''}</div>
        </section>
      )}

      {report.participants && report.participants.length > 0 && (
        <section className="parts">
          <div className="rlabel">PARTICIPANTS</div>
          {report.participants.map((p, i) => (
            <div key={i} className="part">
              {p.isActor && <span className="ptag actor">actor</span>}
              {p.isSender && <span className="ptag sender">sender</span>}
              <span className="pl">{p.label}</span>
              <span className="pa">{p.address}</span>
              {p.symbol && <span className="pt">{p.symbol}{p.decimals !== undefined ? ` · ${p.decimals}d` : ''}{p.usdPrice !== undefined ? ` · $${p.usdPrice}` : ''}</span>}
            </div>
          ))}
        </section>
      )}

      {report.explanation && (
        <section className="diag error">
          <h2>Root cause <span className="conf">{report.explanation.confidence} confidence · grounded in {report.explanation.groundedIn}{report.explanation.model ? ` · ${report.explanation.model}` : ''}</span></h2>
          <p>{report.explanation.summary}</p>
          <h3>Why it happened</h3>
          <p>{report.explanation.why}</p>
          {report.explanation.howToFix.length > 0 && (<><h3>How to fix</h3><ul className="fixes">{report.explanation.howToFix.map((f, i) => <li key={i}>{f}</li>)}</ul></>)}
          {report.sources && report.sources.length > 0 && (
            <details className="src" open>
              <summary>Source the analysis was grounded in (errored lines highlighted)</summary>
              {report.sources.map((s, i) => (
                <div key={i}>
                  <div className="srch">{s.origin === 'sonicscan-verified' ? `verified · ${s.contractName}` : s.file}</div>
                  {s.code && <CodeBlock code={s.code} reason={report.reason} />}
                </div>
              ))}
            </details>
          )}
        </section>
      )}

      <section className="tree">
        <h3>Call tree</h3>
        <Node node={report.tree} failSet={failSet} />
      </section>
    </div>
  );
}

function CodeBlock({ code, reason }: { code: string; reason?: AnalysisReport['reason'] }) {
  const needles: string[] = [];
  if (reason?.errorName) needles.push(reason.errorName);
  if (reason?.message) {
    needles.push(reason.message);
    const tok = reason.message.split(' ')[0];
    if (/^[A-Z0-9_]{3,}$/.test(tok)) needles.push(tok); // Aave-style constant
  }
  const isErr = (line: string) =>
    needles.some((n) => line.includes(n)) ||
    (/\b(require|revert)\b/.test(line) && needles.some((n) => line.includes(n)));
  return (
    <pre>
      {code.split('\n').map((line, i) => (
        <div key={i} className={isErr(line) ? 'errline' : undefined}>{line || ' '}</div>
      ))}
    </pre>
  );
}

function argline(n: TraceNode): string {
  if (!n.fn) return '';
  if (!n.fn.args.length) return n.fn.partial ? '(…)' : '()';
  return '(' + n.fn.args.map((a) => (a.value.length > 22 ? a.value.slice(0, 22) + '…' : a.value)).join(', ') + ')';
}

function Node({ node, failSet }: { node: TraceNode; failSet: Set<string> }) {
  const onPath = failSet.has(node.id);
  // Auto-expand the failing path and the first couple of levels; collapse deep success noise.
  const [open, setOpen] = useState(onPath || node.depth < 2);
  const hasKids = node.children.length > 0;
  const fn = node.fn?.functionName ?? node.fn?.selector ?? '(no calldata)';
  const isView = node.type === 'STATICCALL';
  return (
    <div className={`node ${node.failed ? 'failed' : ''} ${onPath ? 'onpath' : ''}`}>
      <div className="row" onClick={() => hasKids && setOpen(!open)}>
        <span className="tog">{hasKids ? (open ? '▾' : '▸') : '·'}</span>
        {node.failed && <span className="x">✗</span>}
        {node.type !== 'CALL' && <span className={`ty ${isView ? 'view' : ''}`}>{node.type}</span>}
        <span className="ct">{node.toLabel}</span>
        <span className="cf">.{fn}</span>
        <span className="ar">{argline(node)}</span>
        {node.fn?.source === 'signature-db' && <span className="tag">sig-db</span>}
        {node.fn?.source === 'unknown' && <span className="tag warn">unknown</span>}
        {node.failed && node.revert?.message && <span className="rev">↯ {node.revert.message}</span>}
      </div>
      {open && hasKids && (
        <div className="kids">
          {node.children.map((c) => <Node key={c.id} node={c} failSet={failSet} />)}
        </div>
      )}
    </div>
  );
}
