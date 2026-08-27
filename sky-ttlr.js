/*
  Sky TTLR — Custom Code (behavior)
  Prepared by MakeBuild

  Requires interact.js to be loaded separately before this file for the
  drag & drop quiz section — see README for the required <script> tag.
*/

// Memberstack's own <script> tag (loaded separately in Webflow, per README) sets
// window.$memberstackDom, but there's no guarantee it's already set by the time our
// Webflow.push callbacks run — a one-shot `if (!window.$memberstackDom) return`
// silently and permanently no-ops for that whole page load if it loses that race.
// This polls briefly instead of assuming either order.
function waitForMemberstack(timeoutMs = 5000) {
  if (window.$memberstackDom) {
    console.log('[ttlr] waitForMemberstack: already available');
    return Promise.resolve(window.$memberstackDom);
  }
  console.log('[ttlr] waitForMemberstack: not yet available, polling…');
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = window.setInterval(() => {
      if (window.$memberstackDom) {
        window.clearInterval(interval);
        console.log('[ttlr] waitForMemberstack: became available after ' + (Date.now() - start) + 'ms');
        resolve(window.$memberstackDom);
      } else if (Date.now() - start > timeoutMs) {
        window.clearInterval(interval);
        console.error('[ttlr] Memberstack was not available after ' + timeoutMs + 'ms — is its <script> tag present and loading?');
        resolve(null);
      }
    }, 100);
  });
}

/* ---- Episode router: one visible episode at a time, Prev/Next
   navigation, completion tracking in Memberstack. ---- */

window.Webflow ||= [];
window.Webflow.push(function () {
  const lists = document.querySelectorAll('.ttlr_episode_cms_list');
  console.log('[ttlr] episode router: found ' + lists.length + ' .ttlr_episode_cms_list element(s) on this page');
  lists.forEach(initEpisodeRouter);
});

