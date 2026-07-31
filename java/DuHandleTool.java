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
 * PROTOCOL
 *
 * One JSON request object on stdin, one JSON result object on stdout.
 *
 *   in  {"op":"create","prefix":"10176","suffix":"<uuid>","url":"https://…",
 *        "index":2,"ttl":86400,"permissions":"1110",
 *        "adminHandle":"0.NA/10176","adminIndex":300,
 *        "keyPath":"/path/admpriv.bin","passphrase":"…"}
 *   out {"ok":true,"responseCode":1,"message":"SUCCESS"}
 *
 * ops: create | modify | delete   ("check" authenticates only, writes nothing)
 *
 * Exit status is 0 when the operation succeeded, 1 otherwise; callers
 * should read responseCode rather than relying on exit status alone.
 *
 * BUILD (target 11 — the repov2 host runs OpenJDK 11):
 *   javac --release 11 -cp "handle-client-9.3.1/lib/*" \
 *         -d java/build java/DuHandleTool.java
 */

import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintStream;
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

    public static void main(String[] args) {
        /*
         * Everything is written to stdout as JSON, including failures, so
         * the Node caller never has to parse a stack trace. Anything the
         * library prints to stderr is left alone for operators.
         */
        PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);
        try {
            JsonObject req = JsonParser.parseReader(
                new InputStreamReader(System.in, StandardCharsets.UTF_8)
            ).getAsJsonObject();

            JsonObject result = run(req);
            out.println(new Gson().toJson(result));
            System.exit(result.get("ok").getAsBoolean() ? 0 : 1);
        } catch (Throwable t) {
            JsonObject err = new JsonObject();
            err.addProperty("ok", false);
            err.addProperty("responseCode", -1);
            err.addProperty("message", String.valueOf(t.getMessage()));
            err.addProperty("exception", t.getClass().getName());
            out.println(new Gson().toJson(err));
            System.exit(1);
        }
    }

    private static String str(JsonObject o, String k, String fallback) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : fallback;
    }

    private static int num(JsonObject o, String k, int fallback) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsInt() : fallback;
    }

    private static JsonObject run(JsonObject req) throws Exception {
        String op = str(req, "op", "");
        String prefix = str(req, "prefix", "");
        String suffix = str(req, "suffix", "");
        String adminHandle = str(req, "adminHandle", "0.NA/" + prefix);
        int adminIndex = num(req, "adminIndex", 300);
        String keyPath = str(req, "keyPath", "");
        String passphrase = str(req, "passphrase", null);

        if (!op.equals("check") && !op.equals("create")
                && !op.equals("modify") && !op.equals("delete")) {
            return fail(-1, "Unknown op: " + op);
        }
        if (prefix.isEmpty() || keyPath.isEmpty()) {
            return fail(-1, "prefix and keyPath are required");
        }

        /*
         * The suffix is re-validated here even though libs/handles.js
         * already enforces it. This binary is executable on its own, and a
         * malformed suffix is how 10176/0 and 10176/du-test-handle04 ended
         * up in the namespace. "check" targets the admin handle, not an
         * object, so it carries no suffix.
         */
        if (!"check".equals(op)
                && !suffix.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
                        + "-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) {
            return fail(-1, "Refusing to operate on malformed suffix: " + suffix);
        }

        PrivateKey key = Util.getPrivateKeyFromFileWithPassphrase(
            new File(keyPath), passphrase
        );
        AuthenticationInfo auth = new PublicKeyAuthenticationInfo(
            Util.encodeString(adminHandle), adminIndex, key
        );

        byte[] handle = Util.encodeString(prefix + "/" + suffix);
        HandleResolver resolver = new HandleResolver();

        AbstractRequest request;
        switch (op) {
            case "check":
                /*
                 * Prove the credential without writing anything.
                 *
                 * Resolution would be a false positive: the server never
                 * challenges for it, so a resolve succeeds even when the
                 * key does not match the HS_PUBKEY on the admin handle.
                 * Instead attempt a MODIFY against a randomly generated
                 * suffix that cannot exist. MODIFY creates nothing, so the
                 * only outcomes are:
                 *
                 *   RC_HANDLE_NOT_FOUND  -> the credential was accepted
                 *   RC_INVALID_ADMIN /
                 *   RC_AUTHENTICATION_*  -> the credential was rejected
                 *
                 * which is exactly the distinction we need.
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
                    handle, new HandleValue[] { valueFrom(req) }, auth
                );
                break;

            case "modify":
                request = new ModifyValueRequest(handle, valueFrom(req), auth);
                break;

            case "delete":
                request = new DeleteHandleRequest(handle, auth);
                break;

            default:
                return fail(-1, "Unknown op: " + op);
        }

        request.certify = true;
        AbstractResponse response = resolver.processRequest(request);

        /*
         * For "check", HANDLE NOT FOUND is the success case — it means the
         * server authenticated us and then found nothing to modify. Only
         * an auth-class response code counts as failure.
         */
        boolean ok;
        if (op.equals("check")) {
            ok = response.responseCode == AbstractMessage.RC_HANDLE_NOT_FOUND
                || response.responseCode == AbstractMessage.RC_SUCCESS;
        } else {
            ok = response.responseCode == AbstractMessage.RC_SUCCESS;
        }

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
    private static HandleValue valueFrom(JsonObject req) {
        String url = str(req, "url", "");
        int index = num(req, "index", 2);
        int ttl = num(req, "ttl", 86400);
        String perms = str(req, "permissions", "1110");

        return new HandleValue(
            index,
            Util.encodeString("URL"),
            Util.encodeString(url),
            HandleValue.TTL_TYPE_RELATIVE,
            ttl,
            (int) (System.currentTimeMillis() / 1000L),
            null,
            perms.charAt(0) == '1',
            perms.charAt(1) == '1',
            perms.charAt(2) == '1',
            perms.charAt(3) == '1'
        );
    }

    private static String messageOf(AbstractResponse response) {
        if (response instanceof ErrorResponse) {
            byte[] m = ((ErrorResponse) response).message;
            if (m != null && m.length > 0) {
                return Util.decodeString(m);
            }
        }
        return AbstractMessage.getResponseCodeMessage(response.responseCode);
    }

    private static JsonObject fail(int code, String message) {
        JsonObject o = new JsonObject();
        o.addProperty("ok", false);
        o.addProperty("responseCode", code);
        o.addProperty("message", message);
        return o;
    }
}
