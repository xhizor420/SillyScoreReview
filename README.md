# SillyScoreReview

Scores your SillyTavern character cards against a quality rubric using an LLM, caches
the results, and gives you a local web dashboard to browse them by score, read the
full critique, and move the bad ones to a trash folder — so you can actually work
through a few thousand cards instead of guessing from token count.

It does **not** score cards by length. A tight 700-token card and a bloated 4k-token
card are judged the same way: does the writing actually work, is it specific, does it
give the model something to play. The prompt explicitly tells the model to call out
padding and redundancy as weaknesses.

It also **fixes** cards, not just grades them: the model rewrites the weak fields using
its own critique, you review the result side by side and edit it yourself, and only then
does anything get written — as a new card by default. See *Improving a card*, below.

The full loop it's built for: score everything → cull what's bad → group the duplicate
Ravens and keep the highest scorer → improve that one → see the new score next to the old
one.

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

To avoid needing this again, the dashboard has an **Export scores** option (under **More**) that saves
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

## The dashboard at a glance

- **Top bar** — the one thing you do most, **Scan unscored**, is the highlighted button.
  **Prompts** and **Settings** sit next to it; everything occasional (Rescore all, Export
  scores, Change folder, Trash) is under **More**.
- **Stat tiles** — cards, scored, average, not scored yet, failed, and *older prompt*
  (see below). Click any tile that names a set of cards to show just those.
- **Score distribution** — one bar per score (1.0–1.9, 2.0–2.9, … 10). It answers "how many
  would I lose if I cut everything below 4?" at a glance. **Click a bar to show only those
  cards**, click it again to show everything. Hover (or tab to it) for the exact count.
- **Large / Compact** — compact shows about twice as many cards at once (measured: 22 vs 8
  fully on screen at 1400×900, 45 vs 22 at 1920×1080), for working through a big library.
  Remembered between visits.
- On a phone the controls collapse to a few short rows, so the cards start well up the
  screen instead of below six stacked buttons.

## Changing the prompts

**Prompts** shows what the model is told, as three tabs:

| | used for |
|---|---|
| **Full critique** | scoring with written feedback — your original rubric |
| **Fast scoring** | scoring when *Scoring detail* is set to Fast |
| **Improvement ideas** | step 2 of *Improve with AI* — the keep list and the menu of changes |
| **Improve card** | step 3 of *Improve with AI* — the rewrite of the changes you chose |

Each prompt has two parts. **Your instructions** are fully editable — a different
rubric, stricter or kinder grading, a genre focus ("judge these as horror cards"),
feedback in another language. The **response format** — the exact shape the code reads
back — is shown underneath but locked, and always added after your instructions. That
lock is deliberate: if a single edit could change the format, one stray word would make
every card in a 3,000-card scan fail to parse.

Before saving, try an edit on one card:

- **Show exactly what's sent** — the full system and user message for that card, with
  your unsaved edit. Sends nothing.
- **Test on this card** — sends one real request with your unsaved edit and shows the
  result next to the card's current score ("Currently 7/10 — this version scores it
  −5"). Nothing is saved to the card.

The editor also warns you about edits that are allowed but probably not meant: writing
your own JSON format (it would conflict with the locked one), asking fast mode for written
feedback (it never returns any), lenient grading (it bunches scores up, which makes
culling harder), or instructions long enough to noticeably slow down a big scan.

**Changing a prompt never rescores anything by itself.** Every score remembers which
prompt produced it, so after you save, an **older prompt** tile appears with a count, and
the filter **Scored with an older prompt** shows just those cards — rescore them with
**Select all shown → Score selected**, or leave them. **Reset to default** puts the
built-in prompt back. Edits are saved to `config.json` under `prompts`.

## Improving a card

Scoring tells you a card is a 4/10. **Improve with AI**, on the card itself, does
something about it — in two steps, so you decide what changes and the card keeps its
feel.

**1 · Rating.** Score the card first (a full critique gives the next step the most to
work with; a card scored in fast mode or not at all still works, from its text alone).

**2 · Choose ideas.** The model reads the card and its rating and comes back with:

- **What makes this card itself** — its voice, quirks, formatting, signature lines, canon
  facts. This list is editable: add anything you want protected, remove anything you're
  happy to change. It is sent with the rewrite as a set of hard rules.
