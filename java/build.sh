#!/bin/sh
#
# Build DuHandleTool, the Handle.net write helper.
#
# Writes cannot go over the handle server's HTTP API — it serves no
# authentication mechanism — so libs/handle_writer.js shells out to this
# helper, which uses the official client library on the native protocol.
# See repo/HANDLES_SERVICE_REMEDIATION_PLAN.md.
#
# Usage:
#   HANDLE_CLIENT_LIB=/opt/handle-client-9.3.1/lib ./java/build.sh
#
# --release 11 because the repov2 host runs OpenJDK 11; building on a newer
# JDK without it produces class files that host cannot load.

set -eu

here=$(cd "$(dirname "$0")" && pwd)
lib=${HANDLE_CLIENT_LIB:-}

if [ -z "$lib" ]; then
    echo "HANDLE_CLIENT_LIB is not set." >&2
    echo "Point it at the handle client's lib/ directory, e.g." >&2
    echo "  HANDLE_CLIENT_LIB=/opt/handle-client-9.3.1/lib $0" >&2
    exit 1
fi

if [ ! -d "$lib" ]; then
    echo "No such directory: $lib" >&2
    exit 1
fi

javac=${JAVAC:-javac}
out="$here/build"

mkdir -p "$out"
"$javac" --release 11 -cp "$lib/*" -d "$out" "$here/DuHandleTool.java"

echo "Built $out/DuHandleTool.class"
echo
echo "Set in .env:"
echo "  HANDLE_HELPER_CLASSPATH=$out:$lib/*"
