/*
 * repo-backend-v2 dashboard glue.
 *
 * Browser already attaches our httpOnly session cookie to every request
 * — no API-key dance like the legacy v2 did. This file just handles:
 *
 *   1. 401 responses: redirect to login via HX-Redirect or location.
 *   2. Toast notifications: server emits HX-Trigger: { toast: {...} }
 *      and we render it into #toast-stack.
 *   3. Confirm modal: replaces native confirm() for hx-confirm prompts,
 *      so we can theme it (Bootstrap modal) and customize per-action.
 *   4. Indicator class management for live-search inputs.
 */
(function () {
    'use strict';

    if (typeof window.htmx === 'undefined') {
        /*
         * Should not happen — layout.ejs loads htmx via CDN. But fail
         * loud if it does.
         */
        console.error('htmx not loaded; dashboard.js can not initialize');
        return;
    }

    /*
     * Read the dashboard base path from <body data-dashboard-base="...">.
     * Avoids needing an inline <script> in the layout (CSP-friendly).
     */
    const DASHBOARD_BASE =
        (document.body && document.body.dataset && document.body.dataset.dashboardBase) ||
        '/repo/dashboard';

    /*
     * ---- 1. 401 handling ----
     * The dashboard auth middleware sets HX-Redirect on a 401. htmx
     * follows it automatically; this handler is the fallback for
     * legitimate API calls that bypass that middleware.
     */
    document.body.addEventListener('htmx:responseError', function (evt) {
        const xhr = evt.detail.xhr;
        if (xhr && xhr.status === 401) {
            const redirect = xhr.getResponseHeader('HX-Redirect');
            if (redirect) {
                window.location.assign(redirect);
            } else {
                window.location.assign(DASHBOARD_BASE + '/login');
            }
        }
    });

    /*
     * ---- 2. Toast notifications ----
     * Server-emitted HX-Trigger header carries JSON like
     *   { "toast": { "level": "success", "message": "Published." } }
     * htmx fires a 'toast' event with detail = the inner object.
     */
    document.body.addEventListener('toast', function (evt) {
        show_toast(evt.detail || {});
    });

    /*
     * Long-running actions (batch halt / batch rollback loop over up
     * to ~100 rows with per-row curation calls) — surface immediate
     * feedback the moment the request FIRES, so staff aren't staring
     * at a silent page wondering whether the click took. Any element
     * can opt in with data-busy-message="...".
     */
    document.body.addEventListener('htmx:beforeRequest', function (evt) {
        const src = evt.detail && evt.detail.elt;
        const msg = src && src.getAttribute && src.getAttribute('data-busy-message');
        if (msg) show_toast({ level: 'info', message: msg });
    });

    function show_toast(opts) {
        let stack = document.getElementById('toast-stack');
        if (!stack) {
            stack = document.createElement('div');
            stack.id = 'toast-stack';
            stack.className = 'toast-stack';
            document.body.appendChild(stack);
        }
        const level = (opts.level || 'info').toLowerCase();
        const message = String(opts.message || 'OK');

        // Map our severity tokens to Bootstrap alert variants.
        const variant =
            {
                success: 'alert-success',
                info: 'alert-info',
                warn: 'alert-warning',
                warning: 'alert-warning',
                error: 'alert-danger',
                fatal: 'alert-danger',
            }[level] || 'alert-info';

        const div = document.createElement('div');
        div.className = 'alert alert-dismissible fade show ' + variant;
        div.setAttribute('role', 'alert');
        // textContent — keeps server-supplied strings from injecting HTML
        const span = document.createElement('span');
        span.textContent = message;
        div.appendChild(span);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn-close';
        close.setAttribute('data-bs-dismiss', 'alert');
        close.setAttribute('aria-label', 'Close');
        div.appendChild(close);

        stack.appendChild(div);
        setTimeout(function () {
            div.classList.remove('show');
            setTimeout(function () {
                if (div.parentNode) div.parentNode.removeChild(div);
            }, 200);
        }, 5000);
    }

    // Expose for inline test hooks if needed
    window.dashboard_show_toast = show_toast;

    /*
     * ---- 3. Confirm modal ----
     * We DON'T use htmx's hx-confirm — that fires window.confirm() as a
     * fallback path, which produced a stacked native dialog + styled
     * modal during the metadata refresh work (htmx 1.9.12 behavior).
     * 
     * Instead we use a custom attribute `data-confirm` and intercept
     * the click at the capture phase, BEFORE htmx sees it. The styled
     * modal opens; on OK we set a one-shot sentinel on the element and
     * re-fire the click programmatically. The capture listener sees
     * the sentinel and lets the click through to htmx. htmx never sees
     * an hx-confirm attribute, so it never calls window.confirm.
     * 
     * Element contract:
     *   data-confirm="<message body>"     required
     *   data-confirm-title="<title>"      optional (default: "Confirm")
     *   data-confirm-label="<button>"     optional (default: "Confirm")
     * 
     * Side benefit: the same pattern works for non-htmx elements (e.g.
     * a plain <a href>) — we just call elt.click() and the browser
     * does whatever it would normally do.
     */
    document.body.addEventListener(
        'click',
        function (evt) {
            const elt = evt.target.closest && evt.target.closest('[data-confirm]');
            if (!elt) return;
            /*
             * Sentinel: if we just programmatically re-fired this
             * click after a confirm, let it through. The sentinel is
             * single-use — cleared on entry so a real subsequent
             * user-initiated click still gets confirmed.
             */
            if (elt.__confirmed) {
                elt.__confirmed = false;
                return;
            }
            /*
             * Block htmx (and any other handler) from seeing this
             * particular click — stopImmediatePropagation also prevents
             * other capture-phase listeners on document.body, but our
             * own listener already had its turn so that's fine.
             */
            evt.preventDefault();
            evt.stopImmediatePropagation();
            evt.stopPropagation();

            const question = elt.getAttribute('data-confirm') || '';
            const title = elt.getAttribute('data-confirm-title') || 'Confirm';
            const label = elt.getAttribute('data-confirm-label') || 'Confirm';

            const modal_el = document.getElementById('confirm-modal');
            /*
             * Defensive fallback: no styled modal in the DOM, or
             * Bootstrap not loaded. Use the native confirm and bypass
             * re-interception on yes.
             */
            if (!modal_el || !window.bootstrap) {
                if (window.confirm(question)) {
                    elt.__confirmed = true;
                    elt.click();
                }
                return;
            }

            modal_el.querySelector('#confirm-modal-title').textContent = title;
            modal_el.querySelector('#confirm-modal-message').textContent = question;
            const proceed = modal_el.querySelector('#confirm-modal-proceed');
            proceed.textContent = label;
            /*
             * Tint the proceed button red for destructive labels.
             * Heuristic: any label containing "delete" or "remove".
             */
            const is_destructive = /delete|remove|cancel batch/i.test(label);
            proceed.className = 'btn ' + (is_destructive ? 'btn-danger' : 'btn-primary');

            const bs_modal = window.bootstrap.Modal.getOrCreateInstance(modal_el);

            /*
             * Pause htmx polling while the confirm modal is open.
             * Without this, a 2s-interval poller targeting the same
             * region the click came FROM (e.g. the metadata-refresh
             * admin page where Start/Cancel live inside the polled
             * status partial) can swap the DOM mid-confirm — `elt`
             * becomes detached and the proceed-click does nothing.
             * 
             * We use our own body class (not Bootstrap's .modal-open)
             * because Bootstrap adds .modal-open ASYNCHRONOUSLY after
             * the show transition begins — too late to win the race
             * against the next polling tick. Our class is set
             * synchronously here, and the polled element's
             * hx-trigger filter checks for it on every tick.
             */
            document.body.classList.add('htmx-confirm-pending');

            /*
             * Replace the onclick each time (not addEventListener) so
             * we never accumulate stale closures pointing at old
             * elements. Bootstrap's modal handles its own backdrop
             * click + escape key, so cancel needs no wiring here.
             */
            proceed.onclick = function () {
                bs_modal.hide();
                document.body.classList.remove('htmx-confirm-pending');
                elt.__confirmed = true;
                elt.click();
            };
            /*
             * Belt-and-braces: clear the flag whenever the modal
             * closes (proceed, cancel, escape, backdrop). One-shot
             * listener so we don't accumulate handlers.
             */
            modal_el.addEventListener('hidden.bs.modal', function on_hide() {
                document.body.classList.remove('htmx-confirm-pending');
                modal_el.removeEventListener('hidden.bs.modal', on_hide);
            });

            /*
             * Remember the trigger so the dedicated focus-management
             * handler (section 5a) can return focus there when the
             * modal closes via cancel / Escape / backdrop / proceed.
             */
            _capture_modal_trigger(modal_el, elt);

            bs_modal.show();
        },
        true // capture phase — runs before htmx's bubble-phase handlers
    );

    /*
     * ---- 3a. Pause htmx polling while a confirm modal is open ----
     * 
     * Why this exists: the system-refresh admin page (and any other
     * page that puts an action button INSIDE an `hx-trigger="every Ns"`
     * polled region) has a race — the polling tick fires mid-confirm,
     * swaps the partial, detaches the button DOM. The proceed-click
     * then lands on an orphan and does nothing.
     * 
     * Why we can't use hx-trigger's "[filter]" syntax: htmx evaluates
     * those filters with `new Function()`, which our CSP correctly
     * forbids (no 'unsafe-eval'). So we gate from JS instead.
     * 
     * What we cancel: ONLY polling requests — identified by the
     * source element having `every` in its hx-trigger attribute.
     * Click/submit/load-triggered requests pass through untouched.
     * We never want to block a user-initiated request just because
     * a modal is open.
     */
    document.body.addEventListener('htmx:beforeRequest', function (evt) {
        if (!document.body.classList.contains('htmx-confirm-pending')) return;
        const src = evt.detail && evt.detail.elt;
        if (!src) return;
        const trigger = src.getAttribute('hx-trigger');
        /*
         * Polling triggers use the htmx `every <interval>` keyword.
         * Word-boundary match so `every2s` (typo) or `everyone` don't
         * false-positive, and a substring like `evening` doesn't either.
         */
        if (trigger && /\bevery\b/.test(trigger)) {
            evt.preventDefault();
        }
    });

    /*
     * ---- 4. Modal auto-open ----
     * Any partial swapped into #modal-content (the inside of the
     * generic #modal-mount in the layout) auto-opens the modal. Routes
     * that return a modal-shaped fragment just need to target
     * #modal-content — no extra JS per page.
     */
    document.body.addEventListener('htmx:afterSwap', function (evt) {
        const target = evt.detail.target;
        if (!target || target.id !== 'modal-content') return;
        const modal_el = document.getElementById('modal-mount');
        if (modal_el && window.bootstrap) {
            window.bootstrap.Modal.getOrCreateInstance(modal_el).show();
        }
    });

    /*
     * ---- 5. Modal close-on-server-event ----
     * The thumbnail upload returns its swapped row to the row target
     * (not the modal), so we need a separate signal to dismiss the
     * open modal. Server emits HX-Trigger: { "modal:close": {} } and
     * we hide whatever modal is currently open.
     */
    document.body.addEventListener('modal:close', function () {
        const modal_el = document.getElementById('modal-mount');
        if (!modal_el || !window.bootstrap) return;
        const instance = window.bootstrap.Modal.getInstance(modal_el);
        if (instance) instance.hide();
    });

    /*
     * ---- 5a. Modal focus management (WCAG 2.4.3) ----
     * 
     * Bootstrap 5 moves focus to the modal *element* on show and
     * attempts to restore focus to the previously-focused element on
     * hide. That default has two gaps in our HTMX flow:
     * 
     *   1. Keyboard users land on the modal container itself and must
     *      Tab once before any interactive element gets focus. We move
     *      focus to the first usable control instead so they can act
     *      immediately.
     * 
     *   2. "Previously focused" is whatever had :focus when show() ran.
     *      Our click handlers and HTMX requests can shift focus before
     *      that point (e.g. confirm-modal preventDefaults the click;
     *      htmx fires async; a row swap may detach the original click
     *      target). Capturing the trigger explicitly is more reliable.
     * 
     * Applies to both #modal-mount (HTMX-swapped content) and
     * #confirm-modal (intercepted-click confirmation). Per-modal state
     * lives in a WeakMap keyed by the modal element so multiple
     * modals can have independent triggers without leaking memory.
     */
    const _modal_triggers = new WeakMap();

    function _capture_modal_trigger(modal_el, trigger) {
        if (!modal_el) return;
        /*
         * Walk to the nearest focusable ancestor so we don't try to
         * focus an inner SVG path. Falls back to the raw element so
         * a non-focusable trigger doesn't error out — focus() on it
         * is a no-op in that case.
         */
        const focusable =
            trigger && typeof trigger.closest === 'function'
                ? trigger.closest('button, a[href], [tabindex]') || trigger
                : trigger;
        _modal_triggers.set(modal_el, focusable);
    }

    function _focus_first_in_modal(modal_el) {
        if (!modal_el) return;
        /*
         * Prefer the first non-dismiss control so keyboard users can
         * act on the modal's primary affordance immediately. If the
         * modal has nothing but a close button (e.g. a metadata view),
         * focus that — at least focus is inside the dialog.
         */
        const primary = modal_el.querySelector(
            'input:not([disabled]):not([type="hidden"]),' +
                ' select:not([disabled]),' +
                ' textarea:not([disabled]),' +
                ' button:not([disabled]):not(.btn-close):not([data-bs-dismiss]),' +
                ' a[href]'
        );
        const target = primary || modal_el.querySelector('.btn-close, [data-bs-dismiss]');
        if (target) target.focus();
    }

    function _restore_modal_trigger(modal_el) {
        if (!modal_el) return;
        const trigger = _modal_triggers.get(modal_el);
        _modal_triggers.delete(modal_el);
        /*
         * The trigger may have been swapped out by HTMX between open
         * and close (e.g. a polled row that re-rendered while the
         * modal was open). In that case let the browser's default
         * behavior take over rather than focusing a detached node.
         */
        if (trigger && document.body.contains(trigger)) {
            trigger.focus();
        }
    }

    ['modal-mount', 'confirm-modal'].forEach(function (id) {
        const modal_el = document.getElementById(id);
        if (!modal_el) return;
        modal_el.addEventListener('shown.bs.modal', function () {
            _focus_first_in_modal(modal_el);
        });
        modal_el.addEventListener('hidden.bs.modal', function () {
            _restore_modal_trigger(modal_el);
        });
    });

    /*
     * For #modal-mount, the trigger is whatever HTMX element requested
     * a swap into #modal-content. Capture it at request-start time so
     * it's reliable even if focus shifts during the network roundtrip.
     */
    document.body.addEventListener('htmx:beforeRequest', function (evt) {
        const target = evt.detail && evt.detail.target;
        if (!target || target.id !== 'modal-content') return;
        _capture_modal_trigger(
            document.getElementById('modal-mount'),
            evt.detail && evt.detail.elt
        );
    });

    /*
     * ---- 6. Broken-thumbnail handler ----
     * Replaces a failed <img class="thumb-img"> with the placeholder
     * icon. Has to use capture-phase listening because `error` events
     * on <img> elements don't bubble — a delegated listener attached
     * to document.body via addEventListener defaults to bubble and
     * would never fire. CSP's `script-src-attr 'none'` forbids the
     * inline `onerror=` attribute we used to use; this is the
     * equivalent behavior implemented in a CSP-safe way.
     */
    document.body.addEventListener(
        'error',
        function (evt) {
            const el = evt.target;
            if (!el || el.tagName !== 'IMG' || !el.classList.contains('thumb-img')) return;
            /*
             * Build a placeholder span that matches the EJS partial's
             * empty-state markup (.thumb-placeholder + a media-specific icon).
             * The icon is keyed off the img's data-media (set server-side from
             * the object mime_type) so a failed audio/video/pdf thumbnail
             * shows its own icon, not the image one. These icons MUST stay in
             * sync with views/dashboard/partials/thumb_placeholder.ejs.
             * Absent data-media (e.g. collection rows) → 'image', preserving
             * the prior image-off placeholder for those.
             */
            const THUMB_ICONS = {
                audio:
                    '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
                video:
                    '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
                pdf:
                    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
                image:
                    '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
                file:
                    '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
            };
            const media = (el.dataset && el.dataset.media) || 'image';
            const icon = THUMB_ICONS[media] || THUMB_ICONS.image;
            const placeholder = document.createElement('span');
            placeholder.className = 'thumb-placeholder';
            placeholder.setAttribute('data-media', media);
            placeholder.setAttribute('aria-label', 'Thumbnail failed to load');
            placeholder.title = 'Thumbnail failed to load';
            placeholder.innerHTML =
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
                ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                icon +
                '</svg>';
            if (el.parentNode) el.parentNode.replaceChild(placeholder, el);
        },
        true // capture-phase: see comment above
    );

    /*
     * ---- 7. Bulk selection toolbar ----
     * The toolbar (rendered by objects_table.ejs) is visible only when
     * at least one row checkbox is checked. State lives in the DOM —
     * no SPA store needed — because HTMX may swap the table multiple
     * times during a session and re-running the swap should leave any
     * newly-rendered rows unchecked (which it does, since rows render
     * without `checked`).
     * 
     * The hidden #bulk-pids input is the single source of truth the
     * forms read from; the per-row checkboxes only feed it.
     */
    function update_bulk_toolbar() {
        const toolbar = document.querySelector('.bulk-toolbar');
        if (!toolbar) return;
        const checks = document.querySelectorAll('.row-select:checked');
        const count = checks.length;
        const count_el = toolbar.querySelector('.bulk-count-n');
        if (count_el) count_el.textContent = String(count);
        toolbar.classList.toggle('is-active', count > 0);
        const pids_input = document.getElementById('bulk-pids');
        if (pids_input) {
            /*
             * Comma-join — small payload, easy for the server to parse,
             * bypasses Express body parser's array-key heuristics.
             */
            pids_input.value = Array.from(checks)
                .map((c) => c.value)
                .join(',');
        }
        /*
         * Keep the header "select all" in sync — checked if every visible
         * row is selected, indeterminate otherwise.
         */
        const all_rows = document.querySelectorAll('.row-select');
        const select_all = document.querySelector('.select-all');
        if (select_all && all_rows.length > 0) {
            if (count === 0) {
                select_all.checked = false;
                select_all.indeterminate = false;
            } else if (count === all_rows.length) {
                select_all.checked = true;
                select_all.indeterminate = false;
            } else {
                select_all.checked = false;
                select_all.indeterminate = true;
            }
        }
    }

    document.body.addEventListener('change', function (evt) {
        const el = evt.target;
        if (!el) return;
        if (el.classList && el.classList.contains('row-select')) {
            update_bulk_toolbar();
        } else if (el.classList && el.classList.contains('select-all')) {
            // Toggle every visible row checkbox to match.
            document.querySelectorAll('.row-select').forEach((cb) => {
                cb.checked = el.checked;
            });
            update_bulk_toolbar();
        }
    });

    document.body.addEventListener('click', function (evt) {
        const btn = evt.target;
        if (!btn || !btn.classList || !btn.classList.contains('bulk-clear')) return;
        document.querySelectorAll('.row-select').forEach((cb) => {
            cb.checked = false;
        });
        update_bulk_toolbar();
    });

    /*
     * After HTMX swaps the objects table (filter change, pagination,
     * post-bulk refresh), recompute the toolbar state. The new rows
     * come in unchecked so the count drops to 0 and the toolbar hides.
     */
    document.body.addEventListener('htmx:afterSwap', function (evt) {
        if (evt.detail.target && evt.detail.target.id === 'objects-table') {
            update_bulk_toolbar();
        }
    });

    /*
     * Note: the #objects-table region declares
     *   hx-trigger="load, objects:refresh from:body"
     * so the bulk-action HX-Trigger response is enough to refresh the
     * table. No JS plumbing needed for that path.
     */

    /*
     * ---- 8. Thumbnail upload preview ----
     * Delegated change listener for the file input inside the upload
     * modal. Renders a local preview via FileReader so the user sees
     * their choice before submitting. Kept here (and not inline in the
     * partial) because our CSP forbids inline scripts.
     */
    document.body.addEventListener('change', function (evt) {
        const input = evt.target;
        if (!input || input.id !== 'thumbnail-file') return;
        const slot = document.getElementById('thumbnail-preview-new');
        if (!slot) return;
        const file = input.files && input.files[0];
        if (!file) {
            slot.className = 'thumb-preview thumb-preview-empty';
            slot.textContent = 'No file';
            return;
        }
        const reader = new FileReader();
        reader.onload = function (e) {
            /*
             * Replace slot contents with a preview <img>. textContent
             * first to clear any prior children safely.
             */
            slot.textContent = '';
            slot.className = 'thumb-preview';
            const img = document.createElement('img');
            img.alt = 'Selected thumbnail preview';
            img.src = e.target.result;
            slot.appendChild(img);
        };
        reader.readAsDataURL(file);
    });

    /*
     * ---- 9. Abstract expand/collapse ----
     * Click .abstract-toggle → toggle .abstract-collapsed on the
     * sibling .abstract-body. Used by long abstracts on the
     * collection-detail page (and any future page that opts in via
     * the same .abstract-block / .abstract-body / .abstract-toggle
     * markup). The full text is always in the DOM; we only flip
     * which portion is visible.
     * 
     * No inline onclick — CSP forbids that. Delegated handler so it
     * works for partials swapped in via htmx too.
     */
    document.body.addEventListener('click', function (evt) {
        const btn = evt.target.closest && evt.target.closest('.abstract-toggle');
        if (!btn) return;
        const block = btn.closest('.abstract-block');
        if (!block) return;
        const body = block.querySelector('.abstract-body');
        if (!body) return;
        const now_collapsed = body.classList.toggle('abstract-collapsed');
        btn.textContent = now_collapsed ? '… more' : 'less';
        btn.setAttribute('aria-expanded', now_collapsed ? 'false' : 'true');
    });

    /*
     * ---- 10. Deferred redirect (workspace action results) ----
     * Some workspace actions (Submit to Ingest is the only one
     * today) show a success card briefly, then navigate the
     * browser to the queue view so staff sees the rows appearing
     * there. Previously this used an inline <script> in the
     * returned partial — that's a CSP `script-src-elem` violation
     * because our policy forbids inline scripts. Instead the
     * partial drops a .workspace-deferred-redirect sentinel
     * <div data-redirect-target="…" data-redirect-delay="…">;
     * we pick it up on htmx:afterSwap and schedule the navigation
     * from this (self-hosted) bundle.
     * 
     * Idempotency: we remove the sentinel after scheduling so a
     * subsequent re-render of the SAME partial (e.g. an htmx
     * polling tick that happened to land mid-redirect) doesn't
     * chain multiple timeouts.
     */
    document.body.addEventListener('htmx:afterSwap', function (evt) {
        const root = evt.detail && evt.detail.target;
        if (!root || !root.querySelector) return;
        const sentinel = root.querySelector('.workspace-deferred-redirect');
        if (!sentinel) return;
        const target = sentinel.getAttribute('data-redirect-target');
        if (!target) return;
        const delay = parseInt(sentinel.getAttribute('data-redirect-delay'), 10) || 2000;
        sentinel.remove();
        setTimeout(function () {
            window.location.assign(target);
        }, delay);
    });

    /*
     * ---- 5. Sidebar tooltips ----
     * The icon-only nav rail relies on hover labels. Native `title`
     * tooltips are slow to appear (~0.5s+, browser-controlled) and plainly
     * styled, so upgrade the sidebar links to Bootstrap tooltips: placed to
     * the right (clear of the rail), a short ~100ms show delay so they pop
     * quickly, and a `.sidebar-tooltip` custom class for a more prominent
     * bubble (see styles.css). Bootstrap consumes each link's `title` on
     * init (clears the attribute) so the native tooltip doesn't also fire.
     * Progressive enhancement: with JS off, the native `title` still works.
     * The rail is server-rendered once (not htmx-swapped), so a one-time
     * init on load covers every link; getOrCreateInstance is idempotent.
     */
    if (window.bootstrap && window.bootstrap.Tooltip) {
        const nav_links = document.querySelectorAll('.app-sidebar a[title]');
        nav_links.forEach(function (el) {
            window.bootstrap.Tooltip.getOrCreateInstance(el, {
                placement: 'right',
                delay: { show: 100, hide: 50 },
                customClass: 'sidebar-tooltip',
            });
        });
    }

    /*
     * ---- 6. Add-objects picker: persistent multi-select ----
     * The picker's results region is HTMX-swapped on every search + page, so a
     * checkbox's state can't live in the row. We keep the selected pids in a
     * Set, mirror it into hidden <input name="pids"> elements inside the form
     * (so the POST submits the FULL selection, not just the visible page),
     * re-apply checked state after each swap, and keep the count + submit button
     * in sync. CSP-safe: all behavior lives here, no inline handlers. The
     * visible checkboxes are UI-only (data-pid, no name); the hidden inputs are
     * the submitted source of truth.
     */
    (function add_objects_selection() {
        const form = document.getElementById('add-objects-form');
        if (!form) return;
        const hidden = document.getElementById('add-objects-selected');
        const count_el = document.getElementById('add-objects-count');
        const submit_btn = document.getElementById('add-objects-submit');
        const selected = new Set();

        /*
         * Mirror the server cap (collections.add_members allows ≤100 per add)
         * so the header "select all" can't build a selection the POST would
         * 400 on — we warn + block submit instead.
         */
        const MAX_ADD = 100;

        function render() {
            // Rebuild the hidden pids inputs from the Set.
            hidden.textContent = '';
            selected.forEach(function (pid) {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = 'pids';
                input.value = pid;
                hidden.appendChild(input);
            });
            const n = selected.size;
            const over = n > MAX_ADD;
            if (count_el) {
                count_el.textContent = n
                    ? over
                        ? n + ' selected — max ' + MAX_ADD + ' per add'
                        : n + ' selected'
                    : '';
                count_el.classList.toggle('text-danger', over);
                count_el.classList.toggle('text-muted', !over);
            }
            if (submit_btn) submit_btn.disabled = n === 0 || over;
        }

        /*
         * Reflect the visible page's state in the header "select all" checkbox:
         * checked when every visible row is selected, indeterminate when some.
         */
        function sync_header() {
            const header = document.getElementById('add-objects-select-page');
            if (!header) return;
            const boxes = form.querySelectorAll('.add-object-checkbox[data-pid]');
            if (boxes.length === 0) {
                header.checked = false;
                header.indeterminate = false;
                return;
            }
            let n = 0;
            boxes.forEach(function (cb) {
                if (selected.has(cb.getAttribute('data-pid'))) n++;
            });
            header.checked = n === boxes.length;
            header.indeterminate = n > 0 && n < boxes.length;
        }

        function apply_to_visible() {
            form.querySelectorAll('.add-object-checkbox[data-pid]').forEach(function (cb) {
                cb.checked = selected.has(cb.getAttribute('data-pid'));
            });
            sync_header();
        }

        // Toggle via event delegation so it survives result swaps.
        form.addEventListener('change', function (evt) {
            const t = evt.target;
            if (!t) return;
            // Header "select all on this page" — toggle every visible row.
            if (t.id === 'add-objects-select-page') {
                form.querySelectorAll('.add-object-checkbox[data-pid]').forEach(function (cb) {
                    cb.checked = t.checked;
                    const pid = cb.getAttribute('data-pid');
                    if (t.checked) selected.add(pid);
                    else selected.delete(pid);
                });
                render();
                sync_header();
                return;
            }
            // Individual row toggle.
            const cb = t.closest && t.closest('.add-object-checkbox[data-pid]');
            if (!cb) return;
            const pid = cb.getAttribute('data-pid');
            if (cb.checked) selected.add(pid);
            else selected.delete(pid);
            render();
            sync_header();
        });

        // After a results swap (search or page), re-check anything selected.
        document.body.addEventListener('htmx:afterSwap', function (evt) {
            const target = evt.detail && evt.detail.target;
            if (target && target.id === 'add-objects-results') apply_to_visible();
        });

        render();
    })();

    /*
     * ---- Admin > Handles: repeatable mint rows ----
     *
     * The page renders ONE row; this grows it to at most data-max. Rows are
     * cloned client-side rather than fetched, so adding one is instant.
     *
     * Accessibility is most of the work here:
     *   - focus moves to the new row's URL field on add, and to the previous
     *     row on remove — otherwise a keyboard user has no idea the DOM
     *     changed and has to hunt for where they are
     *   - every add/remove is announced through a polite live region,
     *     including how many more are allowed
     *   - renumber() reassigns ids, label `for`, label text and each Remove
     *     button's accessible name after ANY change, so "Remove handle 3"
     *     always names the row it will actually remove
     *   - Remove is hidden when only one row is left: there is nothing to
     *     remove, and a dead control is worse than no control
     */
    (function handle_mint_rows() {
        const tbody = document.getElementById('handle-rows');
        if (!tbody) return;

        const add_btn = document.getElementById('handle-add-row');
        const status = document.getElementById('handle-rows-status');
        const max = parseInt(tbody.dataset.max, 10) || 5;

        function rows() {
            return Array.prototype.slice.call(tbody.querySelectorAll('.handle-row'));
        }

        function announce(message) {
            if (status) status.textContent = message;
        }

        function renumber() {
            const list = rows();
            list.forEach(function (row, i) {
                const n = i + 1;
                const url = row.querySelector('input[name="target_url"]');
                const note = row.querySelector('input[name="note"]');
                const url_label = row.querySelector('label[data-for="target"]');
                const note_label = row.querySelector('label[data-for="note"]');
                const remove = row.querySelector('.handle-row-remove');

                url.id = 'target-' + n;
                note.id = 'note-' + n;
                url_label.setAttribute('for', url.id);
                url_label.textContent = 'Target URL ' + n;
                note_label.setAttribute('for', note.id);
                note_label.textContent = 'Note ' + n;

                if (remove) {
                    remove.hidden = list.length === 1;
                    remove.setAttribute('aria-label', 'Remove handle ' + n);
                }
            });

            if (add_btn) {
                /* Revealed here, not in the markup, so no-JS gets no dead button. */
                add_btn.hidden = false;
                add_btn.disabled = list.length >= max;
            }
        }

        if (add_btn) {
            add_btn.addEventListener('click', function () {
                const list = rows();
                if (list.length >= max) return;

                const clone = list[0].cloneNode(true);
                clone.querySelectorAll('input').forEach(function (input) {
                    input.value = '';
                });
                tbody.appendChild(clone);
                renumber();

                const count = rows().length;
                clone.querySelector('input[name="target_url"]').focus();
                announce(
                    count >= max
                        ? 'Handle ' + count + ' added. Maximum of ' + max + ' reached.'
                        : 'Handle ' + count + ' added. ' + (max - count) + ' more can be added.'
                );
            });
        }

        tbody.addEventListener('click', function (evt) {
            const btn = evt.target.closest && evt.target.closest('.handle-row-remove');
            if (!btn) return;

            const list = rows();
            if (list.length <= 1) return;

            const row = btn.closest('.handle-row');
            const removed_at = list.indexOf(row);
            row.remove();
            renumber();

            const remaining = rows();
            /* Land on the row above the one that vanished. */
            const focus_row = remaining[Math.max(0, removed_at - 1)];
            focus_row.querySelector('input[name="target_url"]').focus();
            announce(
                'Handle ' + (removed_at + 1) + ' removed. '
                + remaining.length + ' remaining.'
            );
        });

        /*
         * Emitted by the mint POST via HX-Trigger, but ONLY when every handle
         * succeeded. Clearing on a partial failure would throw away the URLs
         * the operator still needs to correct; leaving values after a full
         * success invites a second click that mints a duplicate.
         *
         * Focus is deliberately left on the Mint button — the operator's
         * attention belongs on the toast and the refreshed list, not back in
         * an empty field.
         */
        document.body.addEventListener('handles-reset', function () {
            rows().slice(1).forEach(function (row) { row.remove(); });
            const first = rows()[0];
            if (first) {
                first.querySelectorAll('input').forEach(function (input) {
                    input.value = '';
                });
            }
            renumber();
            announce('Form cleared.');
        });

        renumber();
    })();
})();