function initEpisodeRouter(listEl) {
  const items = Array.from(listEl.querySelectorAll('.ttlr_episode_cms_item'));
  console.log('[ttlr] initEpisodeRouter: found ' + items.length + ' .ttlr_episode_cms_item inside this list', listEl);
  if (!items.length) {
    console.warn('[ttlr] initEpisodeRouter: bailing out, no .ttlr_episode_cms_item found — nothing in this section (episode paging, bookmarks, progress bar) will run.');
    return;
  }

  let currentIndex = 0;
  let hasShownOnce = false; // first show() is an instant cut, not a crossfade — nothing to fade from yet

  function numberOf(item) {
    const span = item.querySelector('.ttlr_episode_col_left-number');
    return span ? span.textContent.trim() : null;
  }

  const warnedMissingEpisodeId = new Set();
  function idOf(item, index) {
    if (item.dataset.episodeId) return item.dataset.episodeId;
    if (!warnedMissingEpisodeId.has(index)) {
      warnedMissingEpisodeId.add(index);
      console.warn(
        '[ttlr] .ttlr_episode_cms_item is missing data-episode-id — falling back to a ' +
        'page+number key. Add data-episode-id in Designer (Item ID, or Slug as a fallback) ' +
        'so completion survives independently of the visible episode number.'
      );
    }
    return `${window.location.pathname}#${numberOf(item) || index}`;
  }

  // ---- Series ID: required for series-level completion (drives the badge) ----
  // Every episode on this page belongs to the SAME series — this page IS
  // that series' own CMS template page — so the series ID only needs to be
  // read once, from a Custom Attribute on the list wrapper itself or an
  // ancestor of it, not per-episode. Bind data-series-id to the current
  // Series item's own Item ID (or Slug) via Designer's Custom Attributes.
  function resolveSeriesId() {
    const holder = listEl.closest('[data-series-id]') || listEl;
    if (holder.dataset.seriesId) return holder.dataset.seriesId;
    console.warn(
      '[ttlr] No data-series-id found on or above .ttlr_episode_cms_list — series-level ' +
      'completion (for the completion badge on the series card) will not be recorded. Add ' +
      "data-series-id in Designer, bound to this page's own Series Item ID or Slug."
    );
    return null;
  }
  const seriesId = resolveSeriesId();

  // ---- Memberstack: read/write completion in the ttl-progress Custom Field ----
  // Same mechanism as the app-launcher's stacked-apps field: a Custom Field
  // holding a JSON-stringified string, not Member JSON. Self-contained on
  // purpose — if a shared read/write helper for ttl-progress already exists
  // site-wide (e.g. from the progress/badges/bookmarks doc), prefer
  // consolidating into that rather than running two independent read-modify-
  // write cycles against the same field, which can race and clobber a badge/
  // bookmark write with a stale episodes object or vice versa.
  const PROGRESS_FIELD = 'ttl-progress';
  const PROGRESS_LOCAL_KEY = 'ttlr-progress-local';
  // Matches the stacked-apps launcher's own SAVE_WAIT_MS — same reasoning:
  // collapse rapid changes into a single Memberstack write instead of one per click.
  const SAVE_DEBOUNCE_MS = 500;

  function loadLocalProgress() {
    try {
      return JSON.parse(window.localStorage.getItem(PROGRESS_LOCAL_KEY)) || {};
    } catch (err) {
      console.error('[ttlr] Failed to read local progress cache', err);
      return {};
    }
  }

  function saveLocalProgress(data) {
    try {
      window.localStorage.setItem(PROGRESS_LOCAL_KEY, JSON.stringify(data));
    } catch (err) {
      console.error('[ttlr] Failed to save local progress cache', err);
    }
  }

  // Additive merge: a completion recorded on EITHER side wins. Completion
  // never gets un-set by merging, only added — safe regardless of which
  // side (local cache vs Memberstack) is "newer".
  function mergeCompletionMaps(a, b) {
    const merged = { ...(a || {}) };
    Object.keys(b || {}).forEach((key) => {
      if (!merged[key] || (b[key]?.completed && !merged[key].completed)) merged[key] = b[key];
    });
    return merged;
  }

  // Local-first: read the cache synchronously so completion/progress state is
  // available instantly, before Memberstack has even started loading (same
  // pattern as the stacked-apps launcher's local-first render).
  let progressCache = loadLocalProgress();
  progressCache.episodes = progressCache.episodes || {};

  let progressSaveTimer = null;
  function saveProgressToMemberstackDebounced() {
    window.clearTimeout(progressSaveTimer);
    progressSaveTimer = window.setTimeout(async () => {
      const ms = await waitForMemberstack();
      if (!ms) return;
      try {
        const { data: member } = await ms.getCurrentMember();
        if (!member) {
          // Silent before — this is the #1 suspect for "local storage
          // updates fine, Memberstack never does": local-first means
          // saveLocalProgress() above already ran regardless of login
          // state, but there's genuinely nothing to write to Memberstack
          // if nobody's logged in as a member on this page.
          console.warn('[ttlr] progress: getCurrentMember() returned no member (not logged in?) — skipping the Memberstack write, only localStorage was updated.');
          return;
        }

        // Merge with whatever's on the server right now (not a blind
        // overwrite), in case another tab/device wrote since we last hydrated.
        let remote = {};
        const raw = member.customFields?.[PROGRESS_FIELD];
        if (raw) {
          try {
            remote = JSON.parse(raw);
          } catch (parseErr) {
            console.error('[ttlr] Could not parse existing ' + PROGRESS_FIELD + ', overwriting with local', parseErr);
          }
        }
        const merged = {
          episodes: mergeCompletionMaps(remote.episodes, progressCache.episodes),
          series: mergeCompletionMaps(remote.series, progressCache.series),
        };
        progressCache = merged;
        saveLocalProgress(merged);

        const { data: updatedMember } = await ms.updateMember({
          customFields: { [PROGRESS_FIELD]: JSON.stringify(merged) },
        });
        console.log('[ttlr] progress: synced to Memberstack ->', merged, '/ updateMember response customFields:', updatedMember?.customFields);
        if (!updatedMember?.customFields?.[PROGRESS_FIELD]) {
          // Same symptom previously confirmed for ttl-bookmarks: Memberstack
          // silently drops a customFields write whose key doesn't exactly
          // match the field's actual Key (as opposed to its dashboard Label).
          console.warn('[ttlr] progress: updateMember response did NOT include "' + PROGRESS_FIELD + '" — the write was likely silently rejected by Memberstack. Check Settings → Custom Fields → the progress field\'s exact Key matches PROGRESS_FIELD = "' + PROGRESS_FIELD + '" (not just its Label).');
        }
        updateProgressDisplay(merged.episodes);
      } catch (err) {
        console.error('[ttlr] Failed to save episode completion to Memberstack', err);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  // Updates local state + the visual instantly; the Memberstack write happens
  // afterward, debounced, in the background — no network round-trip on the
  // click path, so the UI never waits on it.
  function markComplete(episodeId) {
    console.log('[ttlr] markComplete called for episode', episodeId);
    if (!episodeId) return;
    if (progressCache.episodes[episodeId]?.completed) return; // already done, nothing to do

    progressCache.episodes[episodeId] = {
      ...(progressCache.episodes[episodeId] || {}),
      completed: true,
      completedAt: new Date().toISOString(),
    };

    // ---- Roll up to series-level completion (this drives the home page
    // card badge — see initSeriesCard). completedCount/total are written on
    // EVERY call, not just once the series is fully done, so the home page
    // can show a running "3/5" — not just a boolean. They all belong to the
    // same series (see resolveSeriesId above), so this is just a check
    // against ids already on the page — no extra fetch needed.
    if (seriesId) {
      progressCache.series = progressCache.series || {};
      const completedCount = items.filter((item, i) => progressCache.episodes[idOf(item, i)]?.completed).length;
      const total = items.length;
      const wasComplete = progressCache.series[seriesId]?.completed;
      const isComplete = completedCount === total;
      progressCache.series[seriesId] = {
        ...(progressCache.series[seriesId] || {}),
        completedCount,
        total,
        completed: isComplete,
        completedAt: isComplete ? (wasComplete ? progressCache.series[seriesId]?.completedAt : new Date().toISOString()) : undefined,
      };
    }

    saveLocalProgress(progressCache);
    updateProgressDisplay(progressCache.episodes);
    console.log('[ttlr] markComplete: local state updated instantly, Memberstack sync queued', progressCache);
    saveProgressToMemberstackDebounced();
  }

  // ---- Progress bar: global (one per page, not per-episode) completed/total
  // display for this series. The fill percentage is applied via clip-path
  // (not width) so .ttlr_progress_fill's own box never changes size — that
  // matters because the segment mask below is computed in percentages of
  // THIS element's own box, and a mask-image's percentages are relative to
  // the masked element's current size. If width itself drove the fill %,
  // the mask would misalign every time the percentage changed.
  const progressFill = document.querySelector('.ttlr_progress_fill');
  const progressP = document.querySelector('.ttlr_episode_progress_p');
  // The bar's own immediate wrapper (holds the fill + segments) — hidden
  // alongside the count text on series completion, see showSeriesEndSuccess.
  const progressBarEl = document.querySelector('.ttlr_episode_progress_inner');
  console.log('[ttlr] progress bar: .ttlr_progress_fill', progressFill, '/ .ttlr_episode_progress_p', progressP, '/ .ttlr_episode_progress_inner', progressBarEl);

  let lastProgressPercent = null; // null = no comparison basis yet, so the first paint never "pulses"

  function updateProgressDisplay(episodesProgress) {
    const total = items.length;
    const completed = items.filter((item, i) => episodesProgress?.[idOf(item, i)]?.completed).length;
    const percent = total ? (completed / total) * 100 : 0;
    console.log('[ttlr] updateProgressDisplay: ' + completed + '/' + total + ' (' + percent.toFixed(1) + '%)');

    if (progressFill) {
      // Only ever reveals more/less of Designer's own gradient via clip-path —
      // never touches the gradient itself (background-image, position, size,
      // etc. are entirely Designer's). Confirmed intent: one continuous
      // gradient revealed proportionally, cut into pill segments purely by
      // the mask below — not a per-segment/panned color.
      progressFill.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;

      // Brief pulse on a genuine increase only (not on the initial paint, and
      // not on every re-render) — see .is-updated in sky-ttlr.css. Uses
      // filter (brightness), not background, so it still never touches
      // Designer's gradient.
      if (lastProgressPercent !== null && percent > lastProgressPercent) {
        progressFill.classList.add('is-updated');
        window.setTimeout(() => progressFill.classList.remove('is-updated'), 500);
      }
      lastProgressPercent = percent;
    }

    // Structure is <span>completed</span><span>/</span><span>total</span><span class="...">COMPLETED</span>
    // — no distinguishing attribute on the count spans, so this relies on position.
    if (progressP) {
      const counts = progressP.children;
      if (counts[0]) counts[0].textContent = String(completed);
      if (counts[2]) counts[2].textContent = String(total);
    }
  }

  // Instant paint from the local cache — no waiting on Memberstack.
  updateProgressDisplay(progressCache.episodes);

  // ---- Segment mask: measures each .ttlr_progress_segment's ACTUAL rendered
  // position (whatever Designer's own layout/CSS produces — flex, grid,
  // gaps, anything) and builds a matching mask-image on .ttlr_progress_fill,
  // rather than assuming a specific CSS stacking/background trick. This is
  // what makes the fill only show through where the segments are.
  function updateProgressMask() {
    if (!progressFill) return;
    const segmentEls = Array.from(document.querySelectorAll('.ttlr_progress_segment'));
    console.log('[ttlr] updateProgressMask: found ' + segmentEls.length + ' .ttlr_progress_segment element(s)');
    if (!segmentEls.length) return;

    const fillRect = progressFill.getBoundingClientRect();
    if (!fillRect.width) {
      console.warn('[ttlr] updateProgressMask: .ttlr_progress_fill has zero width, skipping — is it hidden or unstyled?');
      return;
    }

    const stops = [];
    let cursor = 0;
    segmentEls
      .map((seg) => seg.getBoundingClientRect())
      .sort((a, b) => a.left - b.left)
      .forEach((segRect) => {
        const startPct = Math.max(0, ((segRect.left - fillRect.left) / fillRect.width) * 100);
        const endPct = Math.min(100, ((segRect.right - fillRect.left) / fillRect.width) * 100);
        if (endPct <= cursor) return; // overlapping/degenerate — skip
        stops.push(`transparent ${cursor}%`, `transparent ${startPct}%`, `black ${startPct}%`, `black ${endPct}%`);
        cursor = endPct;
      });
    stops.push(`transparent ${cursor}%`, `transparent 100%`);

    const gradient = `linear-gradient(to right, ${stops.join(', ')})`;
    progressFill.style.maskImage = gradient;
    progressFill.style.webkitMaskImage = gradient;
    console.log('[ttlr] updateProgressMask: applied mask-image', gradient);
  }

  if (progressFill) {
    // Segment positions can shift after Webflow's own render pass settles
    // (CMS lists, fonts loading, etc.) — rAF + a short delayed re-check
    // catches that without needing a full ResizeObserver setup.
    requestAnimationFrame(updateProgressMask);
    window.setTimeout(updateProgressMask, 500);
    window.addEventListener('resize', () => {
      window.clearTimeout(progressFill._ttlrResizeTimer);
      progressFill._ttlrResizeTimer = window.setTimeout(updateProgressMask, 150);
    });
  }

  // Hydrate from Memberstack in the background and merge additively — picks
  // up completions recorded on another device/session, without blocking the
  // instant local-cache paint above.
  waitForMemberstack().then(async (ms) => {
    if (!ms) return;
    try {
      const { data: member } = await ms.getCurrentMember();
      if (!member) return;
      const raw = member.customFields?.[PROGRESS_FIELD];
      console.log('[ttlr] progress bar: remote ' + PROGRESS_FIELD + ' raw value from Memberstack:', raw);
      if (!raw) return;
      const remote = JSON.parse(raw);
      const merged = {
        episodes: mergeCompletionMaps(progressCache.episodes, remote.episodes),
        series: mergeCompletionMaps(progressCache.series, remote.series),
      };
      progressCache = merged;
      saveLocalProgress(merged);
      updateProgressDisplay(merged.episodes);
    } catch (err) {
      console.error('[ttlr] Failed to read progress for progress bar', err);
    }
  });

  // ---- Series-end success screen: shown when "Finish Series" is clicked on
  // the last episode (see updateButtonStates / the click-wiring loop below).
  const seriesEndSuccessEl = document.querySelector('.ttlr_series-end_success');
  const completedEpisodeWrapEl = document.querySelector('.ttlr_completed_episode_wrap');
  const seriesSecondsEl = document.querySelector('[data-series-element="seconds"]');
  // The whole section wrapping the episode viewer (cards, menu row, etc.) —
  // hidden alongside the episode item itself so the success screen truly
  // fills the whole screen, not just the space the episode item occupied.
  const episodeCardsSectionEl = document.querySelector('.ttlr_episode_cards_section');
  console.log('[ttlr] series-end: .ttlr_series-end_success', seriesEndSuccessEl, '/ .ttlr_completed_episode_wrap', completedEpisodeWrapEl, '/ [data-series-element="seconds"]', seriesSecondsEl, '/ .ttlr_episode_cards_section', episodeCardsSectionEl);

  // Force a clean closed state on load, regardless of whether the static
  // Designer markup happens to already have .is-active on either element
  // (e.g. left on from building/previewing it in Designer) — this screen
  // must only ever appear as a direct result of clicking "Finish Series".
  if (seriesEndSuccessEl?.classList.contains('is-active')) {
    console.warn('[ttlr] series-end: .ttlr_series-end_success had .is-active already present on load — removing it. Check the Designer markup isn\'t shipping this class by default.');
    seriesEndSuccessEl.classList.remove('is-active');
  }
  if (completedEpisodeWrapEl?.classList.contains('is-active')) {
    console.warn('[ttlr] series-end: .ttlr_completed_episode_wrap had .is-active already present on load — removing it. Check the Designer markup isn\'t shipping this class by default.');
    completedEpisodeWrapEl.classList.remove('is-active');
  }

  // Confetti is a third-party dependency (canvas-confetti) — self-loading
  // rather than requiring a separate Webflow <script> tag (same pattern as
  // the app-launcher's own loadMemberstack()): if it's not already present
  // and no matching <script> tag is already loading, this injects one
  // itself, so the celebration works without a manual setup step.
  function loadConfettiLib() {
    return new Promise((resolve) => {
      if (typeof window.confetti === 'function') return resolve(window.confetti);
      const existing = document.querySelector('script[src*="canvas-confetti"]');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.confetti || null));
        existing.addEventListener('error', () => resolve(null));
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/canvas-confetti@1/dist/confetti.browser.min.js';
      s.onload = () => resolve(window.confetti || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }

  async function fireConfetti() {
    const confetti = await loadConfettiLib();
    if (typeof confetti !== 'function') {
      console.warn('[ttlr] confetti: could not load canvas-confetti (network/ad-blocker?) — no celebration effect this time.');
      return;
    }
    confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
  }

  // 30s countdown into [data-series-element="seconds"]. Guards against
  // overlapping intervals if "Finish Series" is somehow triggered more than
  // once (markComplete() itself is idempotent, but this screen can still be
  // re-shown) — always clears any previous countdown before starting a new one.
  let seriesEndCountdownInterval = null;
  function startSeriesEndCountdown() {
    if (!seriesSecondsEl) {
      console.warn('[ttlr] series-end: [data-series-element="seconds"] not found — countdown cannot run (it will keep showing whatever static text is baked into the Designer markup).');
      return;
    }
    window.clearInterval(seriesEndCountdownInterval);
    let secondsLeft = 30;
    seriesSecondsEl.textContent = String(secondsLeft);
    console.log('[ttlr] series-end: countdown started at ' + secondsLeft + 's');
    seriesEndCountdownInterval = window.setInterval(() => {
      secondsLeft -= 1;
      seriesSecondsEl.textContent = String(Math.max(0, secondsLeft));
      if (secondsLeft <= 0) {
        window.clearInterval(seriesEndCountdownInterval);
        // Auto-advance: click whichever "next series" button(s) are on the
        // page. If there's no next series, wireNavButton() (in initSeriesNav)
        // never attaches a click handler and strips the href on disabled
        // buttons, so this is a harmless no-op in that case — nothing to
        // guard here.
        const nextBtns = document.querySelectorAll('[data-series-nav="next-btn"]');
        console.log('[ttlr] series-end: countdown reached 0, auto-clicking ' + nextBtns.length + ' [data-series-nav="next-btn"] element(s)');
        nextBtns.forEach((btn) => btn.click());
      }
    }, 1000);
  }

  function showSeriesEndSuccess(episodeItem) {
    if (episodeItem) episodeItem.style.display = 'none'; // only the success screen should show, not the episode underneath it
    if (episodeCardsSectionEl) episodeCardsSectionEl.style.display = 'none'; // whole section, so the success screen fills the whole screen
    if (progressBarEl) progressBarEl.style.display = 'none'; // the episode progress bar shouldn't show once the series is done either
    if (progressP) progressP.style.display = 'none';
    if (bookmarkBtn) bookmarkBtn.style.display = 'none'; // bookmarking a finished episode isn't actionable from this screen
    if (seriesEndSuccessEl) seriesEndSuccessEl.classList.add('is-active');
    if (completedEpisodeWrapEl) completedEpisodeWrapEl.classList.add('is-active');
    fireConfetti();
    startSeriesEndCountdown();
  }

  // ---- Bookmarks: one global button (not per-episode) that bookmarks whichever
  // episode is currently displayed. Read/write in the ttl-bookmarks Custom Field —
  // kept separate from ttl-progress above so a bookmark toggle and a completion
  // write never contend over the same field's read-modify-write cycle.
  const BOOKMARKS_FIELD = 'ttl-bookmarks';
  const bookmarkBtn = document.querySelector('[bookmark="btn"]');
  console.log('[ttlr] bookmarks: [bookmark="btn"] element', bookmarkBtn);
  if (!bookmarkBtn) {
    console.warn('[ttlr] bookmarks: no element matches [bookmark="btn"] on this page — bookmark button will not do anything until that attribute exists in Designer.');
  }

  // The provided icon is a single path drawn with two subpaths + evenodd fill, which
  // renders as a hollow/outline ribbon (the second subpath is the outer boundary, the
  // first carves out the inner hole). Dropping the first subpath leaves just the outer
  // boundary as an ordinary filled shape — the "bookmarked" solid version of the icon.
  const BOOKMARK_OUTLINE_D = 'M6.10982 14.7059C6.48066 14.3969 7.01934 14.3969 7.39018 14.7059L12 18.5474V1.5H1.5V18.5474L6.10982 14.7059ZM6.75 16.125L12.2699 20.7249C12.7584 21.132 13.5 20.7846 13.5 20.1487V0.75C13.5 0.335786 13.1642 0 12.75 0H0.75C0.335786 0 0 0.335787 0 0.750001V20.1487C0 20.7846 0.741645 21.132 1.23014 20.7249L6.75 16.125Z';
  const BOOKMARK_SOLID_D = 'M6.75 16.125L12.2699 20.7249C12.7584 21.132 13.5 20.7846 13.5 20.1487V0.75C13.5 0.335786 13.1642 0 12.75 0H0.75C0.335786 0 0 0.335787 0 0.750001V20.1487C0 20.7846 0.741645 21.132 1.23014 20.7249L6.75 16.125Z';

  function setBookmarkVisual(isBookmarked) {
    if (!bookmarkBtn) return;
    const path = bookmarkBtn.querySelector('svg path');
    console.log('[ttlr] setBookmarkVisual(' + isBookmarked + ') — svg path found:', !!path);
    if (!path) {
      console.warn('[ttlr] bookmarks: [bookmark="btn"] has no <svg><path> inside it — the fill toggle has nothing to update. Check the SVG markup is a real <svg>/<path>, not a background-image.');
      return;
    }
    path.setAttribute('d', isBookmarked ? BOOKMARK_SOLID_D : BOOKMARK_OUTLINE_D);
    bookmarkBtn.classList.toggle('is-bookmarked', isBookmarked);
    bookmarkBtn.setAttribute('aria-pressed', String(isBookmarked));
  }

  const BOOKMARKS_LOCAL_KEY = 'ttlr-bookmarks-local';

  function loadLocalBookmarks() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(BOOKMARKS_LOCAL_KEY));
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error('[ttlr] Failed to read local bookmarks cache', err);
      return [];
    }
  }

  function saveLocalBookmarks(bookmarks) {
    try {
      window.localStorage.setItem(BOOKMARKS_LOCAL_KEY, JSON.stringify(bookmarks));
    } catch (err) {
      console.error('[ttlr] Failed to save local bookmarks cache', err);
    }
  }

  // Local-first, same pattern as progress above (and the stacked-apps
  // launcher): read the cache synchronously so bookmark state is available —
  // and the icon paints correctly — instantly, before Memberstack loads.
  let bookmarksCache = loadLocalBookmarks();

  let bookmarksSaveTimer = null;
  function saveBookmarksToMemberstackDebounced() {
    window.clearTimeout(bookmarksSaveTimer);
    bookmarksSaveTimer = window.setTimeout(async () => {
      const ms = await waitForMemberstack();
      if (!ms) return;
      try {
        const { data: member } = await ms.getCurrentMember();
        if (!member) return; // not logged in — nothing to persist to

        // Write the current local state AS-IS — deliberately NOT merged
        // with whatever's remote. Unlike progress (monotonic, only ever
        // adds), a bookmark can be legitimately removed — union-merging
        // with a possibly-stale remote array silently resurrected anything
        // just unbookmarked (confirmed bug: unbookmarking, then trying to
        // re-bookmark, appeared to do nothing). bookmarksCache is always
        // the authoritative "what the user's actions actually resulted in".
        await ms.updateMember({
          customFields: { [BOOKMARKS_FIELD]: JSON.stringify(bookmarksCache) },
        });
        console.log('[ttlr] bookmarks: synced to Memberstack ->', bookmarksCache);
      } catch (err) {
        console.error('[ttlr] Failed to save bookmark to Memberstack', err);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  if (bookmarkBtn) {
    // Instant paint from the local cache — no waiting on Memberstack.
    setBookmarkVisual(bookmarksCache.includes(idOf(items[currentIndex], currentIndex)));

    // Hydrate from Memberstack in the background and merge (union) — picks up
    // bookmarks recorded on another device/session, without blocking the paint above.
    waitForMemberstack().then(async (ms) => {
      if (!ms) return;
      try {
        const { data: member } = await ms.getCurrentMember();
        if (!member) return;
        const raw = member.customFields?.[BOOKMARKS_FIELD];
        console.log('[ttlr] bookmarks: remote ' + BOOKMARKS_FIELD + ' raw value from Memberstack:', raw);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const remote = Array.isArray(parsed) ? parsed : [];
        const merged = Array.from(new Set([...bookmarksCache, ...remote]));
        bookmarksCache = merged;
        saveLocalBookmarks(merged);
        setBookmarkVisual(merged.includes(idOf(items[currentIndex], currentIndex)));
      } catch (err) {
        console.error('[ttlr] Failed to read bookmarks from Memberstack', err);
      }
    });

    // Synchronous now — no network wait before the icon updates. The
    // Memberstack write happens afterward, debounced, in the background.
    bookmarkBtn.addEventListener('click', () => {
      console.log('[ttlr] bookmark button clicked');
      const episodeId = idOf(items[currentIndex], currentIndex);
      const isBookmarked = bookmarksCache.includes(episodeId);
      bookmarksCache = isBookmarked
        ? bookmarksCache.filter((id) => id !== episodeId)
        : [...bookmarksCache, episodeId];

      saveLocalBookmarks(bookmarksCache);
      setBookmarkVisual(!isBookmarked);
      console.log('[ttlr] bookmark click: local state updated instantly ->', bookmarksCache);

      saveBookmarksToMemberstackDebounced();
    });
  }

  // ---- Show exactly one item; sync the URL; update button states ----
  const EPISODE_TRANSITION_MS = 150; // keep in sync with the CSS transition duration on .ttlr_episode_cms_item

  function show(index) {
    const outgoingItem = hasShownOnce ? items[currentIndex] : null;
    const incomingItem = items[index];
    currentIndex = index;

    if (!outgoingItem || outgoingItem === incomingItem) {
      // First paint (or somehow re-showing the same item): instant, no fade.
      items.forEach((item, i) => {
        item.style.display = i === index ? '' : 'none';
      });
      hasShownOnce = true;
    } else {
      // Sequential fade: fully hide the outgoing item before showing the
      // incoming one. A true simultaneous crossfade needs both items
      // absolutely positioned to overlap in place — without that, having
      // both in normal document flow at once (even briefly) visibly jumps
      // the page height/layout as they stack, which read as "glitchy".
      // Sequential is layout-safe regardless of Designer's markup.
      outgoingItem.classList.add('ttlr-episode-fade');
      window.setTimeout(() => {
        outgoingItem.style.display = 'none';
        outgoingItem.classList.remove('ttlr-episode-fade');

        incomingItem.style.display = '';
        incomingItem.classList.add('ttlr-episode-fade');
        // Force a reflow so the browser commits the opacity:0 starting state
        // before removing the class — otherwise add+remove in the same tick
        // would get coalesced into a no-op with nothing to animate from.
        void incomingItem.offsetWidth;
        incomingItem.classList.remove('ttlr-episode-fade');
      }, EPISODE_TRANSITION_MS);
    }

    const number = numberOf(items[index]);
    if (number) {
      const url = new URL(window.location.href);
      url.searchParams.set('episode', number);
      history.pushState({ episodeIndex: index }, '', url);
    }

    updateButtonStates(index);
    setBookmarkVisual(bookmarksCache.includes(idOf(items[index], index)));
  }

  function updateButtonStates(index) {
    const current = items[index];
    const prevBtn = current.querySelector('.ttlr_episode_button.is-prev');
    const nextBtn = current.querySelector('.ttlr_episode_button.is-next');

    if (prevBtn) {
      const disablePrev = index === 0;
      prevBtn.disabled = disablePrev;
      prevBtn.classList.toggle('is-disabled', disablePrev);
      prevBtn.setAttribute('aria-disabled', String(disablePrev));
    }

    if (nextBtn) {
      // Always actionable now: on every episode but the last it advances
      // (see the click-wiring loop below); on the last one it's relabeled
      // "Finish Series" and marks that episode complete + shows the
      // .ttlr_series-end_success screen instead of advancing anywhere.
      nextBtn.disabled = false;
      nextBtn.classList.remove('is-disabled');
      nextBtn.setAttribute('aria-disabled', 'false');
      if (index === items.length - 1) {
        nextBtn.textContent = 'Finish Series';
      }
    }

    // ---- [next-episode-number] / [prev-episode-number]: filled with the ----
    // adjacent episode's actual visible number, not index±1 (kept
    // consistent with numberOf() everywhere else, in case numbers are ever
    // non-contiguous). No Designer binding needed for either — the script
    // writes the attribute value AND mirrors it into the element's text,
    // so it works whether you style off the attribute (content:
    // attr(next-episode-number)) or just read the element's own text.
    const nextNumberTarget = current.querySelector('[next-episode-number]');
    if (nextNumberTarget) {
      const nextItem = items[index + 1];
      // Last episode: no next item — left blank rather than guessing at a
      // number that doesn't exist (the Next button itself becomes "Finish
      // Series" here instead, see above).
      const nextNumber = nextItem ? numberOf(nextItem) || '' : '';
      nextNumberTarget.setAttribute('next-episode-number', nextNumber);
      nextNumberTarget.textContent = nextNumber;
    }

    const prevNumberTarget = current.querySelector('[prev-episode-number]');
    if (prevNumberTarget) {
      const prevItem = items[index - 1];
      // First episode: no prev item — left blank, same reasoning as above.
      const prevNumber = prevItem ? numberOf(prevItem) || '' : '';
      prevNumberTarget.setAttribute('prev-episode-number', prevNumber);
      prevNumberTarget.textContent = prevNumber;
    }
  }

  // Plain navigation — no completion side effect. Used by Prev, so going
  // back to re-watch an earlier episode never marks the one you're leaving
  // as complete (only actively clicking Next on it does that, below).
  function goTo(targetIndex) {
    if (targetIndex < 0 || targetIndex >= items.length) return;
    show(targetIndex);
  }

  items.forEach((item, index) => {
    const prevBtn = item.querySelector('.ttlr_episode_button.is-prev');
    const nextBtn = item.querySelector('.ttlr_episode_button.is-next');
    if (prevBtn) prevBtn.addEventListener('click', () => goTo(index - 1));
    if (nextBtn) {
      const isLast = index === items.length - 1;
      nextBtn.addEventListener('click', () => {
        if (isLast) {
          console.log('[ttlr] "Finish Series" clicked on episode index ' + index);
          markComplete(idOf(item, index));
          showSeriesEndSuccess(item);
        } else {
          // Completion happens specifically on Next — landing on an episode
          // (via URL, Prev, or initial load) never marks it complete, only
          // actively moving forward past it does.
          markComplete(idOf(item, index));
          goTo(index + 1);
        }
      });
    }
  });

  // ---- Initial episode from ?episode= in the URL, defaulting to the first ----
  const requestedNumber = new URL(window.location.href).searchParams.get('episode');
  let startIndex = 0;
  if (requestedNumber) {
    const match = items.findIndex((item) => numberOf(item) === requestedNumber);
    if (match !== -1) startIndex = match;
  }
  show(startIndex);
}

/* ---- Drag & drop matching quiz (interact.js) ---- */

window.Webflow ||= [];
window.Webflow.push(function () {
  if (typeof interact === 'undefined') {
    console.warn('[ttlr] drag-drop quiz: interact.js is not loaded (typeof interact === "undefined") — check its <script> tag is present and loads before this file.');
    return;
  }
  const wraps = document.querySelectorAll('.ttlr_dragdrop_wrap');
  console.log('[ttlr] drag-drop quiz: found ' + wraps.length + ' .ttlr_dragdrop_wrap element(s) on this page');
  wraps.forEach(initTtlrDragDrop);
});

function initTtlrDragDrop(root) {
  const tray = root.querySelector('.ttlr_dragdrop_props_wrap');
  const props = Array.from(root.querySelectorAll('.ttlr_dragdrop_prop_item[data-correct-zone]'));
  const resetBtn = root.querySelector('.ttlr_dragdrop_reset');
  const live = ensureLiveRegion(root);
  console.log('[ttlr] initTtlrDragDrop: tray', tray, '/ ' + props.length + ' prop(s) with data-correct-zone');

  if (!tray || !props.length) {
    console.warn('[ttlr] initTtlrDragDrop: bailing out — missing .ttlr_dragdrop_props_wrap or no .ttlr_dragdrop_prop_item[data-correct-zone] found.');
    return;
  }

  let complete = false;

  // ---- Build the zone registry: zoneId -> { wrapperEl, slotEl, label } ----
  const zones = new Map();
  root.querySelectorAll('.ttlr_dragdrop_label_item[data-zone-id]').forEach((wrapperEl) => {
    const slotEl = wrapperEl.querySelector('.ttlr_dragdrop_drop-zone');
    if (!slotEl) return;
    const zoneId = wrapperEl.dataset.zoneId;

    // Defensive: ignore/overwrite whatever the slot div's own data-zone-id
    // says (see note at top of file) — the wrapper is the source of truth.
    slotEl.removeAttribute('data-zone-id');
    slotEl.dataset.zoneId = zoneId;
    slotEl.dataset.dropRole = 'zone';
    slotEl.setAttribute('tabindex', '0');
    slotEl.setAttribute('role', 'button');
    slotEl.setAttribute('aria-roledescription', 'Drop target');

    const labelText = Array.from(wrapperEl.children)
      .find((child) => child !== slotEl && child.tagName !== 'IMG')
      ?.textContent.trim() || `Zone ${zoneId}`;

    zones.set(zoneId, { wrapperEl, slotEl, label: labelText });
  });
  console.log('[ttlr] drag-drop: zone registry ->', Array.from(zones.keys()));
  console.log('[ttlr] drag-drop: prop correctZone values ->', props.map((p) => p.dataset.correctZone));

  tray.dataset.dropRole = 'tray';
  tray.setAttribute('tabindex', '0');
  tray.setAttribute('role', 'button');
  tray.setAttribute('aria-roledescription', 'Drop target');

  const dropTargets = [tray, ...Array.from(zones.values()).map((z) => z.slotEl)];

  // ---- Helpers ----
  function labelFor(targetEl) {
    if (targetEl === tray) return 'the option tray';
    return zones.get(targetEl.dataset.zoneId)?.label || `Zone ${targetEl.dataset.zoneId}`;
  }

  function occupantOf(targetEl) {
    return targetEl === tray ? null : (targetEl.children[0] || null);
  }

  function resetTransform(el) {
    el.style.transform = '';
    el.removeAttribute('data-x');
    el.removeAttribute('data-y');
  }

  // The ONLY function that actually moves a prop in the DOM. Called
  // exactly once per prop, the moment it's correctly placed.
  function place(propEl, targetEl) {
    resetTransform(propEl);
    targetEl.appendChild(propEl);
  }

  function announce(message) {
    live.textContent = '';
    requestAnimationFrame(() => { live.textContent = message; });
  }

  function flashReject(propEl, zoneEl) {
    propEl.classList.add('is-rejected');
    window.setTimeout(() => propEl.classList.remove('is-rejected'), 300);
    if (zoneEl && zoneEl !== tray) {
      zoneEl.classList.add('is-rejected');
      window.setTimeout(() => zoneEl.classList.remove('is-rejected'), 400);
    }
  }

  function lockProp(propEl) {
    propEl.setAttribute('tabindex', '-1');
    propEl.setAttribute('aria-disabled', 'true');
    const action = interact(propEl);
    if (action) action.draggable(false);
  }

  // A drop is only ever accepted onto its correct, currently-empty zone.
  // Anything else just resets the transform — since the prop was never
  // actually moved out of the tray, "rejecting" it means doing nothing.
  function handleDrop(propEl, targetEl) {
    if (complete || propEl.classList.contains('is-correct')) return;

    if (targetEl === tray) {
      resetTransform(propEl); // back onto the tray it never left — settle visually
      return;
    }

    const isCorrectZone = targetEl.dataset.zoneId === propEl.dataset.correctZone;
    const isOccupied = !!occupantOf(targetEl);
    console.log('[ttlr] drag-drop: dropped prop (correctZone=' + propEl.dataset.correctZone + ') onto zone ' + targetEl.dataset.zoneId + ' — correctZone match: ' + isCorrectZone + ', occupied: ' + isOccupied);

    if (!isCorrectZone || isOccupied) {
      resetTransform(propEl); // reject — snaps back to its exact spot, nothing moved
      flashReject(propEl, targetEl);
      announce(`Not quite — try another zone for ${propEl.textContent.trim()}.`);
      return;
    }

    place(propEl, targetEl); // correct — the one real DOM move
    propEl.classList.add('is-correct');
    lockProp(propEl);
    announce(`Correct! ${propEl.textContent.trim()} placed in ${labelFor(targetEl)}.`);

    checkComplete();
  }

  function checkComplete() {
    if (!props.every((p) => p.classList.contains('is-correct'))) return;
    complete = true;
    root.classList.add('is-complete');
    announce(`Nice work — all ${props.length} matched correctly.`);
    root.dispatchEvent(new CustomEvent('ttlr:quizCompleted', {
      bubbles: true,
      detail: { total: props.length },
    }));
  }

  function resetAll() {
    complete = false;
    root.classList.remove('is-complete');
    props.forEach((p) => {
      const wasPlacedInZone = p.parentElement !== tray;
      p.classList.remove('is-correct', 'is-rejected', 'is-dragging');
      p.removeAttribute('aria-disabled');
      p.setAttribute('tabindex', '0');
      const action = interact(p);
      if (action) action.draggable(true);
      // Only move props that actually left the tray — leave the rest
      // untouched so resetting doesn't reshuffle props that never moved.
      if (wasPlacedInZone) place(p, tray);
      else resetTransform(p);
    });
    announce('Quiz reset. All answers returned to the tray.');
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', resetAll);
  }

  // ---- Pointer / touch drag: transform-only, never leaves the DOM ----
  props.forEach((propEl) => {
    propEl.setAttribute('tabindex', '0');
    propEl.setAttribute('role', 'button');
    propEl.setAttribute('aria-roledescription', 'Draggable answer');

    interact(propEl).draggable({
      inertia: false,
      autoScroll: true,
      listeners: {
        start(event) {
          if (complete) return;
          event.target.classList.add('is-dragging');
        },
        move(event) {
          if (complete) return;
          const el = event.target;
          const x = (parseFloat(el.getAttribute('data-x')) || 0) + event.dx;
          const y = (parseFloat(el.getAttribute('data-y')) || 0) + event.dy;
          el.style.transform = `translate(${x}px, ${y}px)`;
          el.setAttribute('data-x', x);
          el.setAttribute('data-y', y);
        },
        end(event) {
          const el = event.target;
          el.classList.remove('is-dragging');
          // Safety net regardless of drop/dragend firing order: if a
          // correct drop already handled + reset this, it's a no-op.
          // Otherwise this snaps it back to its resting spot — it was
          // never actually removed from the tray to begin with.
          if (!el.classList.contains('is-correct')) resetTransform(el);
        },
      },
    });
  });

  // ---- Dropzones (4 zone slots + tray) ----
  dropTargets.forEach((targetEl) => {
    interact(targetEl).dropzone({
      accept: '.ttlr_dragdrop_prop_item',
      // 'pointer' checks whether the cursor/touch point itself is inside the
      // target rect, rather than requiring the dragged element to cover a %
      // of the target's area (that was overlap: 0.4 — far too strict for a
      // small/thin .ttlr_dragdrop_drop-zone box, which is what was causing
      // correct drops to register as misses). Designer still needs the zone
      // to have real height/width — a genuinely 0-size target has no area
      // for the pointer to be "inside" either way.
      overlap: 'pointer',
      ondragenter(event) {
        event.target.classList.add('drop-hover');
      },
      ondragleave(event) {
        event.target.classList.remove('drop-hover');
      },
      ondrop(event) {
        event.target.classList.remove('drop-hover');
        handleDrop(event.relatedTarget, event.target);
      },
    });
  });

  // ---- Keyboard alternative: focus a prop, Enter to grab, Tab to a
  // zone, Enter to attempt a drop, Escape to cancel. Nothing moves in
  // the DOM here either until handleDrop confirms a correct placement. ----
  let grabbed = null;

  props.forEach((propEl) => {
    propEl.addEventListener('keydown', (evt) => {
      if (complete) return;
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        if (grabbed === propEl) {
          grabbed.classList.remove('is-grabbed');
          grabbed = null;
        } else {
          if (grabbed) grabbed.classList.remove('is-grabbed');
          grabbed = propEl;
          propEl.classList.add('is-grabbed');
          announce(`${propEl.textContent.trim()} picked up. Tab to a zone and press Enter to try it, or press Escape to cancel.`);
        }
      } else if (evt.key === 'Escape' && grabbed === propEl) {
        evt.preventDefault();
        grabbed.classList.remove('is-grabbed');
        announce(`${grabbed.textContent.trim()} placement cancelled.`);
        grabbed = null;
      }
    });
  });

  dropTargets.forEach((targetEl) => {
    targetEl.addEventListener('keydown', (evt) => {
      if (complete || !grabbed) return;
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        const propEl = grabbed;
        grabbed.classList.remove('is-grabbed');
        grabbed = null;
        handleDrop(propEl, targetEl);
      }
    });
  });

  function ensureLiveRegion(el) {
    let liveEl = el.querySelector('.ttlr_dragdrop_live');
    if (!liveEl) {
      liveEl = document.createElement('div');
      liveEl.className = 'ttlr_dragdrop_live';
      liveEl.setAttribute('aria-live', 'polite');
      liveEl.setAttribute('role', 'status');
      el.appendChild(liveEl);
    }
    return liveEl;
  }
}

/* ---- Notes pad: resizable, localStorage-backed notepad. Content is a
   single shared note (not per-page), so it's the same everywhere this
   Webflow component is placed — localStorage is already global per
   browser/domain, so no page-scoping is needed for that to work. ---- */

window.Webflow ||= [];
window.Webflow.push(function () {
  document.querySelectorAll('.notes_component_wrap').forEach(initNotesPad);
});

function initNotesPad(root) {
  const CONTENT_KEY = 'ttlr-notes-content';
  const WIDTH_KEY = 'ttlr-notes-width';
  const MIN_WIDTH = 280; // functional floor — narrower than this and the textarea stops being usable
  const VIEWPORT_MARGIN = 64; // keep the pad from ever fully covering the viewport

  const textarea = root.querySelector('.ttlr_notes_text-area');
  const dragLine = root.querySelector('.notes_drag_line');
  const form = root.querySelector('.ttlr_notes_form');
  const deleteBtn = root.querySelector('[data-notes-action="delete"]');
  const copyBtn = root.querySelector('[data-notes-action="copy"]');

  // Force a clean unarmed state on load, regardless of whether the static
  // Designer markup happens to already have .is-confirm on the delete
  // button (confirmed present in a live HTML dump) — without this, a single
  // click would immediately delete instead of arming the two-click confirm.
  if (deleteBtn?.classList.contains('is-confirm')) {
    console.warn('[ttlr] notes: delete button had .is-confirm already present on load — removing it. Check the Designer markup isn\'t shipping this class by default.');
    deleteBtn.classList.remove('is-confirm');
  }

  // This textarea lives inside a Webflow form component (for its built-in styling/
  // maxlength), but it's not meant to actually submit anywhere — guard against that.
  if (form) form.addEventListener('submit', (e) => e.preventDefault());

  function loadContent() {
    try {
      return window.localStorage.getItem(CONTENT_KEY) || '';
    } catch (err) {
      console.error('[ttlr] Failed to read notes from localStorage', err);
      return '';
    }
  }

  function saveContent(value) {
    try {
      window.localStorage.setItem(CONTENT_KEY, value);
    } catch (err) {
      console.error('[ttlr] Failed to save notes to localStorage', err);
    }
  }

  // If this component happens to appear more than once on the same page, keep every
  // instance's textarea showing the same content without moving anyone's caret/focus.
  function syncOtherInstances(value, exceptTextarea) {
    document.querySelectorAll('.ttlr_notes_text-area').forEach((el) => {
      if (el !== exceptTextarea && el.value !== value) el.value = value;
    });
  }

  if (textarea) {
    textarea.value = loadContent();
    textarea.addEventListener('input', () => {
      saveContent(textarea.value);
      syncOtherInstances(textarea.value, textarea);
    });
  }

  // ---- Copy: copies the note to the clipboard, flashes .notes_copy_success ----
  if (copyBtn) {
    // .notes_copy_success lives as a SIBLING of .notes_actions in Designer's
    // markup (not nested inside the copy button), so this searches the whole
    // component root rather than just copyBtn's own descendants.
    let successEl = root.querySelector('.notes_copy_success');
    console.log('[ttlr] notes: .notes_copy_success found in root?', !!successEl);
    if (!successEl) {
      // Fallback only if truly absent anywhere in this component — auto-created
      // so copy still gives feedback out of the box.
      successEl = document.createElement('div');
      successEl.className = 'notes_copy_success';
      successEl.textContent = 'Copied!';
      root.appendChild(successEl);
    }

    const successCloseBtn = successEl.querySelector('.notes_copy_close');
    if (successCloseBtn) {
      successCloseBtn.addEventListener('click', () => successEl.classList.remove('is-active'));
    }

    copyBtn.addEventListener('click', async () => {
      console.log('[ttlr] notes: copy clicked');
      if (!textarea) return;
      try {
        await navigator.clipboard.writeText(textarea.value);
        successEl.classList.add('is-active');
        window.setTimeout(() => successEl.classList.remove('is-active'), 2000);
      } catch (err) {
        console.error('[ttlr] Failed to copy notes to clipboard', err);
      }
    });
  }

  // The pad's own open/close state (is-open="true"/"false", toggled by a
  // separate script on [open-notes="btn"]) — used both to gate the
  // drag-resize width restore below and to reset the delete-confirm arm
  // state whenever the pad closes.
  function isOpen() {
    return root.getAttribute('is-open') === 'true';
  }

  // ---- Delete: first click arms .is-confirm, second click actually clears ----
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      console.log('[ttlr] notes: delete clicked, armed:', deleteBtn.classList.contains('is-confirm'));
      if (!deleteBtn.classList.contains('is-confirm')) {
        deleteBtn.classList.add('is-confirm');
        return;
      }
      if (textarea) textarea.value = '';
      saveContent('');
      syncOtherInstances('', textarea);
      deleteBtn.classList.remove('is-confirm');
    });
  }

  // ---- Drag line: resizes the pad by dragging its left edge ----
  // Assumes the pad is anchored to the right (drag_line sits before notes_pad in the
  // DOM, i.e. on its left edge), so dragging left grows it and dragging right shrinks
  // it. If the pad is actually anchored left, flip the sign in onPointerMove below.
  if (dragLine) {
    let startX = 0;
    let startWidth = 0;

    function onPointerMove(e) {
      const delta = e.clientX - startX;
      const maxWidth = window.innerWidth - VIEWPORT_MARGIN;
      const nextWidth = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth - delta));
      root.style.width = `${nextWidth}px`;
    }

    function onPointerUp() {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.documentElement.classList.remove('ttlr-is-resizing');
      try {
        window.localStorage.setItem(WIDTH_KEY, root.style.width);
      } catch (err) {
        console.error('[ttlr] Failed to save notes pad width to localStorage', err);
      }
    }

    dragLine.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
      startWidth = root.getBoundingClientRect().width;
      document.documentElement.classList.add('ttlr-is-resizing'); // suppress text selection while dragging
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    });

    // A remembered drag width always loses to the pad's own closed state —
    // see the shared is-open observer below, set up regardless of whether
    // dragLine exists.
    function applySavedWidthIfOpen() {
      if (!isOpen()) return;
      try {
        const savedWidth = window.localStorage.getItem(WIDTH_KEY);
        if (savedWidth) root.style.width = savedWidth;
      } catch (err) {
        console.error('[ttlr] Failed to read notes pad width from localStorage', err);
      }
    }

    applySavedWidthIfOpen();
  }

  // Watches is-open regardless of what else changes it (jQuery/GSAP toggle,
  // dev tools, anything) and regardless of whether dragLine/deleteBtn exist —
  // the moment it's not "true": clears our own inline width so nothing we've
  // set can hold the pad open past a close action, AND resets the delete
  // button's confirm-arm state, so reopening the pad after closing it mid-arm
  // (armed, then closed without confirming) always starts fresh.
  new MutationObserver(() => {
    if (isOpen()) return;
    root.style.width = '';
    if (deleteBtn?.classList.contains('is-confirm')) deleteBtn.classList.remove('is-confirm');
  }).observe(root, { attributes: true, attributeFilter: ['is-open'] });
}

