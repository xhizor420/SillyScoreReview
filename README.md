# SillyScoreReview

Scores your SillyTavern character cards against a quality rubric using an LLM, caches
the results, and gives you a local web dashboard to browse them by score, read the
full critique, and move the bad ones to a trash folder — so you can actually work
through a few thousand cards instead of guessing from token count.

It does **not** score cards by length. A tight 700-token card and a bloated 4k-token
card are judged the same way: does the writing actually work, is it specific, does it
give the model something to play. The prompt explicitly tells the model to call out
padding and redundancy as weaknesses.

## Scores showing in a tab but missing from the data file?

**Do not close or reload that tab.** The scores are still in its memory and can be
recovered without re-scoring anything:

1. In that tab press **F12** → **Console**.
2. Open `recover-scores-snippet.js` from this folder, copy all of it, paste into the
   console, press Enter. A `recovered-scores.json` downloads.
3. Run this from the SillyScoreReview folder (the one containing `src` and
   `config.json`):

```
node src/cli.js import-scores recovered-scores.json
```

You do **not** need to move the file. It is looked for in the project folder, the
`data` folder, next to your score file, and in Downloads/Desktop. To be explicit, pass
the full path instead:

```
node src/cli.js import-scores "C:\Users\YourName\Downloads\recovered-scores.json"
```

**Close the dashboard server first** (the console window running it). It keeps the score
file in memory and rewrites the whole thing on its next save, which would silently undo
the import. `import-scores` refuses to run while it detects the server on the configured
port.

Imported cards count as fully scored and **will not be re-scanned** — the content hash is
recomputed from the card file, so `scan` treats them like any other scored card. Only the
score number survives; the written critique was never in the page, so those cards show
their score with a note and can be rescored individually if you want the detail back.

To avoid needing this again, the dashboard now has an **Export scores** button that saves
the same JSON on demand — worth doing after a long run. `import-scores` restores it.

## Selecting a lot of cards quickly

- **Shift-click** a checkbox to select everything between it and the last one you
  clicked. Ticking a few hundred boxes one at a time is not a workflow.
- **Select all shown** takes whatever the current filter/search is displaying.

## Finding and culling the same character

If you have five Ravens and six Cream Hearts, any card that shares a name with others
shows a clickable **"5 SAME NAME"** chip. Click it and the grid narrows to just that
group, best score first, with a bar reading *"Showing 5 cards named like Raven — best is
Raven v2 at 8/10"*. **Select all but the best** then selects the rest so you can delete
them and keep the one worth improving. **Show all cards** returns to the full grid.

To sweep every group at once instead, filter to **Possible duplicates**: all grouped
cards appear together, each tagged **BEST** or **DUPLICATE**, and **Select all but the
best of each** handles the whole collection in one click.

Name matching is purely textual — no AI, no image comparison — and covers the three ways
collections actually drift apart:

| | |
|---|---|
| formatting | `Cream Heart` = `CreamHeart` = `cream heart (1)` = `Cream Heart v2` |
| a source tag glued on | `Malo` = `SCPMalo` = `SCP Malo v2` |
| one name inside a longer one | `Mira` = `Mira Solace` |
| small spelling drift | `Kaelen` = `Kaelan` |

Short names are held to stricter rules so genuinely different characters don't merge —
`Nyx` and `Onyx` stay separate. Cards with a unique name are never grouped or selected,
and deletion still goes to `data/trash/` and is reversible.

## Copying keepers into another folder

Selection isn't only for deleting. With cards selected, **Copy selected to…** opens the
folder browser in copy mode: pick (or type) a destination and hit **Copy here**. The
files are *copied* — the originals and their scores stay exactly where they are, and the
folder you're reviewing does not change.

A path that doesn't exist yet is created, so you can type
`C:\Users\you\Desktop\Keepers` and have the folder made on the spot. Typical uses:

- filter to **Score below 4**, **Select all shown**, and copy them somewhere as a staging
  area before you decide to delete them;
- sort **Score: high → low**, select the top of the list, and copy your best cards
  straight into SillyTavern's own `characters` folder;
- pull a group of same-name duplicates aside to compare before merging them by hand.

Nothing is ever overwritten. A card already in the destination (byte-identical) is
skipped and reported as *already there*; a **different** card that happens to share a
filename is copied as `Name (2).png` so both survive.

