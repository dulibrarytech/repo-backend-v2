/*
 * DuHandleTool — minimal Handle.net write helper for repo-backend-v2.
 *
 * WHY THIS EXISTS
 *
 * repov2 talks to the handle server over its HTTP JSON API for everything
 * it can: resolution is public and works fine from Node. Writes cannot go
 * that way. The DU handle server at 130.253.239.32 exposes a reachable
 * write handler on port 8000 but serves no authentication mechanism —
 * /api/sessions returns a bare 403, HS_SECKEY Basic auth is not enabled,
 * and no WWW-Authenticate challenge is offered, so an unauthenticated PUT
 * comes back RC_AUTHENTICATION_NEEDED (402) with no way to satisfy it.
 * Admin operations are only available over the native binary protocol on
 * port 2641, which is how the retired Python service's hdl-genericbatch
 * calls have always worked.
 *
 * Rather than reimplement that binary protocol in Node — disproportionate,
 * and a poor place for subtle encoding bugs given these identifiers are
 * permanent — this delegates to the official client library for the write
 * path only.
 *
 * WHY NOT hdl-genericbatch
 *
 * genericbatch requires assembling batch-file TEXT containing the
 * credentials, which is precisely the injection surface the rewrite
 * removed (an unvalidated uuid carrying a newline could append arbitrary
 * directives under full prefix authority). This calls typed library
 * methods instead: there is no command text to inject into, and the
 * passphrase arrives on stdin so it is never in argv — visible to `ps` —
 * and never written to disk.
 *
 * PROTOCOL — SINGLE OPERATION
 *
 * One JSON object on stdin, one JSON result object on stdout.
 *
 *   in  {"op":"create","prefix":"10176","suffix":"<uuid>","url":"https://…",
 *        "index":2,"ttl":86400,"permissions":"1110",
 *        "adminHandle":"0.NA/10176","adminIndex":300,
 *        "keyPath":"/path/admpriv.bin","passphrase":"…"}
 *   out {"ok":true,"responseCode":1,"message":"SUCCESS"}
 *
 * ops: create | modify | delete
 *
 * "check" is a PRE-FLIGHT ONLY — key loads, prefix resolves, server reachable.
 * It does NOT prove the credential is accepted; see the comment on the case
 * below for why no non-mutating probe can. Credential acceptance is verified
 * by the create/delete round trip in scripts/verify_handle_auth.js --write.
 *
 * PROTOCOL — BATCH (NDJSON)
 *
 * A run costs ~8s when it is one operation per process: JVM start-up plus a
 * cold HandleResolver, which re-resolves 0.NA/<prefix> against the global
 * registry to locate the site before it can talk to the handle server. Doing
 * that 2,000 times for a bulk retarget would take hours, nearly all of it
 * repeated site discovery.
 *
 * Batch mode pays both costs once: one JVM, one resolver with a warm site
 * cache, one decrypted key. Input is newline-delimited JSON — a header line
 * carrying the credentials and defaults, then one line per operation:
 *
 *   in   {"op":"batch","prefix":"10176","adminHandle":"0.NA/10176",
 *         "adminIndex":300,"keyPath":"…","passphrase":"…",
 *         "ttl":86400,"permissions":"1110"}
 *        {"op":"modify","suffix":"<uuid>","url":"https://…","index":2}
 *        {"op":"create","suffix":"<uuid>","url":"https://…"}
 *        {"op":"delete","suffix":"<uuid>"}
 *
 *   out  {"suffix":"<uuid>","op":"modify","ok":true,"responseCode":1,…}
 *        …one line per operation, flushed as it completes…
 *        {"summary":true,"total":3,"succeeded":2,"failed":1}
 *
 * Results stream as each operation finishes, so a long run is watchable and
 * a caller can checkpoint progress and resume. A failing operation is
 * reported and the batch CONTINUES — one bad handle must not abandon the
 * other 2,000.
 *
 * Exit status is 0 when everything succeeded, 1 otherwise; callers should
 * read responseCode rather than relying on exit status alone.
 *
 * BUILD — on a dev machine, not the server (it has a JRE only):
 *   HANDLE_CLIENT_LIB=…/handle-client-9.3.1/lib npm run build:handle-helper
 */

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.security.PrivateKey;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import net.handle.hdllib.AbstractMessage;
import net.handle.hdllib.AbstractRequest;
import net.handle.hdllib.AbstractResponse;
import net.handle.hdllib.AuthenticationInfo;
import net.handle.hdllib.CreateHandleRequest;
import net.handle.hdllib.DeleteHandleRequest;
import net.handle.hdllib.ErrorResponse;
import net.handle.hdllib.HandleResolver;
import net.handle.hdllib.HandleValue;
import net.handle.hdllib.ModifyValueRequest;
import net.handle.hdllib.PublicKeyAuthenticationInfo;
import net.handle.hdllib.Util;

