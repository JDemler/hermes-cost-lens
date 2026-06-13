# Hermes Cost Lens

A zero-build Hermes dashboard plugin and standalone single-page web tool for analyzing and
optimizing the cost of Hermes Agent workflow sessions. Load one or more session JSON exports,
and it prices the session with live model pricing from the
[OpenRouter models API](https://openrouter.ai/api/v1/models) and visualizes exactly where the
money goes.

## Hermes plugin

This repository is packaged as a dashboard-only Hermes plugin named `hermes-cost-lens`:

```text
dashboard/
├── manifest.json       # Hermes dashboard plugin manifest
├── dist/
│   ├── index.js        # tab registration bundle
│   └── style.css       # iframe wrapper styles
└── app/
    ├── index.html      # analyzer UI
    ├── app.js
    ├── styles.css
    └── d3.v7.min.js    # vendored D3 runtime
```

Install from a released Git repository:

```bash
hermes plugins install <owner>/<repo>
```

Or install manually from a local checkout:

```bash
mkdir -p ~/.hermes/plugins/hermes-cost-lens
cp -R dashboard ~/.hermes/plugins/hermes-cost-lens/
```

Then open `hermes dashboard`. The plugin appears as the **Cost Lens** tab. Dashboard-only
plugins are discovered from `dashboard/manifest.json`; they do not need `hermes plugins enable`
because they do not load model-visible tools, hooks, or Python code.

## Run it

The standalone page is still useful for local development:

```bash
python3 -m http.server 8742
# open http://localhost:8742
```

Any static file server works. There is no build step. The standalone root page uses D3 from a
CDN; the Hermes plugin copy vendors D3 under `dashboard/app/` so the plugin bundle does not depend
on jsDelivr at runtime. OpenRouter pricing is fetched live from its public API.

## What you get

- **Summary cards** — total cost, API calls, and tokens split into **fresh input / cached input / output**,
  each with their dollar share.
- **Pricing panel** — input / output / cache-read / cache-write rates fetched live from OpenRouter,
  matched on the session's `model` id. All fields are editable for what-if scenarios
  (e.g. "what would this session cost on a different model?").
- **Cost flamegraph** — one column per API call, width proportional to cost.
  - Row 1: the API call
  - Row 2: cached input vs fresh input vs output cost within that call
  - Row 3: the individual messages making up each pool
- **Cumulative cost attribution treemap** — every message's *total* cost over the whole session
  (its tokens × every call it was re-sent in, at the applicable cached/fresh rate, plus its
  generation cost), grouped by System prompt / User / Tool / Assistant. Big tiles = optimization targets.
- **Message breakdown table** — sortable, with context cost vs output cost per message.
- **Optimization hints** — biggest cost driver, most expensive tool, system-prompt overhead,
  cache savings, and context-growth warnings.

Click any block, tile, or table row to open a detail drawer with the message content, reasoning,
tool calls, and its full cost accounting.

## How costs are computed

Session JSONs report exact session-level totals (`input_tokens`, `output_tokens`,
`cache_read_tokens`, `cache_write_tokens`) but no per-message usage. The tool therefore:

1. **Estimates per-message tokens** from character counts (~4 chars/token), including tool-call
   names/arguments; assistant output additionally includes reasoning text.
2. **Models the call structure**: each assistant message is one API call that re-sends the system
   prompt plus the entire prior conversation. Anything sent in a previous call is treated as a
   cache hit; messages added since the last call are fresh input. If the session reports zero
   cache reads, all context is treated as fresh.
3. **Scales each pool** (cached / fresh / output) so estimates sum exactly to the session's
   reported totals — so the session total cost is exact, and the per-message split is a
   well-calibrated estimate. Cache writes are folded into the fresh pool at a blended rate.

For known-good Hermes session exports, the computed total should match the session's own
`estimated_cost_usd` to the cent.

## Reading the results

- A large **tool result** tile means that output is re-sent on every subsequent call — truncate or
  summarize it before it enters context.
- A large **system prompt** tile means every token you cut from it saves N× its price (N = number
  of API calls).
- Strongly growing per-call context cost suggests compacting history or splitting work into
  sub-sessions.
- Compare the **cached** vs **fresh** rates to see what prompt caching is saving you.