Scores travel with the copies. The destination folder gets its own score cache entries
for the cards you copied, so pointing the dashboard at that folder later shows the same
scores instead of demanding a rescan.

## Using it from your phone

The dashboard works from a phone over Tailscale — browse, score, compare and delete, all
of it. Run the server on the PC holding your cards, then open
`http://<that machine's tailscale name>:4180` on your phone. See the Tailscale section
below for setup, and **set an `authToken`** before doing this so only you can reach it.

On a phone the layout switches to a denser grid with thumb-sized controls, and side
panels become full-screen sheets. Shift-click has no touch equivalent, so tap
**Select mode** — while it's on, tapping a card selects it instead of opening it, which
is how you pick a lot of cards to delete or copy. Tap it again to go back to
tap-to-open.

To re-score cards that have no score or that failed, filter to **Unscored / errored
only** — then either **Scan unscored** (does the whole set) or select individual cards
and use **Score selected**.

## Deleting cards does NOT re-score anything

Culling garbage cards mid-run is a supported workflow, including while a scan is
running. Deleting a card removes only that card's entry; every other card keeps its
score, and the next scan reports `0 need scoring` for them. A card deleted while a
worker was mid-request is simply dropped, not recorded as a failure.

If deleting *appeared* to wipe your progress, you most likely hit the split-cache bug
(fixed): switching folders in the dashboard wrote scores to a second file while the app
later read the first one, so previously-scored cards looked unscored. Check and fix with:

```
node src/cli.js caches         # lists every score file and which folder it belongs to
node src/cli.js merge-caches   # combines them into one, keeping the best entry per card
```

`merge-caches` never loses data: a real score always beats a stale error for the same
card, newer beats older, the existing file is backed up first, and entries for cards no
longer in the folder are pruned. Add `--dry-run` to preview, `--no-prune` to keep
entries for deleted cards.

## Scan crawling? Run `doctor` first

If a scan is going slowly, don't wait it out — run:

```
node src/cli.js doctor
```

It scores three real cards from your folder (smallest / median / largest) with full
instrumentation and tells you in about a minute what's wrong: whether requests are
timing out, whether the model's replies are being cut off mid-JSON, how long each
request actually takes, and roughly how long your whole folder would take at that
speed. **Model choice is by far the biggest speed lever — much more than concurrency.**
A fast model answers in 2-10s; a large "reasoning"/"thinking" model can take minutes per
card and spend its whole output budget thinking instead of producing the JSON, which
fails the card *and* costs a retry.

Also worth knowing: `stats` shows how many cards actually **scored** versus **errored**.
A progress bar that's climbing isn't proof things are working — failures count as
processed too.

## Windows quick start