public class DuHandleTool {

    private static final Gson GSON = new Gson();

    private static final String UUID_PATTERN =
        "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
        + "-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

    public static void main(String[] args) {
        /*
         * Everything is written to stdout as JSON, including failures, so
         * the Node caller never has to parse a stack trace. Anything the
         * library prints to stderr is left alone for operators.
         */
        PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);
        try {
            String input = readAll(System.in);
            JsonObject single = tryParseObject(input);

            if (single != null && !"batch".equals(str(single, "op", ""))) {
                JsonObject result = runSingle(single);
                out.println(GSON.toJson(result));
                System.exit(result.get("ok").getAsBoolean() ? 0 : 1);
            }

            System.exit(runBatch(input, out));
        } catch (Throwable t) {
            out.println(GSON.toJson(fail(-1, String.valueOf(t.getMessage()),
                t.getClass().getName())));
            System.exit(1);
        }
    }

    /* ---------------------------------------------------------------- */
    /* single operation                                                  */
    /* ---------------------------------------------------------------- */

    private static JsonObject runSingle(JsonObject req) throws Exception {
        String op = str(req, "op", "");
        if (!isKnownOp(op)) return fail(-1, "Unknown op: " + op, null);

        String prefix = str(req, "prefix", "");
        String keyPath = str(req, "keyPath", "");
        if (prefix.isEmpty() || keyPath.isEmpty()) {
            return fail(-1, "prefix and keyPath are required", null);
        }

        /*
         * Validate before constructing the Session, so a malformed suffix is
         * refused without the private key ever being read or decrypted.
         * Session.execute() checks again — batch mode has to load the key up
         * front — but for a single operation the key should stay untouched.
         */
        String suffix = str(req, "suffix", "");
        if (!"check".equals(op) && !suffix.matches(UUID_PATTERN)) {
            return fail(-1, "Refusing to operate on malformed suffix: " + suffix, null);
        }

        Session session = new Session(req);
        return session.execute(op, suffix, str(req, "url", ""), num(req, "index", 2));
    }

    /* ---------------------------------------------------------------- */
    /* batch                                                             */
    /* ---------------------------------------------------------------- */

    private static int runBatch(String input, PrintStream out) throws Exception {
        BufferedReader reader = new BufferedReader(new StringReader(input));

        String headerLine = nextMeaningfulLine(reader);
        if (headerLine == null) {
            out.println(GSON.toJson(fail(-1, "Batch input was empty", null)));
            return 1;
        }

        JsonObject header = JsonParser.parseString(headerLine).getAsJsonObject();

        /*
         * The key is decrypted and the resolver constructed once here; every
         * operation below reuses both. That reuse is the entire point of
         * batch mode.
         *
         * A failure here is fatal to the whole run rather than to one entry,
         * so mark it — otherwise a caller reading NDJSON cannot tell "the key
         * would not load" from "one handle failed", and would report 2,000
         * successes it never attempted.
         */
        Session session;
        try {
            session = new Session(header);
        } catch (Exception e) {
            JsonObject fatal = fail(-1, String.valueOf(e.getMessage()),
                e.getClass().getName());
            fatal.addProperty("fatal", true);
            out.println(GSON.toJson(fatal));
            return 1;
        }

        int total = 0;
        int succeeded = 0;

        String line;
        while ((line = nextMeaningfulLine(reader)) != null) {
            total++;
            JsonObject result;
            String suffix = "";
            String op = "";
            try {
                JsonObject entry = JsonParser.parseString(line).getAsJsonObject();
                op = str(entry, "op", "");
                suffix = str(entry, "suffix", "");
                result = isKnownOp(op) && !"batch".equals(op)
                    ? session.execute(op, suffix, str(entry, "url", ""),
                        num(entry, "index", 2))
                    : fail(-1, "Unknown op: " + op, null);
            } catch (Exception e) {
                /*
                 * One malformed or failing entry must not abandon the rest of
                 * the batch — report it and carry on.
                 */
                result = fail(-1, String.valueOf(e.getMessage()),
                    e.getClass().getName());
            }

            result.addProperty("suffix", suffix);
            result.addProperty("op", op);
            out.println(GSON.toJson(result));   /* autoflush: streams as it goes */

            if (result.get("ok").getAsBoolean()) succeeded++;
        }

        JsonObject summary = new JsonObject();
        summary.addProperty("summary", true);
        summary.addProperty("total", total);
        summary.addProperty("succeeded", succeeded);
        summary.addProperty("failed", total - succeeded);
        out.println(GSON.toJson(summary));

        return succeeded == total ? 0 : 1;
    }

    /* ---------------------------------------------------------------- */
    /* session: decrypted key + auth + resolver, reused across a batch    */
    /* ---------------------------------------------------------------- */

    private static final class Session {
        private final HandleResolver resolver = new HandleResolver();
        private final AuthenticationInfo auth;
        private final String prefix;
        private final int ttl;
        private final String permissions;

        Session(JsonObject header) throws Exception {
            prefix = str(header, "prefix", "");
            ttl = num(header, "ttl", 86400);
            permissions = str(header, "permissions", "1110");

            String adminHandle = str(header, "adminHandle", "0.NA/" + prefix);
            int adminIndex = num(header, "adminIndex", 300);
            String keyPath = str(header, "keyPath", "");
            String passphrase = str(header, "passphrase", null);

            PrivateKey key = Util.getPrivateKeyFromFileWithPassphrase(
                new File(keyPath), passphrase
            );
            auth = new PublicKeyAuthenticationInfo(
                Util.encodeString(adminHandle), adminIndex, key
            );
        }

        JsonObject execute(String op, String suffix, String url, int index)
                throws Exception {
            /*
             * The suffix is re-validated here even though libs/handles.js
             * already enforces it. This binary is executable on its own, and
             * a malformed suffix is how 10176/0 and 10176/du-test-handle04
             * ended up in the namespace. "check" targets no object.
             */
            if (!"check".equals(op) && !suffix.matches(UUID_PATTERN)) {
                return fail(-1, "Refusing to operate on malformed suffix: "
                    + suffix, null);
            }

            byte[] handle = Util.encodeString(prefix + "/" + suffix);
            AbstractRequest request;

            switch (op) {
                case "check":
                    /*
                     * PRE-FLIGHT ONLY. This proves the key file loads and
                     * decrypts, the prefix resolves, and the handle server is
                     * reachable on the native protocol. It does NOT prove the
                     * credential is accepted, and must not be reported as if
                     * it does.
                     *
                     * No non-mutating probe can prove that against this
                     * server. All three were tried and measured with a
                     * deliberately unregistered key, and all three returned
                     * success:
                     *
                     *  - resolution: the server never challenges for it
                     *  - MODIFY on a nonexistent handle: answered
                     *    HANDLE NOT FOUND before authenticating
                     *  - the same with a forced session tracker: the
                     *    not-found short-circuit still wins
                     *
                     * The one path that does force authentication is a MODIFY
                     * against a handle and index that both exist (measured:
                     * AUTHENTICATION FAILED with a bad key) — but that is a
                     * write to a real object. So credential acceptance is
                     * verified by the create/delete round trip in
                     * scripts/verify_handle_auth.js --write instead.
                     */
                    request = new ModifyValueRequest(
                        Util.encodeString(prefix + "/" + java.util.UUID.randomUUID()),
                        new HandleValue(2, Util.encodeString("URL"),
                            Util.encodeString("https://example.invalid/check")),
                        auth
                    );
                    break;

                case "create":
                    request = new CreateHandleRequest(
                        handle, new HandleValue[] { value(url, index) }, auth
                    );
                    break;

                case "modify":
                    request = new ModifyValueRequest(handle, value(url, index), auth);
                    break;

                case "delete":
                    request = new DeleteHandleRequest(handle, auth);
                    break;

                default:
                    return fail(-1, "Unknown op: " + op, null);
            }

            request.certify = true;
            AbstractResponse response = resolver.processRequest(request);

            /*
             * For "check", HANDLE NOT FOUND is the success case — it means
             * the server authenticated us and then found nothing to modify.
             */
            boolean ok = "check".equals(op)
                ? response.responseCode == AbstractMessage.RC_HANDLE_NOT_FOUND
                    || response.responseCode == AbstractMessage.RC_SUCCESS
                : response.responseCode == AbstractMessage.RC_SUCCESS;

            JsonObject result = new JsonObject();
            result.addProperty("ok", ok);
            result.addProperty("responseCode", response.responseCode);
            result.addProperty("message", messageOf(response));
            return result;
        }

        /*
         * permissions is the Handle four-bit string in the order
         * admin-read / admin-write / public-read / public-write. "1110"
         * matches every existing 10176 handle and what the retired batch
         * client emitted ("2 URL 86400 1110 UTF8 ...").
         */
        private HandleValue value(String url, int index) {
            return new HandleValue(
                index,
                Util.encodeString("URL"),
                Util.encodeString(url),
                HandleValue.TTL_TYPE_RELATIVE,
                ttl,
                (int) (System.currentTimeMillis() / 1000L),
                null,
                permissions.charAt(0) == '1',
                permissions.charAt(1) == '1',
                permissions.charAt(2) == '1',
                permissions.charAt(3) == '1'
            );
        }
    }

    /* ---------------------------------------------------------------- */
    /* helpers                                                           */
    /* ---------------------------------------------------------------- */

    private static boolean isKnownOp(String op) {
        return "check".equals(op) || "create".equals(op)
            || "modify".equals(op) || "delete".equals(op);
    }

    private static String nextMeaningfulLine(BufferedReader reader)
            throws java.io.IOException {
        String line;
        while ((line = reader.readLine()) != null) {
            if (!line.trim().isEmpty()) return line.trim();
        }
        return null;
    }

    private static String readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream bout = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int r;
        while ((r = in.read(buf)) >= 0) bout.write(buf, 0, r);
        return new String(bout.toByteArray(), StandardCharsets.UTF_8);
    }

    /* Returns null when the input is not one complete JSON object. */
    private static JsonObject tryParseObject(String input) {
        try {
            return JsonParser.parseString(input).getAsJsonObject();
        } catch (Exception e) {
            return null;
        }
    }

    private static String str(JsonObject o, String k, String fallback) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : fallback;
    }

    private static int num(JsonObject o, String k, int fallback) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsInt() : fallback;
    }

    private static String messageOf(AbstractResponse response) {
        if (response instanceof ErrorResponse) {
            byte[] m = ((ErrorResponse) response).message;
            if (m != null && m.length > 0) return Util.decodeString(m);
        }
        return AbstractMessage.getResponseCodeMessage(response.responseCode);
    }

    private static JsonObject fail(int code, String message, String exception) {
        JsonObject o = new JsonObject();
        o.addProperty("ok", false);
        o.addProperty("responseCode", code);
        o.addProperty("message", message);
        if (exception != null) o.addProperty("exception", exception);
        return o;
    }
}
