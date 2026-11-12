# zed-abap

ABAP language support for [Zed](https://zed.dev): syntax highlighting, outline / symbol search, bracket matching and comment toggling.

```
zed-abap/
├── extension.toml          # Zed extension manifest (points at grammar/ by commit SHA)
├── languages/abap/
│   ├── config.toml         # file types, comments, brackets
│   ├── highlights.scm      # highlighting (keywords matched case-insensitively)
│   ├── outline.scm         # REPORT / CLASS / METHOD / FORM / FUNCTION / MODULE
│   └── brackets.scm
├── grammar/                # tree-sitter-abap
│   ├── grammar.js
│   ├── src/scanner.c       # column-0 `*` comments
│   └── test/corpus/
├── examples/sample.abap
└── scripts/bump-grammar.sh
```

## Install locally

1. In Zed, open the command palette and run **`zed: install dev extension`**.
2. Pick this folder.
3. Open `examples/sample.abap`.

Zed checks out the grammar at the `rev` in `extension.toml` and compiles it to WASM. Check **`zed: open log`** if anything fails.

## Working on the grammar

```sh
cd grammar
npm install
npx tree-sitter generate                    # after editing grammar.js
npx tree-sitter test                        # corpus in test/corpus/
npx tree-sitter parse ../examples/sample.abap
npx tree-sitter query ../languages/abap/highlights.scm ../examples/sample.abap
```

Zed builds the grammar from a **commit**, not your working tree. After grammar changes:

```sh
scripts/bump-grammar.sh "Describe the change"   # generate + test + commit + update rev
git commit -am "Bump grammar rev"
```

Then run **`zed: rebuild dev extension`**. Query (`.scm`) and `config.toml` changes only need the rebuild.

## Design notes

- **Flat grammar.** A file is a list of statements, and each statement is a list of tokens ending in `.`. ABAP keywords aren't reserved and are case-insensitive, so keyword recognition happens in `highlights.scm` with `(?i)` regexes rather than in the parser. This makes the parser very tolerant of real code, including chained statements, macros and old syntax.
- **Highlight precedence.** In Zed, when several patterns capture the same node, the later pattern wins, so `highlights.scm` is ordered general → specific.
- **Hyphens bind to names.** ABAP requires spaces around `-` as an operator, so `ls_x-field`, `sy-subrc` and `END-OF-SELECTION` each lex as one `name`.

## Ideas / next steps

- Block structure (IF/ENDIF, METHOD/ENDMETHOD) for code folding, nested outline and auto-indent.
- Distinguish declarations (`DATA x`, `METHODS m`) for better outline and highlighting.
- abaplint language server for diagnostics.

## Publishing

Once pushed to GitHub, change `[grammars.abap].repository` in `extension.toml` to the GitHub URL.
