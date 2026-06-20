'use strict';

// Unit tests for the RBAC permission map + require_permission middleware.
// The DB-fresh role lookup path is covered by tests/e2e/rbac.test.js;
// here we drive the decision logic with the role set directly on req.user
// (which the middleware uses without a DB hit) so no DB is needed.

const {
    has_permission,
    require_permission,
    ROLE_PERMISSIONS,
    PERMISSIONS,
    ROLE_NAMES,
    DEFAULT_ROLE,
} = require('../../../auth/rbac');
const { ForbiddenError } = require('../../../libs/errors');

describe('auth/rbac', () => {
    describe('has_permission', () => {
        it('admin has every permission', () => {
            for (const p of Object.values(PERMISSIONS)) {
                expect(has_permission('admin', p)).toBe(true);
            }
        });

        it('viewer has only view_repository', () => {
            expect(has_permission('viewer', PERMISSIONS.VIEW_REPOSITORY)).toBe(true);
            expect(has_permission('viewer', PERMISSIONS.PUBLISH_OBJECT)).toBe(false);
            expect(has_permission('viewer', PERMISSIONS.DELETE_OBJECT)).toBe(false);
            expect(has_permission('viewer', PERMISSIONS.MANAGE_USERS)).toBe(false);
        });

        it('staff can curate + ingest but not run admin ops', () => {
            expect(has_permission('staff', PERMISSIONS.PUBLISH_OBJECT)).toBe(true);
            expect(has_permission('staff', PERMISSIONS.EDIT_OBJECT)).toBe(true);
            expect(has_permission('staff', PERMISSIONS.DELETE_OBJECT)).toBe(true);
            expect(has_permission('staff', PERMISSIONS.MANAGE_INGEST)).toBe(true);
            expect(has_permission('staff', PERMISSIONS.MANAGE_INDEX)).toBe(false);
            expect(has_permission('staff', PERMISSIONS.MANAGE_METADATA_REFRESH)).toBe(false);
            expect(has_permission('staff', PERMISSIONS.MANAGE_CONVERT)).toBe(false);
            expect(has_permission('staff', PERMISSIONS.MANAGE_USERS)).toBe(false);
        });

        it('unknown role / unknown permission / nullish → false', () => {
            expect(has_permission('nope', PERMISSIONS.VIEW_REPOSITORY)).toBe(false);
            expect(has_permission('admin', 'not_a_permission')).toBe(false);
            expect(has_permission(undefined, PERMISSIONS.VIEW_REPOSITORY)).toBe(false);
        });
    });

    describe('catalog integrity', () => {
        it('ROLE_NAMES is viewer/staff/admin and includes the default', () => {
            expect(ROLE_NAMES).toEqual(['viewer', 'staff', 'admin']);
            expect(ROLE_NAMES).toContain(DEFAULT_ROLE);
        });

        it('every role grants only known permissions', () => {
            const known = new Set(Object.values(PERMISSIONS));
            for (const role of ROLE_NAMES) {
                for (const p of ROLE_PERMISSIONS[role]) expect(known.has(p)).toBe(true);
            }
        });

        it('roles are monotonic: viewer ⊆ staff ⊆ admin', () => {
            const v = new Set(ROLE_PERMISSIONS.viewer);
            const s = new Set(ROLE_PERMISSIONS.staff);
            const a = new Set(ROLE_PERMISSIONS.admin);
            for (const p of v) expect(s.has(p)).toBe(true);
            for (const p of s) expect(a.has(p)).toBe(true);
        });
    });

    describe('require_permission middleware', () => {
        function mk(role, { htmx = false } = {}) {
            const headers = htmx ? { 'hx-request': 'true' } : {};
            const req = {
                user: role ? { du_id: 'u1', role } : { du_id: 'u1' },
                get: (h) => headers[String(h).toLowerCase()],
            };
            const res = {
                _status: null,
                _headers: {},
                _body: null,
                status(s) {
                    this._status = s;
                    return this;
                },
                set(k, v) {
                    this._headers[k] = v;
                    return this;
                },
                type() {
                    return this;
                },
                send(b) {
                    this._body = b;
                    return this;
                },
            };
            return { req, res };
        }

        it('calls next() when the role grants the permission', async () => {
            const { req, res } = mk('admin');
            let called = false;
            await require_permission(PERMISSIONS.MANAGE_USERS)(req, res, () => {
                called = true;
            });
            expect(called).toBe(true);
        });

        it('non-HTMX denial forwards a ForbiddenError (403) to next()', async () => {
            const { req, res } = mk('staff');
            let err = null;
            await require_permission(PERMISSIONS.MANAGE_USERS)(req, res, (e) => {
                err = e;
            });
            expect(err).toBeInstanceOf(ForbiddenError);
            expect(err.status).toBe(403);
        });

        it('HTMX denial → 403 + toast header, does NOT call next', async () => {
            const { req, res } = mk('staff', { htmx: true });
            let next_called = false;
            await require_permission(PERMISSIONS.MANAGE_INDEX)(req, res, () => {
                next_called = true;
            });
            expect(res._status).toBe(403);
            expect(res._headers['HX-Trigger']).toMatch(/toast/);
            expect(next_called).toBe(false);
        });
    });
});
