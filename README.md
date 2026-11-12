# zed-abap

ABAP language support for [Zed](https://zed.dev): syntax highlighting, outline / symbol search, bracket matching and comment toggling.

```
zed-abap/
├── extension.toml          # Zed extension manifest (points at grammar/ by commit SHA)
├── languages/abap/
│   ├── config.toml         # file types, comments, brackets
│   ├── highlights.scm      # highlighting
│   ├── outline.scm         # REPORT / PROGRAM / CLASS / INTERFACE / METHOD / FORM / FUNCTION / MODULE
│   ├── brackets.scm
│   └── overrides.scm       # string/comment scopes for bracket auto-closing
├── grammar/                # tree-sitter-abap
│   ├── grammar.js
│   ├── src/scanner.c       # column-0 `*` comments, `meth( ` call parens
│   └── test/corpus/
├── examples/sample.abap    # highlighting showcase (not meant to compile)
└── scripts/bump-grammar.sh
```

## Install locally

1. In Zed, open the command palette and run **`zed: install dev extension`**.
2. Pick this folder.
3. Open `examples/sample.abap`.

Zed checks out the grammar at the `rev` in `extension.toml` and compiles it to WASM into `grammars/` (git-ignored). Check **`zed: open log`** if anything fails.

## Working on the grammar

All commands below run from the repo root.

```sh
(cd grammar && npm install)                                  # once
(cd grammar && npx tree-sitter generate && npx tree-sitter test)
(cd grammar && npx tree-sitter parse ../examples/sample.abap)
(cd grammar && npx tree-sitter query ../languages/abap/highlights.scm ../examples/sample.abap)
```

Zed builds the grammar from a **commit**, not your working tree. After changing `grammar.js` or `scanner.c`:

```sh
scripts/bump-grammar.sh "Describe the grammar change"
```

The script regenerates the parser, runs the corpus tests, and checks that every `languages/abap/*.scm` query still compiles. A broken query stops the whole language loading in Zed. It then commits **only** `grammar/`, updates `rev` in `extension.toml`, and commits only that file. After that, run **`zed: rebuild dev extension`**.

Query (`.scm`) and `config.toml` changes only need the rebuild, plus a normal commit.

## Grammar source: local path vs GitHub

`[grammars.abap].repository` in `extension.toml` is a `file://` URL to this folder on this machine. That's convenient for local development, but it only works here.

When you switch it to the GitHub URL (or move the folder), **delete the existing clone first**:

```sh
rm -rf grammars/abap
```

Otherwise `zed: rebuild dev extension` fails with "grammar directory … already exists, but is not a git clone of …".

## Design notes

- **Mostly flat grammar.** A file is a list of statements, and each statement is a list of tokens ending in `.`. ABAP keywords aren't reserved and are case-insensitive, so most keyword colouring happens in `highlights.scm` with `(?i)` regexes. This keeps the parser tolerant of real code, including chained statements, macros and old syntax.
- **Small structures where highlighting needs them.** These are `member_access` (`a->b`, `c=>d`, `i~m`), `call` (`meth( `, with a blank after the paren, per ABAP rules), `access` (`lv(4)`, `DATA(x)`, `e001(zmsg)`), `type_spec` / `ref_type` / `table_type` (`TYPE x`, `REF TO x`, `TABLE OF x`) and `constructor_expression` (`NEW zcl( )`, `CONV string( )`). Without them, the queries would need sibling patterns that scan whole statements. Those were measured at ~10 ms per 50-row chunk inside a 5,000-line `DATA:` chain, and dropped highlights. With the structures it's ~0.1–0.25 ms.
- **Grammar keywords** (TYPE, REF, TO, TABLE, RANGE, OF and the constructor keywords) are recognised in lower, UPPER and Capitalised spelling. Tree-sitter keyword extraction only works with string literals. Other casings still parse, as plain names.
- **Highlight precedence.** In Zed, when several patterns capture the same node, the later pattern wins, so `highlights.scm` is ordered general → specific.
- **Hyphens bind to names.** ABAP requires spaces around `-` as an operator, so `ls_x-field`, `sy-subrc` and `END-OF-SELECTION` each lex as one `name`.
- **Comment toggling uses `"` only.** `*` comments must start in column 0, but Zed matches comment prefixes after indentation, so `* factor` continuation lines would be treated as comments.

## Ideas / next steps

- Block structure (IF/ENDIF, METHOD/ENDMETHOD) for code folding, a nested outline and auto-indent.
- abaplint language server for diagnostics.

## Publishing

After pushing to GitHub:

- Replace `OWNER` in `extension.toml` and `grammar/tree-sitter.json`.
- Switch `[grammars.abap].repository` to the GitHub URL (see above).
- Add a LICENSE file to match the MIT licence declared in `grammar/package.json`.
