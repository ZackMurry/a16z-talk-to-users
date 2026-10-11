# Bring Your Own Agent to Sheets (Chrome extension)

Implements `PRD.pdf` as an MV3 Chrome extension with two parts:

1. **BYOA Sheets (WebMCP tools):** the open Google Sheet is exposed to any browser agent as WebMCP tools (`document.modelContext.registerTool`). It covers sheet understanding, deterministic arithmetic, approval-gated edits, audit/revert and a context-sync handshake. Proposed edits appear **on the sheet itself** as a preview (ghost cells plus an Accept / Revise / Reject card). Nothing is written until the user clicks Accept.
2. **Agent side panel:** a minimal, generic chat agent (Claude via the Anthropic SDK). It discovers whatever WebMCP tools the active tab exposes and calls them like any other WebMCP client would. It has nothing sheet-specific, and it happens to use the BYOA Sheets tools on Sheets pages.

No Google APIs or OAuth. The extension operates the Sheets page the way a user would (in the spirit of Docs Hotkey):

| Need | How (see `extension/src/driver.js`) |
|---|---|
| Select ranges | Name Box (`#t-name-box`) + Enter |
| Read values, formulas, formats | Synthetic `copy` event → Sheets' clipboard: `text/plain` + its compact-table JSON (raw values, R1C1 formulas, number formats, styles) |
| Write values / formulas | Synthetic `paste` of typed text |
| Number formats, bold/italic, fill | Toolbar buttons / palette |
| Charts | Insert chart → set data range, type, title in the chart editor → drag to the anchor cell |
| Tabs | Add Sheet button, rename, context-menu delete |
| Revert | Full clipboard payload of each touched range snapshotted before writing; pasted back verbatim |
| Edit permission | Editing toolbar present or not (view-only detection) |

## Layout

```
extension/
  manifest.json          MV3; pinned ID pkdmhhbbnnpfjhficmplghheabhhcjnh (key from keys/)
  src/webmcp.js          MAIN world: registers the 14 tools on document.modelContext
  src/bridge.js          isolated world: page ⇄ service worker relay
  src/driver.js          isolated world: page driver (all sheet I/O)
  src/preview.js         isolated world: on-sheet preview (ghost cells + Accept/Reject card)
  src/background.js      tool handlers, plans, approvals, stale checks, audit, sync
  src/ops.js             allowlisted ops: validate → preview → execute → verify → revert
  src/analysis.js        header/type detection, metrics, forecasts, preview evaluator
  src/tools.js           tool schemas/descriptions (single source of truth)
  panel/agent.js         side-panel chat agent (bundled with the SDK into agent.bundle.js)
  panel/console.*        older detailed console (changes, context, sync, history); not linked from the panel
demo/company-goals.md    sample context document for the Context tab
scripts/                 dev harness (launch Chrome, play the agent, e2e)
tests/unit.test.mjs      unit tests for the deterministic core
```

## Run it

Requirements: Chrome 146+ with WebMCP. Either enable `chrome://flags/#enable-webmcp-testing`, or use the bundled Chrome for Testing.

```sh
npm install
npm run build                  # bundles panel/agent.js + @anthropic-ai/sdk → panel/agent.bundle.js
npx @puppeteer/browsers install chrome@canary --path ./.chrome   # once
npm run chrome -- "https://docs.google.com/spreadsheets/d/<id>/edit"   # flag + extension preloaded
```

To install manually instead, load `extension/` unpacked at `chrome://extensions`. Open a sheet, then click the toolbar icon to open the side panel. On an empty sheet, **Agent → Load demo FP&A data…** proposes the demo dataset, which you approve in Review.

Agent: any WebMCP client, e.g. the Model Context Tool Inspector extension (with Gemini) or Gemini in Chrome. Agents should start with `get_workspace_info`.

## Tools

`get_workspace_info`, `describe_sheet`, `read_range`, `compute_metrics`, `forecast`, `run_scenario`, `list_context_documents`, `read_context_document`, `propose_changes`, `get_plan_status`, `post_insights`, `get_approved_summary`, `confirm_summary_saved`, `get_history`.

The only tool that can lead to sheet writes is `propose_changes`. It creates a plan that the user approves operation-by-operation in the panel. Allowed operations are `set_values`, `write_formula`, `format_range`, `append_forecast_rows`, `add_chart` and `add_sheet`. Network formula functions are blocked, and overwrites need an explicit flag.

## Tests

```sh
npm test                       # unit tests (deterministic core)
node scripts/e2e.mjs [--keep]  # full PRD journey against the open sheet (needs demo data in tab 1)
node scripts/agent.mjs <tool> '<json>'    # call a tool as the agent
node scripts/panel.mjs <action> '<json>'  # perform a panel action as the user
node scripts/reload.mjs        # reload extension + sheet tabs after code changes
node scripts/mock-anthropic.mjs  # local stand-in for the Messages API (Settings → Advanced → base URL http://127.0.0.1:8787, key test-key)
```

## Known limitations

- Page interaction depends on Sheets' DOM and clipboard formats, so a Sheets UI change can break the driver. Every write is re-read and verified, and mismatches are reported, never hidden.
- Chart titles require opening the chart editor. Deleting charts during revert is not yet reliable; when it fails, revert restores all cells and tells the user to delete the chart manually.
- Protected ranges aren't visible in advance. If Sheets blocks an edit, the operation is reported as failed.
- Operations need the sheet tab to be visible. Hidden tabs have their timers throttled and run about 10× slower.
- The extension can't verify the agent's memory, so context sync is shown as "agent-reported".
