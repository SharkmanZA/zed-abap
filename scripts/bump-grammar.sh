#!/usr/bin/env bash
# Regenerate the parser, run the grammar tests, check that every Zed query
# still compiles against it, commit grammar/ (only grammar/) and point
# extension.toml's `rev` at that commit (committing only extension.toml).
# Then git push and run "zed: rebuild dev extension" in Zed.
#
# Usage: scripts/bump-grammar.sh ["commit message"]   (from any directory)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/grammar"

[ -d node_modules ] || npm install
npx tree-sitter generate
npx tree-sitter test

# tree-sitter test doesn't look at languages/abap/*.scm, and in Zed a single
# invalid query stops the whole language from loading.
for query in "$root"/languages/abap/*.scm; do
  if ! npx tree-sitter query --quiet "$query" "$root/examples/sample.abap" >/dev/null; then
    echo "Query failed to compile: $query" >&2
    exit 1
  fi
done

cd "$root"
git add -- grammar
if git diff --cached --quiet -- grammar; then
  echo "No grammar changes to commit."
else
  git commit -m "${1:-Update grammar}" -- grammar
fi

sha="$(git log -1 --format=%H -- grammar)"
# Portable in-place edit (BSD and GNU sed disagree on -i).
tmp="$(mktemp)"
sed -E "s/^rev = \"[0-9a-f]+\"/rev = \"$sha\"/" extension.toml > "$tmp"
cat "$tmp" > extension.toml
rm -f "$tmp"

if git diff --quiet -- extension.toml; then
  echo "extension.toml already at $sha"
else
  git commit -m "Bump grammar rev to ${sha:0:7}" -- extension.toml
  echo "extension.toml rev -> $sha"
fi
echo "Now git push, then run 'zed: rebuild dev extension' in Zed (Zed fetches rev from GitHub)."
