# SillyScoreReview

Scores your SillyTavern character cards against a quality rubric using an LLM, caches
the results, and gives you a local web dashboard to browse them by score, read the
full critique, and move the bad ones to a trash folder — so you can actually work
through a few thousand cards instead of guessing from token count.

It does **not** score cards by length. A tight 700-token card and a bloated 4k-token
card are judged the same way: does the writing actually work, is it specific, does it
give the model something to play. The prompt explicitly tells the model to call out
padding and redundancy as weaknesses.

## How it works

1. `scan` reads every `.png`/`.json` character card in a folder, extracts the embedded
   card data (SillyTavern V1/V2/V3 spec), sends each non-empty field to the LLM with
   the rubric below, and caches the structured result in `data/cache.json`. Already-
   scored cards are skipped on the next run unless the card file changed (content hash)
   or you pass `--rescore`.
2. `serve` starts a local dashboard (`http://localhost:4180`) where you see every card's
   thumbnail and score at a glance, sort/filter by score or token count, open a card for
   the full breakdown, and delete (→ trash, reversible) or bulk-delete cards you decide
   to cut.

The rubric sent to the model, verbatim:

> Rate this character card on a scale of 1-10 for each field provided.
>
> For each field:
> 1. **Score** (1-10)
> 2. **Strengths** - What works well
> 3. **Weaknesses** - What needs improvement
> 4. **Suggestions** - Concrete changes
>
> Then provide:
> - **Overall Score** (weighted average)
> - **Top 3 Priority Improvements**
> - **Summary**
>
> Be critical but constructive. Specific, actionable feedback only.

(The model is asked to return this as JSON so it can be cached/rendered reliably; the
dashboard renders it back out in this exact structure.)

Fields scored: `description`, `personality`, `scenario`, `first_mes`, `mes_example`,
`system_prompt`, `post_history_instructions`, `alternate_greetings` — whichever of these
are actually non-empty on a given card. The overall score is a weighted average across
whichever fields are present (weights in `config.json`, defaults favor `description` and
`first_mes` since those matter most for how the character plays).

## Setup

Requires Node.js 18+.

```bash
npm install
cp config.example.json config.json
```

Edit `config.json`:

- `charactersDir` — your SillyTavern characters folder. Typically
  `SillyTavern/data/default-user/characters` (or `SillyTavern/data/<user>/characters` for
  a specific profile — check the folder for your card PNGs to confirm).
- `provider` — `anthropic`, `openai`, `local`, or `mock` (mock does no real analysis, it's
  for testing the pipeline without spending anything).
- `model` — e.g. `claude-sonnet-5` for Anthropic, `gpt-4o-mini` for OpenAI, or whatever
  model name your local server expects.
- `apiKey` — or leave blank and set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in your
  environment instead (preferred, keeps the key out of the repo).
- `baseURL` — only needed for `local`: point it at your OpenAI-compatible server, e.g.
  `http://localhost:11434/v1` for Ollama, or your LM Studio / text-generation-webui
  endpoint. No API key needed for most local servers.
- `concurrency` — how many cards to score in parallel. Keep this low (2-4) for hosted
  APIs to stay under rate limits; local models can usually go higher if your hardware
  can take it.

## Usage

**Cost/scope check before committing to all 3765 cards:**

```bash
node src/cli.js scan --dry-run
```

Prints how many cards need scoring and a rough total token estimate, no API calls made.
Then try a small batch for real before doing everything:

```bash
node src/cli.js scan --limit 20
node src/cli.js stats
```

`stats` shows the score distribution across everything cached so far. Once you're happy
with the output quality, either keep running `scan` in batches, or just open the
dashboard and use "Scan unscored" there — same underlying cache, so nothing gets
double-scored.

```bash
node src/cli.js serve
```

Open `http://localhost:4180`. From there:

- Sort by **Score: low → high** to find your worst cards first.
- Filter to **Score below 4** to find likely-delete candidates immediately.
- Click a card to read the full per-field breakdown (strengths/weaknesses/suggestions),
  the top 3 priority improvements, and the summary.
- Select multiple cards (checkbox, top-left of each tile) and use **Delete selected** —
  this moves the PNG/JSON files to `data/trash/`, it does not permanently delete them.
  Use the **Trash** panel to restore a card or permanently empty the trash.
- **Scan unscored** / **Rescore all** trigger a batch job in the background with a
  progress bar; you can keep browsing while it runs.

All commands accept `--config path/to/other-config.json` if you want multiple profiles
(e.g. different characters folders or providers).

### CLI reference

```
node src/cli.js scan   [--dir PATH] [--limit N] [--rescore] [--dry-run]
                        [--provider anthropic|openai|local|mock] [--model NAME]
                        [--api-key KEY] [--base-url URL] [--concurrency N]
node src/cli.js stats
node src/cli.js serve  [--port 4180]
```

## Safety notes

- Deleting from the dashboard is a **move to `data/trash/`**, not a permanent delete —
  restore anything from the Trash panel if you change your mind. Emptying the trash is
  the only irreversible step, and it asks for confirmation.
- The scanner never modifies your card files, only reads them.
- Nothing here talks to SillyTavern's server or database — it only reads the same PNG
  files from disk that SillyTavern reads. Safe to run while SillyTavern is running.

## Using this alongside SillyTavern

This runs as a separate local tool rather than an in-app SillyTavern extension, on
purpose: browser-side ST extensions can't read/write your character folder or call an
LLM with your own API key without a server component, so a small standalone dashboard
is the simplest thing that actually works and stays easy to audit. You can still keep
it one click away — e.g. bookmark `http://localhost:4180` next to your ST tab, or add a
Quick Reply/menu link to it if you use one of ST's launcher extensions. If you'd
specifically like a real in-panel ST extension (iframing this dashboard inside ST's UI
via a server plugin), that's a reasonable follow-up — just ask.

## Cost estimate

Rough sizing for 3765 cards at your reported mix (some ~700 tokens, some ~4k, call it
~1800 average input tokens/card including the rubric instructions): roughly 6.8M input
tokens total, plus a small output per card (a few hundred tokens for the structured
critique). Run `scan --dry-run` for the real number against your actual folder, and
check current pricing for whichever model you pick — cost varies a lot by provider/model,
and a local model (Ollama etc.) is effectively free but slower and typically lower
critique quality than a frontier hosted model.
