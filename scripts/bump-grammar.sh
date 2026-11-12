#!/usr/bin/env bash
# Regenerate the parser, run grammar tests, commit grammar/ and point
# extension.toml's `rev` at that commit. Then run "zed: rebuild dev extension".
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/grammar"

npx tree-sitter generate
npx tree-sitter test

cd "$root"
git add grammar
if git diff --cached --quiet; then
  echo "No grammar changes to commit."
else
  git commit -m "${1:-Update grammar}"
fi

sha="$(git log -1 --format=%H -- grammar)"
sed -i '' -E "s/^rev = \"[0-9a-f]+\"/rev = \"$sha\"/" extension.toml
echo "extension.toml rev -> $sha"
echo "Commit extension.toml, then run 'zed: rebuild dev extension' in Zed."
