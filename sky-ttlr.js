/*
  Sky TTLR — Custom Code (behavior)
  Prepared by MakeBuild

  Requires interact.js to be loaded separately before this file for the
  drag & drop quiz section — see README for the required <script> tag.
*/

/* ---- Episode router: one visible episode at a time, Prev/Next
   navigation, completion tracking in Memberstack. ---- */

window.Webflow ||= [];
window.Webflow.push(function () {
  document.querySelectorAll('.ttlr_episode_cms_list').forEach(initEpisodeRouter);
});

function initEpisodeRouter(listEl) {
  const items = Array.from(listEl.querySelectorAll('.ttlr_episode_cms_item'));
  if (!items.length) return;

  let currentIndex = 0;

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

  async function markComplete(episodeId) {
    if (!episodeId || !window.$memberstackDom) return;
    try {
      const { data: member } = await window.$memberstackDom.getCurrentMember();
      if (!member) return; // not logged in — nothing to persist to

      let current = {};
      const raw = member.customFields?.[PROGRESS_FIELD];
      if (raw) {
        try {
          current = JSON.parse(raw);
        } catch (parseErr) {
          console.error('[ttlr] Could not parse existing ' + PROGRESS_FIELD + ', starting fresh', parseErr);
        }
      }
      current.episodes = current.episodes || {};

      if (current.episodes[episodeId]?.completed) return; // already done, no write needed

      current.episodes[episodeId] = {
        ...(current.episodes[episodeId] || {}),
        completed: true,
        completedAt: new Date().toISOString(),
      };

      // ---- Roll up to series-level completion (this drives the badge) ----
      // Complete once every episode currently rendered in THIS series' own
      // list is marked complete. They all belong to the same series (see
      // resolveSeriesId above), so this is just a check against ids already
      // on the page — no extra fetch needed.
      if (seriesId) {
        current.series = current.series || {};
        const allComplete = items.every((item, i) => current.episodes[idOf(item, i)]?.completed);
        if (allComplete && !current.series[seriesId]?.completed) {
          current.series[seriesId] = {
            completed: true,
            completedAt: new Date().toISOString(),
          };
        }
      }

      await window.$memberstackDom.updateMember({
        customFields: { [PROGRESS_FIELD]: JSON.stringify(current) },
      });

      updateProgressDisplay(current.episodes);
    } catch (err) {
      console.error('[ttlr] Failed to save episode completion to Memberstack', err);
    }
  }

  // ---- Progress bar: global (one per page, not per-episode) completed/total
  // display for this series. The CMS-bound .ttlr_progress_segment items are a
  // purely visual mask over .ttlr_progress_fill (see sky-ttlr.css) — they don't
  // need to match the episode count, so this only ever needs a fill percentage.
  const progressFill = document.querySelector('.ttlr_progress_fill');
  const progressP = document.querySelector('.ttlr_episode_progress_p');

  function updateProgressDisplay(episodesProgress) {
    const total = items.length;
    const completed = items.filter((item, i) => episodesProgress?.[idOf(item, i)]?.completed).length;

    if (progressFill) {
      progressFill.style.width = `${total ? (completed / total) * 100 : 0}%`;
    }

    // Structure is <span>completed</span><span>/</span><span>total</span><span class="...">COMPLETED</span>
    // — no distinguishing attribute on the count spans, so this relies on position.
    if (progressP) {
      const counts = progressP.children;
      if (counts[0]) counts[0].textContent = String(completed);
      if (counts[2]) counts[2].textContent = String(total);
    }
  }

  if (window.$memberstackDom) {
    window.$memberstackDom.getCurrentMember()
      .then(({ data: member }) => {
        const raw = member?.customFields?.[PROGRESS_FIELD];
        if (!raw) return;
        try {
          updateProgressDisplay(JSON.parse(raw).episodes);
        } catch (parseErr) {
          console.error('[ttlr] Could not parse existing ' + PROGRESS_FIELD + ' for progress bar', parseErr);
        }
      })
      .catch((err) => {
        console.error('[ttlr] Failed to read progress for progress bar', err);
      });
  }

  // ---- Series-end success screen: shown when "Finish Series" is clicked on
  // the last episode (see updateButtonStates / the click-wiring loop below).
  const seriesEndSuccessEl = document.querySelector('.ttlr_series-end_success');
  function showSeriesEndSuccess() {
    if (seriesEndSuccessEl) seriesEndSuccessEl.classList.add('is-active');
  }

  // ---- Bookmarks: one global button (not per-episode) that bookmarks whichever
  // episode is currently displayed. Read/write in the ttl-bookmarks Custom Field —
  // kept separate from ttl-progress above so a bookmark toggle and a completion
  // write never contend over the same field's read-modify-write cycle.
  const BOOKMARKS_FIELD = 'ttl-bookmarks';
  const bookmarkBtn = document.querySelector('[bookmark="btn"]');

  // The provided icon is a single path drawn with two subpaths + evenodd fill, which
  // renders as a hollow/outline ribbon (the second subpath is the outer boundary, the
  // first carves out the inner hole). Dropping the first subpath leaves just the outer
  // boundary as an ordinary filled shape — the "bookmarked" solid version of the icon.
  const BOOKMARK_OUTLINE_D = 'M6.10982 14.7059C6.48066 14.3969 7.01934 14.3969 7.39018 14.7059L12 18.5474V1.5H1.5V18.5474L6.10982 14.7059ZM6.75 16.125L12.2699 20.7249C12.7584 21.132 13.5 20.7846 13.5 20.1487V0.75C13.5 0.335786 13.1642 0 12.75 0H0.75C0.335786 0 0 0.335787 0 0.750001V20.1487C0 20.7846 0.741645 21.132 1.23014 20.7249L6.75 16.125Z';
  const BOOKMARK_SOLID_D = 'M6.75 16.125L12.2699 20.7249C12.7584 21.132 13.5 20.7846 13.5 20.1487V0.75C13.5 0.335786 13.1642 0 12.75 0H0.75C0.335786 0 0 0.335787 0 0.750001V20.1487C0 20.7846 0.741645 21.132 1.23014 20.7249L6.75 16.125Z';

  function setBookmarkVisual(isBookmarked) {
    if (!bookmarkBtn) return;
    const path = bookmarkBtn.querySelector('svg path');
    if (path) path.setAttribute('d', isBookmarked ? BOOKMARK_SOLID_D : BOOKMARK_OUTLINE_D);
    bookmarkBtn.classList.toggle('is-bookmarked', isBookmarked);
    bookmarkBtn.setAttribute('aria-pressed', String(isBookmarked));
  }

  // In-memory cache of bookmarked ids, populated once on load and kept in sync locally
  // on every toggle — avoids a Memberstack read on every episode navigation just to
  // know whether the newly-shown episode is bookmarked.
  let bookmarksCache = [];

  async function loadBookmarks() {
    if (!window.$memberstackDom) return [];
    try {
      const { data: member } = await window.$memberstackDom.getCurrentMember();
      if (!member) return [];
      const raw = member.customFields?.[BOOKMARKS_FIELD];
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (parseErr) {
        console.error('[ttlr] Could not parse existing ' + BOOKMARKS_FIELD + ', starting fresh', parseErr);
        return [];
      }
    } catch (err) {
      console.error('[ttlr] Failed to read bookmarks from Memberstack', err);
      return [];
    }
  }

  if (bookmarkBtn) {
    loadBookmarks().then((bookmarks) => {
      bookmarksCache = bookmarks;
      setBookmarkVisual(bookmarksCache.includes(idOf(items[currentIndex], currentIndex)));
    });

    bookmarkBtn.addEventListener('click', async () => {
      if (!window.$memberstackDom || bookmarkBtn.dataset.pending === 'true') return;
      bookmarkBtn.dataset.pending = 'true';
      try {
        const episodeId = idOf(items[currentIndex], currentIndex);
        const { data: member } = await window.$memberstackDom.getCurrentMember();
        if (!member) return; // not logged in — nothing to persist to

        const bookmarks = await loadBookmarks(); // re-read in case another tab changed it
        const isBookmarked = bookmarks.includes(episodeId);
        const next = isBookmarked
          ? bookmarks.filter((id) => id !== episodeId)
          : [...bookmarks, episodeId];

        await window.$memberstackDom.updateMember({
          customFields: { [BOOKMARKS_FIELD]: JSON.stringify(next) },
        });

        bookmarksCache = next;
        setBookmarkVisual(!isBookmarked);
      } catch (err) {
        console.error('[ttlr] Failed to save bookmark to Memberstack', err);
      } finally {
        bookmarkBtn.dataset.pending = 'false';
      }
    });
  }

  // ---- Show exactly one item; sync the URL; update button states ----
  function show(index) {
    currentIndex = index;

    items.forEach((item, i) => {
      item.style.display = i === index ? '' : 'none';
    });

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

  // Marks the episode being LEFT as complete, in both directions —
  // additive only, so navigating back with Prev never un-marks anything.
  function goTo(targetIndex, fromIndex) {
    if (targetIndex < 0 || targetIndex >= items.length) return;
    markComplete(idOf(items[fromIndex], fromIndex));
    show(targetIndex);
  }

  items.forEach((item, index) => {
    const prevBtn = item.querySelector('.ttlr_episode_button.is-prev');
    const nextBtn = item.querySelector('.ttlr_episode_button.is-next');
    if (prevBtn) prevBtn.addEventListener('click', () => goTo(index - 1, index));
    if (nextBtn) {
      const isLast = index === items.length - 1;
      nextBtn.addEventListener('click', () => {
        if (isLast) {
          // goTo's own bounds check would silently no-op here (targetIndex
          // out of range) without ever calling markComplete — that was the
          // actual cause of the last episode never getting marked complete.
          markComplete(idOf(item, index));
          showSeriesEndSuccess();
        } else {
          goTo(index + 1, index);
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
  if (typeof interact === 'undefined') return; // interact.js failed to load — fail quietly rather than throw
  document.querySelectorAll('.ttlr_dragdrop_wrap').forEach(initTtlrDragDrop);
});

function initTtlrDragDrop(root) {
  const tray = root.querySelector('.ttlr_dragdrop_props_wrap');
  const props = Array.from(root.querySelectorAll('.ttlr_dragdrop_prop_item[data-correct-zone]'));
  const resetBtn = root.querySelector('.ttlr_dragdrop_reset');
  const live = ensureLiveRegion(root);

  if (!tray || !props.length) return;

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
      overlap: 0.4,
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
    let successEl = copyBtn.querySelector('.notes_copy_success');
    if (!successEl) {
      // Not present in the Designer markup as of writing — auto-created so copy still
      // gives feedback out of the box. Add your own .notes_copy_success element (and
      // restyle/reword this one) in Designer any time; the script only toggles .is-active.
      successEl = document.createElement('div');
      successEl.className = 'notes_copy_success';
      successEl.textContent = 'Copied!';
      copyBtn.appendChild(successEl);
    }

    copyBtn.addEventListener('click', async () => {
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

  // ---- Delete: first click arms .is-confirm, second click actually clears ----
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
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

    try {
      const savedWidth = window.localStorage.getItem(WIDTH_KEY);
      if (savedWidth) root.style.width = savedWidth;
    } catch (err) {
      console.error('[ttlr] Failed to read notes pad width from localStorage', err);
    }
  }
}
