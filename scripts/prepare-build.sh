#!/bin/sh
set -eu

MODE="${1:-}"
OUT_DIR="${2:-}"
VERSION="${3:-}"

if [ -z "$MODE" ] || [ -z "$OUT_DIR" ] || [ -z "$VERSION" ]; then
    echo "usage: $0 <dev|release> <output-dir> <version>" >&2
    exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TEMPLATE="$REPO_DIR/metadata.json.in"

case "$MODE" in
    dev)
        UUID='display-switcher-dev@skandinaff.github.com'
        NAME='Display Switch (Dev)'
        ;;
    release)
        UUID='display-switcher@skandinaff.github.com'
        NAME='Display Switch'
        ;;
    *)
        echo "unknown mode: $MODE" >&2
        exit 1
        ;;
esac

if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+$'; then
    echo "version must be an integer, got: $VERSION" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"
mkdir -p "$OUT_DIR/schemas"

for file in extension.js prefs.js README.md LICENSE; do
    cp "$REPO_DIR/$file" "$OUT_DIR/$file"
done

if [ -f "$REPO_DIR/stylesheet.css" ]; then
    cp "$REPO_DIR/stylesheet.css" "$OUT_DIR/stylesheet.css"
fi

cp "$REPO_DIR"/schemas/*.xml "$OUT_DIR/schemas/"

sed \
    -e "s|@UUID@|$UUID|g" \
    -e "s|@NAME@|$NAME|g" \
    -e "s|@VERSION@|$VERSION|g" \
    "$TEMPLATE" > "$OUT_DIR/metadata.json"

glib-compile-schemas "$OUT_DIR/schemas"
