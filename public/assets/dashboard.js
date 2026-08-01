/*
 * repo-backend-v2 dashboard glue. The browser attaches the httpOnly session
 * cookie to every request, so there is no API-key handling here.
 *
 *    1.  401 responses: redirect to login via HX-Redirect or location
 *    2.  Toast notifications from HX-Trigger: { toast: {...} }
 *    3.  Confirm modal (data-confirm), replacing htmx's hx-confirm
 *    3a. Pause htmx polling while a confirm modal is open
 *    4.  Modal auto-open on swap into #modal-content
 *    5.  Modal close on HX-Trigger: { "modal:close": {} }
 *    5a. Modal focus management (WCAG 2.4.3)
 *    6.  Broken-thumbnail placeholder
 *    7.  Bulk selection toolbar
 *    8.  Thumbnail upload preview
 *    9.  Abstract expand/collapse
 *   10.  Deferred redirect after a workspace action
 *   11.  Sidebar tooltips
 *   11a. Handle-link tooltips (Admin > Handles)
 *   12.  Add-objects picker: persistent multi-select
 *   13.  Admin > Handles: repeatable mint rows
 *   14.  Admin > Handles: copy a handle to the clipboard
 */
(function () {
    'use strict';

    if (typeof window.htmx === 'undefined') {
        console.error('htmx not loaded; dashboard.js can not initialize');
        return;
    }

    // From <body data-dashboard-base="...">, so the layout needs no inline script.
    const DASHBOARD_BASE =
        (document.body && document.body.dataset && document.body.dataset.dashboardBase) ||
        '/repo/dashboard';

    /*
     * ---- 1. 401 handling ----
     * The auth middleware sets HX-Redirect on a 401 and htmx follows it. This
     * is the fallback for API calls that bypass that middleware.
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
     * Immediate feedback the moment a long-running request fires. Any element
     * opts in with data-busy-message="...".
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
     * Intercepts clicks on [data-confirm] at the CAPTURE phase, before htmx
     * sees them, and opens the styled modal. On OK a one-shot sentinel is set
     * on the element and the click is re-fired; the capture listener sees the
     * sentinel and lets it through. htmx's own hx-confirm is not used.
     *
     * Element contract:
     *   data-confirm="<message body>"     required
     *   data-confirm-title="<title>"      optional (default: "Confirm")
     *   data-confirm-label="<button>"     optional (default: "Confirm")
     *
     * Works for non-htmx elements too — a plain <a href> just gets elt.click().
     */
    document.body.addEventListener(
        'click',
        function (evt) {
            const elt = evt.target.closest && evt.target.closest('[data-confirm]');
            if (!elt) return;
            // Single-use sentinel: cleared on entry, so the next real click confirms.
            if (elt.__confirmed) {
                elt.__confirmed = false;
                return;
            }
            // Keep htmx and every other handler from seeing this click.
            evt.preventDefault();
            evt.stopImmediatePropagation();
            evt.stopPropagation();

            const question = elt.getAttribute('data-confirm') || '';
            const title = elt.getAttribute('data-confirm-title') || 'Confirm';
            const label = elt.getAttribute('data-confirm-label') || 'Confirm';

            const modal_el = document.getElementById('confirm-modal');
            // No styled modal, or no Bootstrap: fall back to the native confirm.
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
            // Red proceed button for destructive labels.
            const is_destructive = /delete|remove|cancel batch/i.test(label);
            proceed.className = 'btn ' + (is_destructive ? 'btn-danger' : 'btn-primary');

            const bs_modal = window.bootstrap.Modal.getOrCreateInstance(modal_el);

            /*
             * Set synchronously — section 3a reads it to suppress polling while
             * the modal is open. Not Bootstrap's .modal-open, which is added
             * asynchronously after the show transition begins.
             */
            document.body.classList.add('htmx-confirm-pending');

            /*
             * onclick, not addEventListener, so stale closures pointing at old
             * elements never accumulate. Bootstrap handles backdrop click and
             * Escape, so cancel needs no wiring.
             */
            proceed.onclick = function () {
                bs_modal.hide();
                document.body.classList.remove('htmx-confirm-pending');
                elt.__confirmed = true;
                elt.click();
            };
            // Clear the flag on any close (proceed, cancel, Escape, backdrop).
            modal_el.addEventListener('hidden.bs.modal', function on_hide() {
                document.body.classList.remove('htmx-confirm-pending');
                modal_el.removeEventListener('hidden.bs.modal', on_hide);
            });

            // Section 5a returns focus here when the modal closes, however it closes.
            _capture_modal_trigger(modal_el, elt);

            bs_modal.show();
        },
        true // capture phase — runs before htmx's bubble-phase handlers
    );

    /*
     * ---- 3a. Pause htmx polling while a confirm modal is open ----
     * Cancels ONLY polling requests, identified by `every` in the source
     * element's hx-trigger. Click-, submit- and load-triggered requests always
     * pass through.
     */
    document.body.addEventListener('htmx:beforeRequest', function (evt) {
        if (!document.body.classList.contains('htmx-confirm-pending')) return;
        const src = evt.detail && evt.detail.elt;
        if (!src) return;
        const trigger = src.getAttribute('hx-trigger');
        // Word-boundary match, so `every2s`, `everyone` and `evening` don't match.
        if (trigger && /\bevery\b/.test(trigger)) {
            evt.preventDefault();
        }
    });

    /*
     * ---- 4. Modal auto-open ----
     * Any partial swapped into #modal-content (inside the layout's generic
     * #modal-mount) opens the modal. A route returning a modal-shaped fragment
     * only has to target #modal-content.
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
     * Hides whatever modal is open when the server emits
     * HX-Trigger: { "modal:close": {} }. Needed because handlers like the
     * thumbnail upload swap their response into the row, not the modal.
     */
    document.body.addEventListener('modal:close', function () {
        const modal_el = document.getElementById('modal-mount');
        if (!modal_el || !window.bootstrap) return;
        const instance = window.bootstrap.Modal.getInstance(modal_el);
        if (instance) instance.hide();
    });

    /*
     * ---- 5a. Modal focus management (WCAG 2.4.3) ----
     * On show, moves focus to the modal's first usable control rather than the
     * container. On hide, returns focus to the trigger captured at request
     * time rather than to whatever held :focus when show() ran.
     *
     * Applies to #modal-mount (HTMX-swapped content) and #confirm-modal
     * (intercepted-click confirmation). Per-modal state lives in a WeakMap
     * keyed by the modal element.
     */
    const _modal_triggers = new WeakMap();

    function _capture_modal_trigger(modal_el, trigger) {
        if (!modal_el) return;
        /*
         * Nearest focusable ancestor, so an inner SVG path isn't the target.
         * Falls back to the raw element, where focus() is simply a no-op.
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
         * First non-dismiss control, falling back to the close button for a
         * modal that has nothing else (a metadata view, say).
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
         * HTMX may have swapped the trigger out between open and close. Leave
         * focus to the browser rather than targeting a detached node.
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
     * For #modal-mount the trigger is whatever HTMX element requested the swap
     * into #modal-content, captured at request start so a focus shift during
     * the round trip cannot lose it.
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
     * Replaces a failed <img class="thumb-img"> with the placeholder icon.
     * MUST be capture-phase: `error` events on <img> do not bubble, so a
     * bubble-phase delegated listener would never fire.
     */
    document.body.addEventListener(
        'error',
        function (evt) {
            const el = evt.target;
            if (!el || el.tagName !== 'IMG' || !el.classList.contains('thumb-img')) return;
            /*
             * Keyed off the img's data-media (set server-side from mime_type),
             * defaulting to 'image' when absent. These icons MUST stay in sync
             * with views/dashboard/partials/thumb_placeholder.ejs.
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
     * The toolbar (rendered by objects_table.ejs) is visible only while at
     * least one row checkbox is checked. State lives in the DOM. The hidden
     * #bulk-pids input is what the forms read; the per-row checkboxes only
     * feed it.
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
            // Comma-joined, which bypasses the Express body parser's array heuristics.
            pids_input.value = Array.from(checks)
                .map((c) => c.value)
                .join(',');
        }
        // Header "select all": checked when every visible row is, else indeterminate.
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
     * Recompute after any objects-table swap (filter, pagination, post-bulk
     * refresh). New rows arrive unchecked, so the count drops to 0 and the
     * toolbar hides.
     */
    document.body.addEventListener('htmx:afterSwap', function (evt) {
        if (evt.detail.target && evt.detail.target.id === 'objects-table') {
            update_bulk_toolbar();
        }
    });

    /*
     * ---- 8. Thumbnail upload preview ----
     * Delegated change listener for the upload modal's file input; renders a
     * local FileReader preview before submit.
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
            // textContent first, to clear any prior children safely.
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
     * Click .abstract-toggle → toggle .abstract-collapsed on the sibling
     * .abstract-body. Any page opts in with the .abstract-block /
     * .abstract-body / .abstract-toggle markup. The full text is always in the
     * DOM; only the visible portion changes. Delegated, so htmx-swapped
     * partials are covered.
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
     * A workspace action's partial can drop a .workspace-deferred-redirect
     * sentinel <div data-redirect-target="…" data-redirect-delay="…">; the
     * navigation is scheduled here on htmx:afterSwap. Submit to Ingest is the
     * only user today.
     *
     * The sentinel is removed once scheduled, so a re-render of the same
     * partial cannot chain multiple timeouts.
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
     * ---- 11. Sidebar tooltips ----
     * Upgrades the icon-only nav rail's hover labels to Bootstrap tooltips:
     * placed right, ~100ms show delay, `.sidebar-tooltip` custom class (see
     * styles.css). Bootstrap consumes each link's `title` on init so the
     * native tooltip does not also fire; with JS off the `title` still works.
     * The rail is server-rendered once, so one init on load covers every link.
     */
    function init_tooltips(scope, selector, options) {
        if (!window.bootstrap || !window.bootstrap.Tooltip) return;
        (scope || document).querySelectorAll(selector).forEach(function (el) {
            window.bootstrap.Tooltip.getOrCreateInstance(el, options);
        });
    }

    function dispose_tooltips(scope, selector) {
        if (!window.bootstrap || !window.bootstrap.Tooltip) return;
        if (!scope || !scope.querySelectorAll) return;
        scope.querySelectorAll(selector).forEach(function (el) {
            const instance = window.bootstrap.Tooltip.getInstance(el);
            if (instance) instance.dispose();
        });
    }

    init_tooltips(document, '.app-sidebar a[title]', {
        placement: 'right',
        delay: { show: 100, hide: 50 },
        customClass: 'sidebar-tooltip',
    });

    /*
     * ---- 11a. Handle-link tooltips (Admin > Handles) ----
     * Same treatment as the rail, but #handles-list IS htmx-swapped (by mint,
     * delete and the status filter), so one init on load is not enough:
     *
     *   - re-init after every swap, or later rows get only the native tooltip
     *   - dispose BEFORE the swap, or a tooltip showing when its row is
     *     replaced is left orphaned in the body with nothing to anchor to
     */
    const HANDLE_TOOLTIP = 'a.handle-link[title], a.handle-link[data-bs-original-title]';
    const HANDLE_TOOLTIP_OPTS = {
        placement: 'top',
        delay: { show: 100, hide: 50 },
        customClass: 'handle-tooltip',
    };

    init_tooltips(document, HANDLE_TOOLTIP, HANDLE_TOOLTIP_OPTS);

    document.body.addEventListener('htmx:beforeSwap', function (evt) {
        dispose_tooltips(evt.detail && evt.detail.target, HANDLE_TOOLTIP);
    });

    document.body.addEventListener('htmx:afterSwap', function (evt) {
        const root = evt.detail && evt.detail.target;
        if (root && root.querySelectorAll) {
            init_tooltips(root, HANDLE_TOOLTIP, HANDLE_TOOLTIP_OPTS);
        }
    });

    /*
     * Escape dismisses any open tooltip (WCAG 2.1 SC 1.4.13 — hover/focus
     * content must be dismissible without moving the pointer or focus).
     * Bootstrap does not handle Escape itself. Covers the rail and the handle
     * links alike.
     */
    document.addEventListener('keydown', function (evt) {
        if (evt.key !== 'Escape') return;
        if (!window.bootstrap || !window.bootstrap.Tooltip) return;
        document.querySelectorAll('.tooltip').forEach(function (bubble) {
            const owner = document.querySelector(
                '[aria-describedby="' + bubble.id + '"]'
            );
            const instance = owner && window.bootstrap.Tooltip.getInstance(owner);
            if (instance) instance.hide();
        });
    });

    /*
     * ---- 12. Add-objects picker: persistent multi-select ----
     * The results region is HTMX-swapped on every search and page, so checkbox
     * state cannot live in the row. Selected pids are held in a Set, mirrored
     * into hidden <input name="pids"> elements in the form so the POST submits
     * the FULL selection, re-applied to the visible rows after each swap.
     * The visible checkboxes are UI-only (data-pid, no name); the hidden
     * inputs are the submitted source of truth.
     */
    (function add_objects_selection() {
        const form = document.getElementById('add-objects-form');
        if (!form) return;
        const hidden = document.getElementById('add-objects-selected');
        const count_el = document.getElementById('add-objects-count');
        const submit_btn = document.getElementById('add-objects-submit');
        const selected = new Set();

        // Mirrors the server cap in collections.add_members. Over it, submit is blocked.
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

        // Header checkbox: checked when every visible row is selected, else indeterminate.
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
     * ---- 13. Admin > Handles: repeatable mint rows ----
     *
     * The page renders ONE row; this clones it client-side up to data-max.
     *
     * Accessibility behavior:
     *   - focus moves to the new row's URL field on add, and to the previous
     *     row on remove
     *   - every add/remove is announced through a polite live region,
     *     including how many more are allowed
     *   - renumber() reassigns ids, label `for`, label text and each Remove
     *     button's accessible name after ANY change, so "Remove handle 3"
     *     always names the row it will actually remove
     *   - Remove is hidden while only one row is left
     */
    (function handle_mint_rows() {
        const tbody = document.getElementById('handle-rows');
        if (!tbody) return;

        const add_btn = document.getElementById('handle-add-row');
        const status = document.getElementById('handle-rows-status');
        const submit_btn = document.getElementById('handle-mint-submit');
        const ready_el = document.getElementById('handle-mint-ready');
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

            sync_submit();
        }

        /*
         * Enables Mint once at least one target URL is non-blank; whitespace
         * does not count. Presence only — `type="url"` covers format and the
         * server re-validates the host allowlist. The button is rendered
         * ENABLED and disabled here, so the form still works with JS off, and
         * it cannot re-enable a button the server disabled (HANDLE_*
         * unconfigured) because those inputs are disabled too.
         */
        function sync_submit() {
            if (!submit_btn) return;

            const filled = rows().filter(function (row) {
                const input = row.querySelector('input[name="target_url"]');
                return input && input.value.trim() !== '';
            }).length;

            submit_btn.disabled = filled === 0;
            if (ready_el) {
                ready_el.textContent = filled === 0
                    ? ''
                    : filled + ' handle' + (filled === 1 ? '' : 's') + ' ready to mint';
            }
        }

        /* Delegated, so cloned rows are covered without rebinding. */
        tbody.addEventListener('input', sync_submit);

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
         * succeeded. Resets to a single empty row. Focus stays on the Mint
         * button rather than moving into a field.
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

    /*
     * ---- 14. Admin > Handles: copy a handle to the clipboard ----
     *
     * Copies the RESOLVER url (https://hdl.handle.net/<prefix>/<uuid>), read
     * from data-clipboard-text, not the bare handle. Delegated from document,
     * since htmx replaces #handles-list on mint, delete and filter. Feedback
     * is a toast plus a polite live region.
     */
    (function handle_copy_buttons() {
        function announce(message) {
            const status = document.getElementById('handles-copy-status');
            if (status) status.textContent = message;
        }

        // navigator.clipboard needs a secure context; execCommand covers plain-http dev.
        function write_clipboard(text) {
            if (navigator.clipboard && window.isSecureContext) {
                return navigator.clipboard.writeText(text);
            }
            return new Promise(function (resolve, reject) {
                const scratch = document.createElement('textarea');
                scratch.value = text;
                scratch.setAttribute('readonly', '');
                scratch.setAttribute('aria-hidden', 'true');
                scratch.style.position = 'fixed';
                scratch.style.opacity = '0';
                document.body.appendChild(scratch);
                scratch.select();
                let ok = false;
                try {
                    ok = document.execCommand('copy');
                } catch {
                    ok = false;
                }
                scratch.remove();
                if (ok) resolve();
                else reject(new Error('copy command was rejected'));
            });
        }

        document.addEventListener('click', function (evt) {
            const btn = evt.target.closest && evt.target.closest('.handle-copy');
            if (!btn) return;

            const text = btn.getAttribute('data-clipboard-text');
            if (!text) return;

            write_clipboard(text).then(function () {
                announce('Copied ' + text + ' to the clipboard.');
                show_toast({ level: 'success', message: 'Handle link copied.' });
            }).catch(function (err) {
                announce('Could not copy the handle.');
                show_toast({
                    level: 'error',
                    message: 'Could not copy to the clipboard - '
                        + (err && err.message ? err.message : 'permission denied')
                        + '. Select the handle link and copy it manually.',
                });
            });
        });
    })();
})();