1. Install [Node.js](https://nodejs.org/) (the LTS installer — next, next, finish).
2. Download/copy this project folder onto your PC.
3. Double-click **`Start SillyScoreReview.bat`** in the folder. First run installs
   dependencies and creates `config.json` automatically; it then opens a console window
   (the server — leave it running) and your browser to `http://localhost:4180`.
4. In the browser: click **Settings**, pick **NanoGPT** as the provider, paste your API
   key from [nano-gpt.com](https://nano-gpt.com), click **Save settings**, then **Refresh
   list** and pick a model from the dropdown, then **Save settings** again.
5. Click **Change folder** and browse to wherever you put your card PNGs (e.g. your
   SillyTavern `data/default-user/characters` folder). Click **Use this folder**.
6. Click **Scan unscored**. Sort by **Score: low → high** once it's done to find your
   worst cards first.

Everything else below applies the same way on Windows, macOS, or Linux — the batch file
is just a shortcut around the same `npm install` / `npm run serve` commands, and the
Settings/folder pickers mean you never actually need to hand-edit `config.json`.

## How it works

1. `scan` reads every `.png`/`.json` character card in a folder, extracts the embedded
   card data (SillyTavern V1/V2/V3 spec), sends each non-empty field to the LLM with
   the rubric below, and caches the structured result to disk (`data/cache-*.json`)
   **immediately after each card**, not just at the end — so if you stop it partway
   through, everything scored so far is already saved. Successfully-scored cards are
   skipped on the next run unless the card file changed (content hash) or you pass
   `--rescore`; a card that **failed** (network error, bad response, rate limit
   exhausted) is *not* skipped — it's automatically retried the next time you run `scan`
   or click "Scan unscored," no flag needed.
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

Requires Node.js 18+. On Windows, use `Start SillyScoreReview.bat` (see above) and skip
straight to Usage — it handles all of this for you.

```bash
npm install
cp config.example.json config.json
node src/cli.js serve
```

Then open `http://localhost:4180` and use the **Settings** panel (provider, API key,
model) and **Change folder** button (your characters folder) instead of hand-editing
`config.json` — both save back to the file automatically. Settings panel fields:

- **Provider** — NanoGPT (default), Anthropic, OpenAI, or Local/other OpenAI-compatible
  (Ollama, LM Studio, …), plus a Mock option that does no real analysis, for testing the
  pipeline without spending anything.
- **API key** — paste it in and Save; NanoGPT keys come from
  [nano-gpt.com](https://nano-gpt.com). Not needed for most local servers.
- **Base URL** — auto-filled per provider, editable if you're pointing at a non-default
  endpoint (e.g. `http://localhost:11434/v1` for Ollama).
- **Model** — after saving, click **Refresh list** to pull the live list of models your
  key/provider actually has access to, or type a model name manually.
- **Parallel requests** — how many requests may be open at once (default 8).
- **Requests per minute** — how fast requests are actually issued (default: the
  provider's documented limit; 60 for NanoGPT). Set 0 to disable pacing entirely — only
  sensible for a local model on your own hardware.

### Staying inside NanoGPT's limits

NanoGPT documents two separate per-key limits: **10 concurrent requests** and **60
requests/minute** ([docs.nano-gpt.com](https://docs.nano-gpt.com/api-reference/miscellaneous/rate-limits)).
Both are respected by default, and they are genuinely different constraints —
concurrency alone does not keep you under a per-minute cap, because 8 requests in
flight against a 2-second model is ~240 requests/minute.

- Requests are **evenly paced** to the configured requests/minute rather than fired in
  bursts. Even pacing is used deliberately: a token bucket or sliding window can put a
  full burst at the end of one window and another at the start of the next, so a rolling
  measurement sees up to double the intended rate. Even spacing is bounded in *every*
  window.
- Concurrency is **clamped** to the provider's documented maximum, so a hand-edited
  config can't push past it.
- A `429` with a `Retry-After` header is honored exactly as instructed rather than
  guessed at with generic backoff.

**60/min is the ceiling, and it's fast**: 3,600 cards/hour, so a 3,765-card library is
about an hour — *if* the model answers quickly. The real rate is
`min(requests-per-minute, concurrency ÷ latency)`, so a model taking 30s per request
caps you at 10÷30s = 20/min no matter what pacing you set. That is why model choice
matters more than any of these numbers.

Running **at** the documented limit is fine — that's what the default does. Going *over*
it is what risks your key, which is why the clamp and pacing exist.

Hitting your own **credit/token quota** is a different thing entirely and is nothing to
worry about: the provider returns a 429 with a long `Retry-After` (i.e. "resets at
midnight"), those cards get marked failed, the run continues, and **Scan unscored**
picks them all up once your quota resets.

(If you'd rather configure by hand: same fields, in `config.json` — `charactersDir`,
`provider`, `model`, `apiKey`, `baseURL`, `concurrency`. You can also set
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` as environment variables instead of putting a key
in the file.)

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
- **Culling bad cards in bulk:** filter to e.g. *Score below 4*, click **Select all
  shown**, then **Delete selected**. The confirmation tells you how many cards, their
  score range, and a sample of names before anything moves — so a mis-set filter is
  obvious before it sweeps up good cards. You can still tick individual checkboxes
  (top-left of each tile) for one-off picks.
  Deleting moves the PNG/JSON files to `data/trash/`; it does not permanently delete
  them. Use the **Trash** panel to restore a card or permanently empty the trash.
- **Scan unscored** / **Rescore all** trigger a batch job in the background and open a
  live panel showing: how many cards **scored** vs **failed** (counted separately, so a
  failing run can't masquerade as a slow one), how many requests are **in flight** right
  now out of your concurrency limit, the current **rate/hour**, **median** request time,
  **ETA**, plus a list of which cards are being processed at this moment and a rolling
  feed of what just finished with their scores. Requests sitting over 30s are flagged —
  that's your cue that the model is too slow. You can keep browsing while it runs.

All commands accept `--config path/to/other-config.json` if you want multiple profiles
(e.g. different characters folders or providers).

### CLI reference

```
node src/cli.js scan   [--dir PATH] [--limit N] [--rescore] [--dry-run]
                        [--provider nanogpt|anthropic|openai|local|mock] [--model NAME]
                        [--api-key KEY] [--base-url URL] [--concurrency N]
node src/cli.js doctor          # diagnose why a scan is slow or failing
node src/cli.js stats
node src/cli.js serve  [--port 4180] [--host 0.0.0.0] [--auth-token TOKEN]
```

`timeoutMs` in `config.json` (default 120000) caps how long a single request may take.
A request that times out is retried only once, then the card is marked failed and picked
up by the next scan — so a slow model degrades throughput rather than silently stalling
for tens of minutes per card.

## Safety notes

- Deleting from the dashboard is a **move to `data/trash/`**, not a permanent delete —
  restore anything from the Trash panel if you change your mind. Emptying the trash is
  the only irreversible step, and it asks for confirmation.
- The scanner never modifies your card files, only reads them.
- Nothing here talks to SillyTavern's server or database — it only reads the same PNG
  files from disk that SillyTavern reads. Safe to run while SillyTavern is running.

## Picking the characters folder from the dashboard

You don't have to hand-edit `config.json` to point at your cards. In the dashboard,
click **Change folder** — it opens a server-side directory browser (click into
subfolders, or paste a full path and hit Go) so you can navigate to wherever your
`characters` folder actually lives and click **Use this folder**. This works even when
the browser and the files are on different machines (see the Tailscale section below),
since the browsing happens on the server, not in your browser.

Picking a folder this way is saved back to `config.json` automatically, so it's still
there next time you start `serve`. Each folder you've ever pointed at keeps its own score
cache (`data/cache-<hash>.json`), so switching between e.g. two SillyTavern profiles never
mixes up their scores, and switching back doesn't lose anything.

## Running it against a SillyTavern box over Tailscale

This section only applies if your cards live on a *different* machine than the one
you're using the dashboard from. If you're running SillyScoreReview on the same Windows
PC where you dropped your card files, skip this — just use the folder picker.

If SillyTavern (and your card files) live on a different machine than the one you're
sitting at — e.g. a Linux box on your Tailscale network — the simplest setup is to run
**SillyScoreReview directly on that Linux box**, since that's where the cards actually
are on disk. The app doesn't need to know anything about Tailscale at all: Tailscale just
gives that machine a private, encrypted, always-reachable address, and the app already
listens on all network interfaces by default (`host: "0.0.0.0"` in the config), so it's
automatically reachable at that address once it's running.

On the Linux box hosting SillyTavern:

```bash
git clone <this repo> SillyScoreReview   # or copy the folder over however you like
cd SillyScoreReview
npm install
cp config.example.json config.json
# edit config.json: charactersDir -> SillyTavern's actual characters folder on this box,
# e.g. /home/youruser/SillyTavern/data/default-user/characters
node src/cli.js serve
```

Then from your desktop/phone/laptop anywhere else on your tailnet, open:

```
http://<linux-box-tailscale-name-or-ip>:4180
```

Find that name/IP with `tailscale status` on the Linux box, or check it in the Tailscale
admin console. No port forwarding, no exposing anything to the public internet — only
devices on your tailnet can reach it.

A couple of things worth doing once you're serving beyond localhost:

- **Set an access token.** Add `"authToken": "some-long-random-string"` to `config.json`
  on the Linux box and restart `serve`. The dashboard will prompt for it once and remember
  it in your browser. Without this, anyone who can reach that address on your tailnet
  (any of your own devices, by default) can browse and delete your cards — fine if it's
  just you, worth locking down if others share the tailnet.
- **Keep it running after you disconnect.** `node src/cli.js serve` dies when your SSH
  session ends unless you run it under `tmux`/`screen`, `nohup … &`, or (better, for
  something long-lived) a `systemd` user service. A simple `pm2 start src/cli.js -- serve`
  works too if you already have `pm2` installed.
- **Firewall**, if the box runs one (e.g. `ufw`): allow the port only on the Tailscale
  interface rather than opening it broadly — `sudo ufw allow in on tailscale0 to any port 4180`.

You still run `scan` the same way on that box (or via the dashboard's "Scan unscored"),
it just now has direct, fast local disk access to the real characters folder instead of
going over the network for every card.

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