/* ---- Series navigation: Next/Previous Series buttons. Same mechanism as
   the Refokus "CMS Prev/Next" tool (replicated natively here rather than
   loading their script, to stay dependency-free like the rest of this
   project): a hidden Collection List bound to the Series collection, in
   whatever order you want navigation to follow, is used purely as a lookup
   table — match the current page's URL against each item's own link to find
   its position, then Next/Prev just point at the adjacent item's link.
   Setup instructions were given directly in chat, not documented in the
   README (by request) — ask if you need them again. ---- */

window.Webflow ||= [];
window.Webflow.push(function () {
  document.querySelectorAll('[data-series-nav="source"]').forEach(initSeriesNav);
});

function initSeriesNav(sourceEl) {
  const itemEls = Array.from(sourceEl.querySelectorAll('.w-dyn-item'));
  console.log('[ttlr] series nav: found ' + itemEls.length + ' item(s) in [data-series-nav="source"]');
  if (!itemEls.length) return;

  const items = itemEls
    .map((itemEl, i) => {
      const link = itemEl.tagName === 'A' ? itemEl : itemEl.querySelector('a[href]');
      if (!link) {
        console.warn('[ttlr] series nav: item ' + i + ' in [data-series-nav="source"] has no <a href> (itself or a descendant) — skipping it. Its markup:', itemEl.outerHTML);
        return null;
      }
      // number/name are read from dedicated [data-series-nav-field="..."]
      // elements inside the item, since a single link's combined text can't
      // be split back into separate pieces — text/img stay as whole-link
      // fallbacks for anyone who doesn't need them split out.
      return {
        href: link.href,
        text: link.textContent.trim(),
        number: itemEl.querySelector('[data-series-nav-field="number"]')?.textContent.trim() || '',
        name: itemEl.querySelector('[data-series-nav-field="name"]')?.textContent.trim() || '',
        imgSrc: itemEl.querySelector('[data-series-nav-field="img"]')?.src
          || link.querySelector('img')?.src
          || itemEl.querySelector('img')?.src
          || '',
      };
    })
    .filter(Boolean);
  console.log('[ttlr] series nav: extracted items ->', items);

  const currentPath = window.location.pathname.replace(/\/$/, '');
  const currentIndex = items.findIndex((item) => new URL(item.href).pathname.replace(/\/$/, '') === currentPath);
  console.log('[ttlr] series nav: current page matched at index ' + currentIndex + ' of ' + items.length);
  if (currentIndex === -1) {
    console.warn('[ttlr] series nav: current page URL did not match any item in [data-series-nav="source"] — check the hidden list includes every series and each links to its own real, published page.');
  }

  const nextItem = currentIndex !== -1 ? items[currentIndex + 1] || null : null;
  const prevItem = currentIndex !== -1 ? items[currentIndex - 1] || null : null;

  function wireNavButton(direction, item) {
    // Optional: an outer wrapper around the whole next/prev block (label,
    // thumbnail, button — everything), fully hidden when there's genuinely
    // no next/prev series (e.g. the last series in the list has no "next").
    // Without this, the button/text/img fields above still exist but are
    // blank/disabled, which can look broken (empty image, an inert-looking
    // but still-visible button) rather than the block just not being there.
    // Opt-in — if this attribute isn't added in Designer, behavior is
    // unchanged from before.
    document.querySelectorAll(`[data-series-nav="${direction}-wrap"]`).forEach((el) => {
      el.style.display = item ? '' : 'none';
    });

    document.querySelectorAll(`[data-series-nav="${direction}-btn"]`).forEach((btn) => {
      if (!item) {
        btn.classList.add('is-disabled');
        btn.setAttribute('aria-disabled', 'true');
        if (btn.tagName === 'A') btn.removeAttribute('href');
        return;
      }
      btn.classList.remove('is-disabled');
      btn.setAttribute('aria-disabled', 'false');
      if (btn.tagName === 'A') {
        btn.href = item.href; // native navigation — no JS needed beyond this
      } else {
        btn.addEventListener('click', () => { window.location.href = item.href; });
      }
    });
  }

  function fillNavContent(direction, item) {
    document.querySelectorAll(`[data-series-nav="${direction}-text"]`).forEach((el) => {
      el.textContent = item ? item.text : '';
    });
    document.querySelectorAll(`[data-series-nav="${direction}-number"]`).forEach((el) => {
      el.textContent = item ? item.number : '';
    });
    document.querySelectorAll(`[data-series-nav="${direction}-name"]`).forEach((el) => {
      el.textContent = item ? item.name : '';
    });
    document.querySelectorAll(`[data-series-nav="${direction}-img"]`).forEach((el) => {
      if (item && item.imgSrc) el.src = item.imgSrc;
    });
  }

  wireNavButton('next', nextItem);
  wireNavButton('prev', prevItem);
  fillNavContent('next', nextItem);
  fillNavContent('prev', prevItem);
}

