# Sky TTLR — Custom Code

Sky is rebuilding its TTL (Teach The Learner) product in Webflow. Webflow's own Designer can't express the interactive, stateful pieces the rebuild needs — paging through episodes without a full page load, a drag-and-drop quiz, per-member progress that survives across sessions — so those pieces are written as vanilla JS/CSS and dropped into Webflow's Custom Code embeds. This repo is where that custom code lives and is documented. Prepared by MakeBuild.

Each file is self-contained and documented inline (top comment block) with exactly what it targets, what it needs from Designer, and what it doesn't solve yet. This README explains what the project does as a whole; check the file itself for full implementation detail before wiring anything up.

## What each component does

All components below live in `sky-ttlr.js`/`sky-ttlr.css`, each under its own clearly-commented section — nothing here is a separate file anymore (see Install).

**Episode router** turns a CMS list of episodes into a single-episode viewer. All episodes in a Series render into the page as normal (that's how Webflow's CMS binding works), but the script hides every item except one and toggles `.ttlr_episode_button.is-prev` / `.is-next` to step through them — no page navigation, no reload. The current episode number is mirrored into a `?episode=` query param via `history.pushState`, so a link straight to `?episode=3` opens on that episode. Leaving an episode (via Prev or Next) writes that episode's completion to Memberstack; once every episode in the series is marked complete, it also writes series-level completion, which is what a completion badge elsewhere on the site would read. On the *last* episode, Next relabels itself "Finish Series" — clicking it marks that final episode complete (the only point this was previously falling through uncompleted) and reveals `.ttlr_series-end_success`, instead of advancing anywhere.

**Progress bar** is a single global (not per-episode) fill + "X / Y COMPLETED" readout for the whole series, driven by the same Memberstack completion data as the episode router. `.ttlr_progress_fill` grows to `completed / total` width; the CMS-bound `.ttlr_progress_segment` items sit on top and act as a mask over it (each segment is a transparent window onto the fill, the gaps between them stay opaque) — segment count is purely visual and doesn't need to match the episode count for that to work.

**Drag & drop quiz** is a matching quiz built on interact.js: each "prop" is draggable, and it only actually leaves the tray and gets placed in the DOM when it's dropped on its correct, still-empty zone (`data-correct-zone` on the prop must match `data-zone-id` on the zone) — every other drop just snaps back to the tray with a reject flash, so there's no fail state and unlimited retries. It also ships a full keyboard path (Tab to a prop, Enter to grab it, Tab to a zone, Enter to attempt the drop, Escape to cancel) and an `aria-live` region that announces placements and rejections, so it doesn't depend on drag gestures to be usable. Once every prop is correctly placed it fires a `ttlr:quizCompleted` custom event that other code can listen for.

**Bookmarks** is a single global button (`[bookmark="btn"]`, not one per episode) that bookmarks whichever episode is currently displayed by the episode router. Clicking it toggles that episode's id in Memberstack, and swaps the button's SVG icon between an outline and a solid-filled version of the same path to reflect the state. Icon state stays in sync as you page through episodes (each one shows its own bookmarked/not state immediately) and is restored correctly on page load.

