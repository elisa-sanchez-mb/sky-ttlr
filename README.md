# Sky TTLR — Custom Code

Sky is rebuilding its TTL (Teach The Learner) product in Webflow. Webflow's own Designer can't express the interactive, stateful pieces the rebuild needs — paging through episodes without a full page load, a drag-and-drop quiz, per-member progress that survives across sessions — so those pieces are written as vanilla JS/CSS and dropped into Webflow's Custom Code embeds. This repo is where that custom code lives and is documented. Prepared by MakeBuild.

Each file is self-contained and documented inline (top comment block) with exactly what it targets, what it needs from Designer, and what it doesn't solve yet. This README explains what the project does as a whole; check the file itself for full implementation detail before wiring anything up.

## What each component does

**`sky-ttlr-episode-router.html`** turns a CMS list of episodes into a single-episode viewer. All episodes in a Series render into the page as normal (that's how Webflow's CMS binding works), but the script hides every item except one and toggles `.ttlr_episode_button.is-prev` / `.is-next` to step through them — no page navigation, no reload. The current episode number is mirrored into a `?episode=` query param via `history.pushState`, so a link straight to `?episode=3` opens on that episode. Leaving an episode (via Prev or Next) writes that episode's completion to Memberstack; once every episode in the series is marked complete, it also writes series-level completion, which is what a completion badge elsewhere on the site would read.

**`sky-ttlr-dragdrop-quiz.html`** is a matching quiz built on interact.js: each "prop" is draggable, and it only actually leaves the tray and gets placed in the DOM when it's dropped on its correct, still-empty zone (`data-correct-zone` on the prop must match `data-zone-id` on the zone) — every other drop just snaps back to the tray with a reject flash, so there's no fail state and unlimited retries. It also ships a full keyboard path (Tab to a prop, Enter to grab it, Tab to a zone, Enter to attempt the drop, Escape to cancel) and an `aria-live` region that announces placements and rejections, so it doesn't depend on drag gestures to be usable. Once every prop is correctly placed it fires a `ttlr:quizCompleted` custom event that other code can listen for.

**`sky-ttlr-series-swiper.html`** *(not yet added to this repo)* — a Swiper carousel for the CMS-bound series list.

**`sky-ttlr-glass-effect.html`** *(not yet added to this repo)* — a CSS-only "Glass" layer effect, ported 1:1 from a Figma effect panel.

**`sky-ttlr-progress-badges-bookmarks.md`** *(not yet added to this repo)* — the original architecture writeup for progress/badges/bookmarks storage. Already known to be outdated before it's even added — see the Memberstack correction below.

## Files

| File | Status |
|---|---|
| `sky-ttlr-episode-router.html` | Delivered — needs `data-series-id` added in Designer (see below) |
| `sky-ttlr-dragdrop-quiz.html` | Delivered — currently debugging zone-detection (see Known issues) |
| `sky-ttlr-series-swiper.html` | Not yet added to this repo |
| `sky-ttlr-glass-effect.html` | Not yet added to this repo |
| `sky-ttlr-progress-badges-bookmarks.md` | Not yet added to this repo — **outdated, see correction below** |

## Install

For each `.html` file: copy its contents into Webflow Site/Page Settings → Custom Code → **before `</body>`**, after `webflow.js` and after Memberstack's own script tag. A couple of files also need a `<link>`/`<script>` tag added to **Head** — noted at the top of the file itself (`sky-ttlr-series-swiper.html` needs the Swiper CSS in Head; `sky-ttlr-dragdrop-quiz.html` loads interact.js itself, no separate step needed).

## Required Designer steps

These Custom Attributes have to exist on the live markup for the scripts above to work — none of this is optional:

- **`data-episode-id`** on `.ttlr_episode_cms_item` — bind to the item's Item ID (or Slug as fallback). Already present and confirmed working on the live series pages.
- **`data-series-id`** on `.ttlr_episode_cms_list` (or any ancestor of it — the script walks up with `.closest()`) — bind to the *current* Series item's own Item ID or Slug (this page is that item's own CMS template page). **Not yet added** — without it, per-episode completion still works, but nothing rolls up to series-level completion for the badge.
- **`data-zone-id`** (static, one per zone: `"1"`–`"4"`) and **`data-correct-zone`** (CMS-bound, per prop) — both already present and correctly assigned by the drag-drop script itself at runtime; nothing to add here.
- **`.ttlr_dragdrop_drop-zone` needs a real height** in Designer — currently an empty div with no set size, which is very likely why zone drops aren't registering (see Known issues).

## Memberstack setup

Progress and bookmarks use two **Custom Fields** (Memberstack Dashboard → Settings → Custom Fields — these must be pre-declared, unlike Member JSON), mirroring the exact mechanism the existing app-launcher already uses for its `stacked-apps` field:

- **`ttl-progress`** — JSON-stringified object: `{ episodes: { [episodeId]: { completed, completedAt } }, series: { [seriesId]: { completed, completedAt } } }`
- **`ttl-bookmarks`** — JSON-stringified array of bookmarked episode Item IDs

Both fields need to be created in the Memberstack dashboard before the scripts above go live. Read/write happens via `getCurrentMember()` + `updateMember({ customFields: {...} })`.

**Correction:** `sky-ttlr-progress-badges-bookmarks.md` in this repo still documents the *earlier* plan — Memberstack's separate Member JSON feature (`getMemberJSON()`/`updateMemberJSON()`), keyed under a single `ttl` object. That approach was superseded in favor of matching the launcher's actual Custom Field pattern above. `sky-ttlr-episode-router.html` already implements the corrected version; the `.md` doc itself hasn't been rewritten yet — treat the code as the source of truth until it is.

## Known issues

- **Drag-drop zones not accepting drops.** Root cause under investigation: `.ttlr_dragdrop_drop-zone` renders as a 0-height empty div until Designer gives it real dimensions, which likely prevents interact.js's overlap check (currently `overlap: 0.4`, i.e. 40% of the prop must overlap the zone) from ever registering a valid drop against a zone with no area. Switching to `overlap: 'pointer'` would be more forgiving of a small zone, but doesn't fix a zone with *zero* height — Designer giving the zone a real size is the actual fix needed.
- **Last episode's Next button** has nowhere to go yet — no "next series" reference/link exists in the current markup, so it's disabled at the last episode rather than pointing somewhere made up.
- **Nothing marks the last episode in a series complete** — completion is currently only triggered by a Prev/Next click, which by definition never fires on the last screen. Needs a video-end, quiz-submit, or explicit "Finish" trigger instead.
- **Series completion badge isn't wired up yet.** `ttl-progress.series[seriesId]` gets written correctly once every episode in a series is complete, but whatever renders the actual badge (the `ttlr_completion_tag-wrap` element) hasn't been updated to read it — that script wasn't shared in this session.