/* ---- Series swiper: landing/hero page series carousel (Swiper.js).
   Swiper's own bundled CSS is deliberately NOT loaded (see sky-ttlr.css for
   the small amount of structural CSS used instead) — its default stylesheet
   would apply its own positioning and arrow-glyph styling to
   .swiper-button-prev/-next, which here are plain custom elements with
   their own SVG icons and Designer's own layout. Skipping it keeps that
   entirely Designer's, at the cost of relying on Swiper's JS to handle
   slide sizing/transform via inline styles at runtime (which it does
   regardless of whether its CSS is loaded). ---- */

window.Webflow ||= [];
window.Webflow.push(function () {
  if (typeof Swiper === 'undefined') {
    console.warn('[ttlr] series swiper: Swiper is not loaded — check its <script> tag is present and loads before this file.');
    return;
  }
  document.querySelectorAll('.ttlr_cms_series-wrapper').forEach(initSeriesSwiper);
});

function initSeriesSwiper(root) {
  // Nav buttons are siblings of the swiper container (not descendants), so
  // scope the lookup to the shared parent first; fall back to a page-wide
  // lookup only if that fails.
  const scope = root.parentElement || document;
  const nextEl = scope.querySelector('.swiper-button-next') || document.querySelector('.swiper-button-next');
  const prevEl = scope.querySelector('.swiper-button-prev') || document.querySelector('.swiper-button-prev');
  console.log('[ttlr] series swiper: initializing', root, '/ next', nextEl, '/ prev', prevEl);

  // slidesPerView: 'auto' uses each .ttlr_cms_series-item's own CSS width —
  // that width needs to be set explicitly in Designer for this to size
  // correctly (unlike a fixed slidesPerView number, which doesn't need it).
  new Swiper(root, {
    slidesPerView: 3,
    spaceBetween: 20,
    navigation: {
      nextEl,
      prevEl,
    },
  });
}