**Notes pad** is a resizable notepad component. Its content is a single shared note stored in `localStorage`, not scoped per page — so the same text shows up and is editable everywhere this Webflow component is placed, since `localStorage` is already global per browser/domain. Dragging `.notes_drag_line` resizes the pad by setting an inline width on `.notes_component_wrap` (assumes the pad is anchored right and the drag line is its left edge — flip the sign in `onPointerMove` if that's backwards for your layout), and the resized width itself persists across page loads too. `[data-notes-action="copy"]` copies the note to the clipboard and flashes `.notes_copy_success`; `[data-notes-action="delete"]` arms a `.is-confirm` state on first click and clears the note (locally and in `localStorage`) on the second.

## Files

| File | Status |
|---|---|
| `sky-ttlr.js` | Delivered — episode router needs `data-series-id` added in Designer, drag-drop quiz currently debugging zone-detection (see below) |
| `sky-ttlr.css` | Delivered |

All custom behavior lives in these two files now (episode router, progress bar, drag-drop quiz, bookmarks, and notes pad today; swiper and glass-effect will fold in here once added). Webflow references them directly instead of pasting file contents into Custom Code.

## Install

**Interim setup** — this repo lives under the personal account elisa-sanchez-mb for now and will be transferred to the `makebuild-code` org (matching other MakeBuild client projects, e.g. `wih1-quiz`, which use GitHub Pages) once development is finished. Until then, `sky-ttlr.js`/`sky-ttlr.css` are served via [jsDelivr](https://www.jsdelivr.com/?docs=gh)'s GitHub CDN, pinned to a release tag (not `@main`) so a push never silently changes what's live on Sky's site.

Add to Webflow Site Settings → Custom Code → **Head**:

```html
<script src="https://cdn.jsdelivr.net/npm/interactjs/dist/interact.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/elisa-sanchez-mb/sky-ttlr@v1.3.2/sky-ttlr.css">
```

Add to Webflow Site Settings → Custom Code → **before `</body>`** (after `webflow.js` and after Memberstack's own script tag):

```html
<script src="https://cdn.jsdelivr.net/gh/elisa-sanchez-mb/sky-ttlr@v1.3.2/sky-ttlr.js"></script>
```

`interact.js` is a third-party dependency of the drag-drop quiz and is loaded from its own CDN rather than bundled into `sky-ttlr.js`, so it keeps its own versioning/caching. It's optional at runtime — if it fails to load, the drag-drop quiz no-ops rather than throwing, and the episode router is unaffected.

**To ship an update:** push to `main`, tag the commit (`git tag vX.Y.Z && git push --tags`), then update the `@vX.Y.Z` in both Webflow URLs to match.

**When transferring to `makebuild-code` later:** switch this section back to GitHub Pages (repo Settings → Pages → Deploy from a branch → `main`, `/root`, needs org admin), and update the two Webflow URLs to `https://makebuild-code.github.io/sky-ttlr/sky-ttlr.js` / `.css` — same pattern as `wih1-quiz`. Note that model drops version pinning: Pages always serves whatever's on `main`, so treat `main` as production once that switch happens.

## Required Designer steps

These Custom Attributes have to exist on the live markup for the scripts above to work — none of this is optional:

- **`data-episode-id`** on `.ttlr_episode_cms_item` — bind to the item's Item ID (or Slug as fallback). Already present and confirmed working on the live series pages.
- **`data-series-id`** on `.ttlr_episode_cms_list` (or any ancestor of it — the script walks up with `.closest()`) — bind to the *current* Series item's own Item ID or Slug (this page is that item's own CMS template page). **Not yet added** — without it, per-episode completion still works, but nothing rolls up to series-level completion for the badge.
- **`data-zone-id`** (static, one per zone: `"1"`–`"4"`) and **`data-correct-zone`** (CMS-bound, per prop) — both already present and correctly assigned by the drag-drop script itself at runtime; nothing to add here.
- **`.ttlr_dragdrop_drop-zone` needs a real height** in Designer — currently an empty div with no set size, which is very likely why zone drops aren't registering.
- **`[bookmark="btn"]`** — a single button placed once on the page (not inside each `.ttlr_episode_cms_item`), containing the bookmark ribbon SVG with an `<svg><path>` inside it. The script reads/writes that `<path>`'s `d` attribute directly to switch between outline and filled, so the SVG markup needs to be the actual `<svg>`/`<path>` element, not a background-image or other substitute.
- **`.notes_copy_success`** inside the `[data-notes-action="copy"]` button — not currently in the Designer markup, so the script auto-creates a placeholder ("Copied!") if it's missing. Add your own in Designer whenever convenient; the script only toggles `.is-active` on whichever one it finds.
- **`.ttlr_series-end_success`** — a single element placed once on the page (like the bookmark button and progress bar), hidden by default. The script only adds `.is-active` to reveal it when "Finish Series" is clicked; content/layout is Designer's.

## Memberstack setup

Progress and bookmarks use two **Custom Fields** (Memberstack Dashboard → Settings → Custom Fields — these must be pre-declared, unlike Member JSON), mirroring the exact mechanism the existing app-launcher already uses for its `stacked-apps` field:

- **`ttl-progress`** — JSON-stringified object: `{ episodes: { [episodeId]: { completed, completedAt } }, series: { [seriesId]: { completed, completedAt } } }`
- **`ttl-bookmarks`** — JSON-stringified array of bookmarked episode Item IDs

Both fields need to be created in the Memberstack dashboard before the scripts above go live. Read/write happens via `getCurrentMember()` + `updateMember({ customFields: {...} })`.