- **Exact lines that must survive word for word** — a few of the card's own phrases.
  After the rewrite, the dashboard checks they're all still there (and warns you, live,
  if one goes missing). A "quote" the model got wrong is dropped, since a line that isn't
  really in the card can't be protected.
- **A menu of specific changes**, each with the field it touches, what it fixes, how much
  it matters, and — plainly — how it could change the card's feel. High- and
  medium-impact ideas with no such risk come pre-ticked; anything risky or minor is yours
  to opt into.

The ideas also check the card against the
[Character Card V2 spec](https://github.com/malfoyslastname/character-card-spec-v2):

| | |
|---|---|
| `system_prompt` / `post_history_instructions` | These **replace** your own system prompt and jailbreak unless they contain `{{original}}`. A card that sets one without it is flagged. |
| **Reader notes in the card** | Credits, links, update notes or usage instructions placed in the description or another prompt field aren't part of the character — they waste tokens and confuse the model. |
| `alternate_greetings` | Swipes for the first message — each should be a distinct, complete opening, not a near-copy. |
| `{{char}}` / `{{user}}` | Hard-coded names where the card means the character or the user. |
| **Lorebook moves** | Background that only matters in some scenes can move out of an always-sent field into **lorebook entries**, which SillyTavern only sends when a keyword comes up. Nothing is deleted, and every turn costs fewer tokens. |

**3 · Review the rewrite.** Only the fields your ticked ideas touch are sent to the model
at all — and if it rewrites anything else anyway, that is thrown away. What comes back is
a **draft, not a file**:

- the original and the rewrite side by side, each editable, with a live token count
  (`180 → 140 tok (-40)`) and the reason for each change;
- **Revert this field** to throw away any rewrite you don't like;
- any **new lorebook entries**, with editable keywords and text (or remove one to leave
  that text out). Moved text keeps the card's own wording; existing entries are untouched.

Save it as a **new card** (the default — the original is untouched and keeps its score)
or **replace the original** (a copy of the pre-edit file goes to Trash). Leave *Score it
after saving* ticked to see the before/after straight away: **5.1 → 8.2 (+3.1)**.

Because the improved card keeps the character's name, it lands in the same duplicate
group as its parent — so after it scores higher, **Select all but the best of each**
picks the old one for deletion.

Checked in code, not just asked for in the prompt:

| | |
|---|---|
| **No padding** | A rewritten field that grew is flagged. A longer card is a worse card. |
| **Keep the macros** | If the original used `{{user}}` or `{{char}}` and the rewrite has none left, you're warned. Dropping a *repeated* macro is fine editing. |
| **Protected lines** | Any exact line from the keep list that disappears is flagged, live. |
| **Only what you chose** | Unchosen fields are never sent, and rewrites of them are discarded. |

**Creator notes are never judged.** They're the creator's profile blurb, credits and
links — not the character, and never part of a chat. They aren't sent for scoring (full
or fast) or for either improve step, so they can't raise or lower a score or shape a
suggestion.

Everything else in the card — lorebook, creator notes, tags, `extensions`, the artwork —
is copied through byte-for-byte. Both steps' prompts are editable in **Prompts**
(*Improvement ideas* and *Improve card*).

## Editing a card by hand

**Edit text** on any card opens the same editor with the card's own text, unchanged, in
editable boxes — no model involved. Fix a typo, delete a line, rewrite a greeting, save.
This works from a phone too, which is the easiest way to clean up cards without going
near the machine the files live on.

## Stopping a scan

A scan of a few thousand cards runs for hours. **Stop scan** in the progress panel ends
it without killing the server: cards already in flight finish and are saved, cards that
hadn't started are left alone, and **Scan unscored** afterwards picks up exactly where it
left off. Nothing is lost and nothing is scored twice.

## Thinking models (GLM and others)

Models that reason before answering are fully supported:

- **No response-length limit by default.** A thinking model's reasoning counts against
  any limit, so a cap sized for the answer can cut the answer off after the model spent
  the budget thinking. Nothing is capped unless you set **Settings → Response length
  limit** (0 = no limit). If a provider does cut an answer off, it's reported as exactly
  that, with the fix — not as "unusable JSON".