/* ---- Series cards: per-series completion badge on the home page carousel
   cards ("3/5" or "COMPLETED"), rolled up from the SAME ttl-progress Custom
   Field the episode router writes .series[seriesId].completedCount/total/
   completed into on every markComplete() call (see initEpisodeRouter above)
   — nothing series-specific is computed here, this just reads that rollup.
   Local-first like everything else: paints from localStorage instantly,
   then re-renders once Memberstack hydrates in the background. ---- */

window.Webflow ||= [];
window.Webflow.push(function () {
  // data-series-id lives on .ttlr_badge (inside .ttlr_completion_tag-wrap),
  // NOT on .ttlr_series_card-wrap itself — confirmed via a live HTML dump
  // 2026-08-27 (an earlier version of this assumed the wrong element and
  // never matched anything on the live page).
  const badges = document.querySelectorAll('.ttlr_badge[data-series-id]');
  console.log('[ttlr] series card: found ' + badges.length + ' .ttlr_badge[data-series-id] element(s)');
  badges.forEach(initSeriesCard);
});

function initSeriesCard(badgeEl) {
  const PROGRESS_FIELD = 'ttl-progress';
  const PROGRESS_LOCAL_KEY = 'ttlr-progress-local';

  const seriesId = badgeEl.dataset.seriesId;
  // .ttlr_completion_tag-wrap is what actually gets hidden entirely for a
  // not-yet-started series — .ttlr_badge is just the pill inside it.
  const wrapEl = badgeEl.closest('.ttlr_completion_tag-wrap') || badgeEl;
  const textEl = badgeEl.querySelector('div') || badgeEl;
  // Optional mini fill bar on the card thumbnail — a sibling of this badge
  // inside the same .ttlr_series_card-wrap, not a descendant of it.
  const cardEl = badgeEl.closest('.ttlr_series_card-wrap');
  const fillEl = cardEl?.querySelector('.ttlr_series_card-inner');
  console.log('[ttlr] initSeriesCard: seriesId', seriesId, '/ wrap', wrapEl, '/ text el', textEl, '/ fill el', fillEl);

  function render(seriesProgress) {
    const entry = seriesProgress?.[seriesId];
    // Not started yet (no entry at all, or zero episodes completed) — hide
    // the badge entirely rather than showing Designer's static "Completed"
    // placeholder or a misleading "0/5".
    if (!entry || !entry.completedCount) {
      wrapEl.style.display = 'none';
      return;
    }
    wrapEl.style.display = '';
    textEl.textContent = entry.completed ? 'Completed' : `${entry.completedCount}/${entry.total}`;
    cardEl?.classList.toggle('is-completed', !!entry.completed);
    if (fillEl && entry.total) fillEl.style.width = `${Math.min(100, (entry.completedCount / entry.total) * 100)}%`;
  }

  let local = {};
  try {
    local = JSON.parse(window.localStorage.getItem(PROGRESS_LOCAL_KEY)) || {};
  } catch (err) {
    console.error('[ttlr] initSeriesCard: failed to read local progress cache', err);
  }
  render(local.series);

  waitForMemberstack().then(async (ms) => {
    if (!ms) return;
    try {
      const { data: member } = await ms.getCurrentMember();
      if (!member) return;
      const raw = member.customFields?.[PROGRESS_FIELD];
      if (!raw) return;
      const remote = JSON.parse(raw);
      render(remote.series);
    } catch (err) {
      console.error('[ttlr] initSeriesCard: failed to read remote progress', err);
    }
  });
}

/* ---- Series count label: #series-number shows how many series are in the
   CMS-bound list — content data (how many Series items exist here), not
   member progress, so this is independent of ttl-progress/localStorage and
   just counts whatever's actually rendered in .ttlr_cms_series-wrapper.
   Independent of Swiper too (doesn't require it to have loaded/initialized). ---- */

window.Webflow ||= [];
window.Webflow.push(function () {
  const labelEl = document.querySelector('#series-number');
  const listEl = document.querySelector('.ttlr_cms_series-wrapper');
  console.log('[ttlr] series count label: #series-number', labelEl, '/ .ttlr_cms_series-wrapper', listEl);
  if (!labelEl || !listEl) return;

  const count = listEl.querySelectorAll('.ttlr_cms_series-item').length;
  if (!count) {
    labelEl.style.display = 'none';
    return;
  }
  const textEl = labelEl.querySelector('div') || labelEl;
  textEl.textContent = `${count} Series`;
  console.log('[ttlr] series count label: found ' + count + ' .ttlr_cms_series-item — wrote "' + textEl.textContent + '"');
});
