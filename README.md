# Sky TTLR — Custom Code

Custom JavaScript/CSS components built for Sky's TTL Webflow rebuild.
Prepared by MakeBuild.

Each file is self-contained and documented inline (top comment block) with exactly what it targets, what it needs from Designer, and what it doesn't solve yet. This README is the index — check the file itself for the full detail before wiring anything up.

## Files

| File | What it does | Status |
|---|---|---|
| `sky-ttlr-episode-router.html` | Shows one episode at a time within a Series page, Prev/Next paging, syncs `?episode=` in the URL, marks episode + series completion in Memberstack | Delivered — needs `data-series-id` added in Designer (see below) |
| `sky-ttlr-dragdrop-quiz.html` | Drag-and-drop matching quiz (interact.js) — props must land in their correct zone, unlimited retries, auto-completes | Delivered — currently debugging zone-detection (see Known issues) |
| `sky-ttlr-series-swiper.html` | Swiper carousel for the CMS-bound series list | Delivered |
| `sky-ttlr-glass-effect.html` | CSS-only "Glass" layer effect, ported 1:1 from a Figma effect panel | Delivered |
| `sky-ttlr-progress-badges-bookmarks.md` | Original architecture writeup for progress/badges/bookmarks storage | **Outdated — see correction below** |

## Install

For each `.html` file: copy its contents into Webflow Site/Page Settings → Custom Code → **before `</body>`**, after `webflow.js` and after Memberstack's own script tag. A couple of files also need a `<link>`/`<script>` tag added to **Head** — noted at the top of the file itself (`sky-ttlr-series-swiper.html` needs the Swiper CSS in Head; `sky-ttlr-dragdrop-quiz.html` loads interact.js itself, no separate step needed).

## Required Designer steps

These Custom Attributes have to exist on the live markup for the scripts above to work — none of this is optional:

- **`data-episode-id`** on `.ttlr_episode_cms_item` — bind to the item's Item ID (or Slug as fallback). Already present and confirmed working on the live series pages.
- **`data-series-id`** on `.ttlr_episode_container` — bind to the *current* Series item's own Item ID or Slug (this page is that item's own CMS template page). **Not yet added** — without it, per-episode completion still works, but nothing rolls up to series-level completion for the badge.
- **`data-zone-id`** (static, one per zone: `"1"`–`"4"`) and **`data-correct-zone`** (CMS-bound, per prop) — both already present and correctly assigned by the drag-drop script itself at runtime; nothing to add here.
- **`.ttlr_dragdrop_drop-zone` needs a real height** in Designer — currently an empty div with no set size, which is very likely why zone drops aren't registering (see Known issues).

## Memberstack setup

Progress and bookmarks use two **Custom Fields** (Memberstack Dashboard → Settings → Custom Fields — these must be pre-declared, unlike Member JSON), mirroring the exact mechanism the existing app-launcher already uses for its `stacked-apps` field:

- **`ttl-progress`** — JSON-stringified object: `{ episodes: { [episodeId]: { completed, completedAt } }, series: { [seriesId]: { completed, completedAt } } }`
- **`ttl-bookmarks`** — JSON-stringified array of bookmarked episode Item IDs

Both fields need to be created in the Memberstack dashboard before the scripts above go live. Read/write happens via `getCurrentMember()` + `updateMember({ customFields: {...} })`.

**Correction:** `sky-ttlr-progress-badges-bookmarks.md` in this repo still documents the *earlier* plan — Memberstack's separate Member JSON feature (`getMemberJSON()`/`updateMemberJSON()`), keyed under a single `ttl` object. That approach was superseded in favor of matching the launcher's actual Custom Field pattern above. `sky-ttlr-episode-router.html` already implements the corrected version; the `.md` doc itself hasn't been rewritten yet — treat the code as the source of truth until it is.

## Known issues

- **Drag-drop zones not accepting drops.** Root cause under investigation: `.ttlr_dragdrop_drop-zone` renders as a 0-height empty div until Designer gives it real dimensions, which likely prevents interact.js's overlap check from ever registering a valid drop. The script was updated to check the pointer position instead of area overlap (`overlap: 'pointer'`), which is more forgiving but still requires the zone to have non-zero size.
- **Last episode's Next button** has nowhere to go yet — no "next series" reference/link exists in the current markup, so it's disabled at the last episode rather than pointing somewhere made up.
- **Nothing marks the last episode in a series complete** — completion is currently only triggered by a Prev/Next click, which by definition never fires on the last screen. Needs a video-end, quiz-submit, or explicit "Finish" trigger instead.
- **Series completion badge isn't wired up yet.** `ttl-progress.series[seriesId]` gets written correctly once every episode in a series is complete, but whatever renders the actual badge (the `ttlr_completion_tag-wrap` element) hasn't been updated to read it — that script wasn't shared in this session.
