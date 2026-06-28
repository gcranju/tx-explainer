# Sodax Tx Explainer

A Tenderly-style transaction explainer for Sonic. It pulls the **full execution
call tree of any transaction**, decodes every node (what called what, with which
function and args), finds the **revert reason**, and — when it can — explains the
root cause in Sodax terms.

It is **general**: it works for any contract, not just Sodax. Sodax-specific
knowledge (per-borrower limits, money-market error codes, etc.) is layered on top
as optional enrichment; if nothing matches, it still shows the decoded reason and
leaves it at that.

## How it works

1. **Trace** — `debug_traceTransaction` with `callTracer` (Sonic's RPC serves this
   natively and fast). This yields the real nested call tree, including the inner
   calls a batch router actually made — so no batch-format reverse-engineering.
2. **Decode each node** — function + args via the foundry `out/` ABIs, falling
   back to the openchain signature DB for contracts built from a divergent source.
   Contracts are labeled via a small registry + on-chain ERC20 probing.
3. **Find the reason** — walk to the deepest failing node (the revert origin),
   decode its revert: `Error(string)`, `Panic(uint256)`, custom errors, and bare
   **Aave/money-market numeric codes** (e.g. `50` → `BORROW_CAP_EXCEEDED`), mapped
   from our `Errors.sol`. Attribution uses the deepest failing `CALL` (delegatecalls
   run in the caller's context, so their from/to don't reflect msg.sender).
4. **Explain (code-grounded + on-chain, general)** — for the failing node, fetch
   the contract's **source**: verified source from Sonicscan (Etherscan v2,
   chainid 146, following proxy→implementation) if available, otherwise locate the
   exact `require`/`revert` throw-site in our local Sodax contracts by the revert
   string / error name. Feed that source + the decoded function, args, and reason
   to an LLM (any free OpenAI-compatible provider, or Claude) that has two
   **generic investigation tools** — `read_contract` (call any view function at
   the failing block) and `get_source` (fetch any contract's source). The model
   decides what state to read and whose code to inspect, then explains *what the
   error means, why it arose in this specific tx (grounded in values it actually
   read), and how to fix it*. Nothing is hardcoded per-error. Degrades gracefully
   (decoded reason + located source snippet) when no LLM is configured.

### Worked examples (real reverts)

- `0xf290…d5d5` → `SolverRouter.execute` (184 internal calls) →
  **BORROW_CAP_EXCEEDED — Borrow cap is exceeded (code 50)**, origin in the pool.
- `0x5f73…8efe` → `SolverRouter.executeC` → **Exceeds dollar limit**, attributed to
  **MarketMakingStrategy** ($10k limit, $8.6k used, $1.4k headroom) with fixes.

## Run

```bash
cd backend  && npm install && npm run dev   # engine + SSE API on :8787
cd frontend && npm install && npm run dev   # Vite + React UI on :5173
```

Open http://localhost:5173 and paste a tx hash.

### Environment

Put these in `backend/.env` (auto-loaded; gitignored) or the shell.

**LLM (pick one — the root-cause explainer is provider-agnostic, OpenAI-compatible):**

| Var | Purpose |
|---|---|
| `LLM_BASE_URL` + `LLM_MODEL` [+ `LLM_API_KEY`] | Any OpenAI-compatible endpoint. Free options: **Groq** (`https://api.groq.com/openai/v1`, `llama-3.3-70b-versatile`), **Gemini** (`https://generativelanguage.googleapis.com/v1beta/openai`, `gemini-2.0-flash`), **OpenRouter** free models. |
| _(local Ollama)_ | Auto-detected on `:11434` with **no config** — `ollama serve && ollama pull llama3.1`. |
| `ANTHROPIC_API_KEY` | Use Claude Opus 4.8 instead (optional). |

If none is set, the tool still decodes the tree, finds the reason, and shows the located source snippet — it just skips the written analysis.

**Other:**

| Var | Purpose |
|---|---|
| `SONICSCAN_API_KEY` | Etherscan v2 key (works for Sonic, chainid 146) — pulls **verified** source for external contracts and follows proxy→implementation. Without it, falls back to the local Sodax repo. |
| `SONIC_RPC_URL` | Override the Sonic RPC (default `https://rpc.soniclabs.com`). |
| `FORGE_OUT_DIR` | foundry `out/` for ABIs (default `…/sodax-contracts/evm/out`). |
| `LOCAL_CONTRACTS_DIR` | Sodax `.sol` sources for the local revert-site search (default `…/sodax-contracts/evm/contracts`). |

CLI: `cd backend && npm run analyze 0x<txhash> [chainId] [--all]`
(`--all` shows every STATICCALL; default hides view-call noise off the failing path).

## Extending

- **Explanation quality is code-driven, not rule-driven** — it improves automatically
  as more contracts are verified on Sonicscan or present in `LOCAL_CONTRACTS_DIR`.
  No per-error rules to maintain.
- **Aave/money-market numeric codes:** `engine/decode/aaveErrors.json` is generated
  from the money-market `Errors.sol`; regenerate it if those codes change.
- **Labeled contracts:** `engine/registry/contracts.ts`.
- **New chains:** `engine/rpc.ts` (needs an RPC that serves `debug_traceTransaction`).

### Ideas / next

- Value-flow ("what moved") summary per node.
- Collapse/expand-all and search in the tree UI.
- Cache verified source / explanations across runs.
