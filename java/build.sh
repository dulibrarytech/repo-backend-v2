#!/bin/sh
#
# Build DuHandleTool, the Handle.net write helper, into java/duhandletool.jar.
#
# Writes cannot go over the handle server's HTTP API — it serves no
# authentication mechanism — so libs/handle_writer.js shells out to this
# helper, which uses the official client library on the native protocol.
# See repo/HANDLES_SERVICE_REMEDIATION_PLAN.md.
#
# BUILD ON A DEVELOPMENT MACHINE, NOT THE SERVER. --release 11 emits
# bytecode the production JRE runs as-is, and repov2's host has a JRE only
# (java-11-openjdk, no -devel), so it has no javac. The jar is committed and
# travels with the checkout; the server never needs a compiler.
#
# Usage:
#   HANDLE_CLIENT_LIB=/opt/library_applications/handle-client-9.3.1/lib \
#       npm run build:handle-helper
#
# Override the compiler with JAVAC= or JAVA_HOME= if neither is on PATH.

set -eu

here=$(cd "$(dirname "$0")" && pwd)
lib=${HANDLE_CLIENT_LIB:-}

if [ -z "$lib" ]; then
    echo "HANDLE_CLIENT_LIB is not set." >&2
    echo "Point it at the handle client's lib/ directory, e.g." >&2
    echo "  HANDLE_CLIENT_LIB=/opt/library_applications/handle-client-9.3.1/lib $0" >&2
    exit 1
fi

if [ ! -d "$lib" ]; then
    echo "No such directory: $lib" >&2
    exit 1
fi

# Find a working compiler. Candidates must actually RUN, not merely exist:
# macOS ships a /usr/bin/javac stub that is executable but fails outright when
# no JDK is registered, so `command -v javac` alone is not enough.
usable() {
    [ -n "$1" ] && [ -x "$1" ] && "$1" -version >/dev/null 2>&1
}

find_javac() {
    for c in "${JAVAC:-}" \
             "${JAVA_HOME:+${JAVA_HOME}/bin/javac}" \
             "$(command -v javac 2>/dev/null || true)" \
             /opt/homebrew/opt/openjdk@17/bin/javac \
             /opt/homebrew/opt/openjdk/bin/javac \
             /usr/local/opt/openjdk@17/bin/javac \
             /usr/lib/jvm/java-11-openjdk/bin/javac \
             /usr/lib/jvm/java-17-openjdk/bin/javac; do
        usable "$c" && { echo "$c"; return 0; }
    done
    return 1
}

javac=$(find_javac) || {
    cat >&2 <<'EOF'
No javac found — this machine has a JRE but no JDK.

Do NOT install a JDK on the repov2 server just for this. Build on a
development machine instead and commit java/duhandletool.jar; --release 11
bytecode runs on the server's existing JRE unchanged.

If you do want to build here:
  RHEL/Rocky   sudo yum install java-11-openjdk-devel
  macOS        brew install openjdk@17

Or point at an existing JDK:
  JAVA_HOME=/usr/lib/jvm/java-11-openjdk ./java/build.sh
EOF
    exit 1
}

jar_cmd=$(dirname "$javac")/jar
[ -x "$jar_cmd" ] || jar_cmd=jar

out="$here/build"
jar_path="$here/duhandletool.jar"

rm -rf "$out"
mkdir -p "$out"

echo "javac: $javac"
"$javac" --release 11 -cp "$lib/*" -d "$out" "$here/DuHandleTool.java"
"$jar_cmd" cf "$jar_path" -C "$out" .

echo "Built $jar_path"
echo
echo "Set in .env on the server (the jar first, then the handle client jars):"
echo "  HANDLE_HELPER_CLASSPATH=<repov2>/java/duhandletool.jar:$lib/*"
echo
echo "Commit the jar — the server has no compiler, so it must travel with"
echo "the checkout."