- **Reasoning is never mistaken for the answer.** Whether it arrives as `<think>…</think>`
  before the answer, with the opening tag already stripped, or in a separate field, the
  answer is found after it. This matters more than it sounds: reasoning quotes the card,
  and card text is full of braces (`{{user}}`, `{{char}}`). The previous reader started
  inside the reasoning and failed — it could not read *any* answer that had reasoning in
  front of it.
- Thinking takes longer. If cards time out, raise **Timeout per request** in Settings
  (a timed-out request is already retried once at double the time).

## When things go wrong mid-scan

A long scan will hit problems — a slow answer, a dropped connection, an expired key.
There are two layers handling them.

**Each request** retries on its own:

| what happened | what it does |
|---|---|
| no answer within the timeout | retries once with **double** the deadline, so a merely-slow model still gets through |
| "too many requests" (429) or a provider error (5xx) | waits and retries up to 4 times, using the provider's own `Retry-After` when it sends one |
| a reply cut off mid-JSON | asks again with more room to finish |
| key rejected, out of credits | **not** retried — it would only be rejected again |

**The scan as a whole** watches for problems no single retry can fix:

| what happened | what the scan does |
|---|---|
| **API key rejected / out of credits / unknown model** | **Pauses** after the first rejection and says which it is. Nothing is marked failed. Fix it in Settings (or top up), press **Resume**, and it carries on from where it stopped. |
| **Connection lost** (Wi-Fi, Tailscale reconnecting, the PC waking up, the provider down) | **Waits** instead of failing cards, checks for the connection every few seconds with a free request, and carries on **by itself** when it's back. |
| **The provider keeps saying "too many requests"** | **Slows down** — halves its pace for every request in the app, then creeps back up to your normal rate once things are quiet. Never goes above the limit you set. |
| **Some cards failed for temporary reasons** | Gets **one automatic retry pass** at the end of the run, so you don't have to press *Scan unscored* again. |
| **A rescore fails** | **Keeps the score the card already had.** (It used to overwrite it — a "Rescore all" with an expired key wiped every score. Fixed.) |
| **You press Scan on your phone while one runs on the PC** | Shows the scan that's already running instead of starting a second one, which would double your request rate past NanoGPT's limit. |
| **You reload the page, or open the dashboard on another device** | Finds the running scan and shows it, paused/waiting state included. |

Measured against a test API that misbehaves on cue:

| | before | now |
|---|---|---|
| key revoked partway through 200 cards | 182 more requests sent, **182 cards failed** | 1 request, **0 failed**, paused → Resume → 200/200 |
| out of credits partway through | same — 182 failed | 1 request, 0 failed, paused → Resume → 200/200 |
| network down for 25s | 4 cards wrongly marked failed | **0 failed**, waited and resumed by itself |
| provider rejecting 60% of requests with 429 | kept sending 2.7/s, 5 failed | slowed itself to 0.7/s, **0 failed**, 2 recovered on the retry pass |
| scan started from two devices at once | **240/min against a 120/min limit** | one scan, 120/min |
| "Rescore all" with an expired key | **30 of 30 scores destroyed** | 30 of 30 kept |

## Your scores are backed up automatically

The score file is snapshotted into `data/backups/` when the dashboard opens a folder,
before a **Rescore all**, before an import or a cache merge, and every 250 cards during a
long scan. The last 12 snapshots per folder are kept.

```
node src/cli.js backups                     # list them, newest first
node src/cli.js restore-backup <name>       # put one back (close the dashboard first)
```

Restoring saves the current file as a snapshot too, so a restore is itself undoable. The
Settings panel lists the snapshots it has for the folder you're looking at.

## A dashboard that stays quick at 3,765 cards

The grid only builds the tiles you can actually see and extends as you scroll, so the
page doesn't pay for thousands of cards it isn't showing. Measured on a 3,765-card
collection:

| | before | now |
|---|---|---|
| first cards on screen | 1,613ms | 323ms |
| re-render (every keystroke, filter, selection) | 471ms | 18ms |
| typing "Raven" in the search box | ~1,140ms | ~60ms |
| DOM nodes held | 34,021 | 2,297 |

Filtering, searching, duplicate grouping and **Select all shown** still work across the
whole collection — only the drawing is windowed, so "Select all shown" on 3,765 cards
selects 3,765 cards, not the 240 on screen.

Score writes are batched too. Saving after every single card meant rewriting the whole
9MB score file each time — about 2.5 minutes of blocked work across a full run, which
also made the dashboard stutter while scanning. Results now coalesce into one write per
second or so, and every path that ends a run (finishing, stopping, scoring one card from
the modal) flushes to disk first — as does pressing Ctrl+C or closing the dashboard's
window mid-scan.

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

## Scanning thousands of cards fast

Scan time is almost entirely the model writing its answer — the pipeline around it
costs about **6ms per card**, so nothing local is worth optimising. The levers that
matter are how much the model has to write, and how many cards are in flight.

**Scoring detail** (Settings, or `--fast` on the CLI):

| | |
|---|---|
| **Full critique** | The complete rubric: a score plus strengths, weaknesses and suggestions for every field, three priority improvements and a summary. ~15x more output per card. |
| **Fast** | Every field still gets a real score, judged by the same standard — the model just doesn't write the prose. |

The recommended way to work through a big collection is **fast first**: score
everything, delete what's bad, group the duplicates and keep the best — none of which
needs the written critique. Then open the cards you're keeping and press **Rescore with
full critique** for the feedback that actually drives an improvement. Opening a single
card always asks for the full critique, whatever the scan setting is, and the
**Fast-scored (no critique yet)** filter finds every card still waiting for one.

Fast mode does *not* lower the standard: it keeps the same "never judge by length, call
out padding" instruction and is explicitly told not to be generous, because the numbers
decide what gets deleted.

**Parallel requests** now default to 10 — the most NanoGPT documents — instead of 8.
The dashboard clamps whatever you type to the provider's stated ceiling, so this cannot
get you rate-limited or banned.

Fast mode also stops sending fields that can't affect the score at all
(`alternate_greetings` has weight 0 by default), which on a greeting-heavy card cuts the
prompt dramatically as well. Full mode still critiques them.

**What it's actually worth.** Measured end to end through the real server against a
simulated API that decodes at a fixed tokens/second — because that is what an LLM's
latency actually tracks:

| 3,765 cards | quick model (40 tok/s) | slower model (12 tok/s) |
|---|---|---|
| full critique, 8 parallel (the old default) | 1.6 h | 5.0 h |
| full critique, 10 parallel (new default) | 1.3 h | 4.1 h |
| **fast mode, 10 parallel** | **1.0 h** | **1.1 h** |
| | 1.5x faster | **4.5x faster** |

The slower your model, the more fast mode is worth — it barely decodes anything, so the
model's speed stops mattering much. If a scan has been taking you many hours, this is
the setting that fixes it.

One thing to know: once answers get short, the **60 requests/minute** cap becomes the
limit rather than the model, which puts the hard ceiling at **3,600 cards/hour** however
fast everything else gets. That is NanoGPT's published rule and the scanner paces itself
to stay inside it — which is why both columns land at about an hour.

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
5. Click **More → Change folder** and browse to wherever you put your card PNGs (e.g. your
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
3. From that dashboard you can also act on what the scores tell you: group same-name
   duplicates and keep the best, copy keepers into another folder, and hand a weak card
   back to the model to be rewritten from its own critique — reviewing every change
   before it is written.

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
model) and **More → Change folder** (your characters folder) instead of hand-editing
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
  them. Use **More → Trash** to restore a card or permanently empty the trash.
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
- **Scanning never modifies your card files**, only reads them. The only things that
  write a card are **Improve with AI** and **Edit text**, and only after you press save:
  the default saves a *new* card and leaves the original alone, and replacing one in
  place keeps a copy of the previous version in Trash first.
- A card rewrite copies the artwork through byte-for-byte and preserves everything the
  tool doesn't model — lorebook, creator notes, tags, `extensions` — so nothing is lost
  that wasn't deliberately edited.
- Your score file is snapshotted to `data/backups/` before anything rewrites it
  (`node src/cli.js backups` lists them).
- Nothing here talks to SillyTavern's server or database — it only reads the same PNG
  files from disk that SillyTavern reads. Safe to run while SillyTavern is running.

## Picking the characters folder from the dashboard

You don't have to hand-edit `config.json` to point at your cards. In the dashboard,
click **More → Change folder** — it opens a server-side directory browser (click into
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
