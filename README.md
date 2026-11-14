# zed-abap

[![CI](https://github.com/SharkmanZA/zed-abap/actions/workflows/ci.yml/badge.svg)](https://github.com/SharkmanZA/zed-abap/actions/workflows/ci.yml)

ABAP language support for [Zed](https://zed.dev): syntax highlighting, a nested outline / symbol search, auto-indent, code folding, bracket matching, comment toggling, Vim text objects, [abaplint](https://abaplint.org) diagnostics and an optional file icon theme.

<p align="center"><img src="docs/images/highlighting.png" alt="examples/sample.abap open in Zed with ABAP syntax highlighting" width="700"></p>

> [!NOTE]
> **This project is "vibe coded".** The grammar, scanner, queries, scripts and docs were written by [Claude Code](https://claude.com/claude-code) (Anthropic's AI coding agent) from plain-language direction, not by hand.
> It was also **reviewed entirely by Claude**: multi-agent Claude code reviews of every change, with the findings fixed. Testing was a tree-sitter test corpus, real SAP standard code, a benchmark of Zed's highlighting path, and a port of Zed's auto-indent algorithm run against SAP's own formatting.
> Expect rough edges, and please open an issue if some ABAP doesn't parse or highlight correctly.

```
zed-abap/
├── extension.toml          # Zed extension manifest (points at grammar/ by commit SHA)
├── abaplint.json           # abaplint config for examples/
├── Cargo.toml, src/lib.rs  # extension code: installs and starts the abaplint server
├── server/                 # abaplint language server (Node, @abaplint/core)
│   ├── server.js
│   └── test/               # LSP round-trip tests: npm test
├── languages/abap/
│   ├── config.toml         # file types, comments, brackets
│   ├── highlights.scm      # highlighting
│   ├── outline.scm         # nested: CLASS > METHOD, CLASS DEFINITION > METHODS / DATA, FORM, ...
│   ├── indents.scm         # auto-indent from block structure
│   ├── textobjects.scm     # Vim: ]m / af / if (methods, forms), ]] / ac / ic (classes)
│   ├── injections.scm      # SQLScript in AMDP methods → SQL highlighting (if installed)
│   ├── brackets.scm
│   └── overrides.scm       # string/comment scopes for bracket auto-closing
├── icon_themes/abap.json   # "Zed (Default) + ABAP" icon theme
├── icons/abap.svg          # its icon
├── grammar/                # tree-sitter-abap
│   ├── grammar.js
│   ├── src/scanner.c       # column-0 `*` comments, `meth( ` call parens, AMDP bodies,
│   │                       # CATCH SYSTEM-EXCEPTIONS, SELECT loops, AT events, event ends
│   └── test/corpus/
├── examples/
│   ├── sample.abap         # highlighting showcase (not meant to compile)
│   └── icons-demo/         # small abapGit package, used for the README screenshots
├── docs/images/            # README screenshots
├── .github/workflows/ci.yml # checks for pull requests (see Continuous integration)
└── scripts/bump-grammar.sh
```

## Install locally

1. Install Rust with [rustup](https://rustup.rs). Zed compiles the extension's `src/lib.rs` to WASM, which needs a rustup toolchain (not Homebrew's Rust).
2. In Zed, open the command palette and run **`zed: install dev extension`**.
3. Pick this folder.
4. Open `examples/sample.abap`.

Zed checks out the grammar at the `rev` in `extension.toml` and compiles it to WASM into `grammars/` (git-ignored). Check **`zed: open log`** if anything fails.

## File icons

The extension also ships an icon theme, **Zed (Default) + ABAP**. It is Zed's default icon theme plus an icon for ABAP files. Turn it on with **`icon theme selector: toggle`**, or in `settings.json`:

```json
"icon_theme": "Zed (Default) + ABAP"
```

If your `icon_theme` setting follows the system appearance (`{ "mode": "system", "light": …, "dark": … }`), the selector only fills the slot for the current mode, so set both `light` and `dark` to `"Zed (Default) + ABAP"`. The icon is drawn to read on light and dark backgrounds.

If the theme isn't listed, run **`zed: rebuild dev extension`**: Zed registers icon themes when it builds the extension, and the same applies after changing `icon_themes/` or `icons/`.

<p align="center"><img src="docs/images/file-icons.png" alt="Zed project panel with the ABAP icon on .abap files" width="320"></p>

Every `.abap` file (in lower or UPPER case) gets a blue **A.** tile, `icons/abap.svg`. Zed shows one icon theme at a time, so choosing this one replaces any other icon theme you use. Every non-ABAP file keeps Zed's default icon: Zed merges its default file associations into extension icon themes and falls back to its default icons for anything the theme doesn't draw.

## abaplint diagnostics

The extension runs [abaplint](https://abaplint.org) as a language server, so its findings show as diagnostics while you type. Each one names its rule and links to the rule's documentation at [rules.abaplint.org](https://rules.abaplint.org).

On first use the extension installs the server's npm packages with Zed's own Node into Zed's extension work directory, so nothing is installed globally. `@abaplint/core` (the parser and rules) is updated to its latest version when Zed starts, so new ABAP syntax and rule fixes arrive without an extension update. The server's other packages are pinned in `server/package.json`.

**Configuration** works like the abaplint CLI. The server reads `abaplint.json`, `abaplint.jsonc` or `abaplint.json5` from the root of the folder you open in Zed. Without one (or if it can't be used) the server reports errors only: abaplint's default settings with just the rules `parser_error`, `check_syntax`, `unknown_types`, `implement_methods`, `method_implemented_twice`, `superclass_final`, `cyclic_oo`, `check_include` and `xml_consistency`. abaplint's style rules (naming, keyword case and so on) need a config that turns them on. `npx @abaplint/cli -d` prints abaplint's full default config, with every rule, to start from. A minimal config:

```json
{
  "global": { "files": "/src/**/*.*" },
  "syntax": { "version": "v757", "errorNamespace": "^(Z|Y|LCL_|TY_|LIF_)" },
  "rules": { "parser_error": true, "check_syntax": true }
}
```

This repository's own [`abaplint.json`](abaplint.json) covers `examples/` and adds a few style rules.

Config changes are picked up without a restart.

- **Projects.** The files matching `global.files` (relative to the root, default `/src/**/*.*`) are loaded together, abapGit style (`zcl_x.clas.abap`, `zcl_x.clas.xml`, `ztab.tabl.xml`, …). References between your objects resolve, and a change to one object rechecks the others you have open. An include's errors are found by checking the programs that include it. `exclude` and `noIssues` patterns are regular expressions matched against absolute paths, as in the CLI; if one isn't a valid regex, the server warns and uses the default config. Symlinks are followed and folders starting with `.` are skipped. Open the folder that holds `abaplint.json` (usually the repository) in Zed: the server doesn't look for a config in subfolders.
- **Dependencies.** `dependencies` entries with a local `folder` are loaded before the project, so an object in both is the project's. Their files aren't checked when you open them. Git `url` dependencies (and `useApackDependencies`) aren't cloned: clone them yourself and point `folder` at the clone.
- **Files outside `global.files`.** Opening an abapGit-named file outside `global.files` also loads the objects in its abapGit package folder: the top folder of its chain of folders with a `package.devc.xml`, subpackages included, or just its own folder if it has no `package.devc.xml`. References to the objects next to it then resolve without a config, and those files follow the disk like project files. A copy of an object the project already has (a backup, say) is checked on its own instead.
- **Files without an abapGit name** (`sample.abap`) are checked on their own, as a program, with the folder's config.
- **Only diagnostics.** abaplint can also do hover, go to definition, formatting, quick fixes and rename. Those aren't wired up yet.
- **Turning it off:** `"languages": { "ABAP": { "language_servers": ["!abaplint", "..."] } }` in `settings.json`.
- **Running another build of the server:** `"lsp": { "abaplint": { "binary": { "path": "node", "arguments": ["/path/to/server/server.js", "--stdio"] } } }` runs that command instead of the installed server (run `npm install` in its folder first). The server's log is under **`dev: open language server logs`**.

## Working on the abaplint server

```sh
(cd server && npm install && npm test)             # LSP round-trip tests
cargo build --release --target wasm32-wasip2       # the extension, as Zed builds it
```

`src/lib.rs` embeds `server/server.js` at build time, so run **`zed: rebuild dev extension`** after changing it. The extension installs the versions in `server/package.json`, so keep them exact and run `npm install` to update `package-lock.json` when you change them.

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

The script regenerates the parser, runs the corpus tests, and checks that every `languages/abap/*.scm` query still compiles. A broken query stops the whole language loading in Zed. It then commits **only** `grammar/`, updates `rev` in `extension.toml`, and commits only that file.

Zed fetches that commit from GitHub, so **`git push`** before running **`zed: rebuild dev extension`**.

Query (`.scm`), `config.toml`, icon theme and icon changes only need the rebuild, plus a normal commit.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request into `main` and every push to `main`:

- `grammar/src` is regenerated and must match what's committed, and the corpus tests must pass.
- Every `languages/abap/*.scm` query must compile, the examples must parse without errors, and the scanner must compile without warnings.
- `extension.toml`'s `rev` must be in the branch's history and its `grammar/` must match the current one. A forgotten `scripts/bump-grammar.sh`, or a squash / rebase merge of a grammar change, fails here.
- `extension.toml`, `config.toml` and the icon theme must be valid, and every icon the theme names must exist.

## Grammar source: GitHub vs local path

`[grammars.abap].repository` points at `https://github.com/SharkmanZA/zed-abap`. The repo is private, so Zed's `git fetch` uses your normal git credentials (osxkeychain).

To iterate on the grammar without pushing, point it at this folder instead, e.g. `file:///Users/Work/Documents/Personal/Projects/zed-abap`. Don't commit that.

Whenever you change `repository`, **delete the existing clone first**:

```sh
rm -rf grammars/abap
```

Otherwise `zed: rebuild dev extension` fails with "grammar directory … already exists, but is not a git clone of …".

## Block structure

The grammar parses ABAP's statement blocks, which drive the nested outline, auto-indent and text objects:

<p align="center"><img src="docs/images/outline.png" alt="Zed symbol search (cmd-shift-o) listing declarations and methods nested under their class" width="700"></p>

<!-- Screenshot: uncomment once docs/images/auto-indent.gif exists (see docs/images/README.md).
<img src="docs/images/auto-indent.gif" alt="Typing IF, ELSE and ENDIF in Zed with automatic indentation" width="600">
-->

| Block | Clauses |
| --- | --- |
| `IF` … `ENDIF` | `ELSEIF`, `ELSE` |
| `CASE` … `ENDCASE` | `WHEN` |
| `TRY` … `ENDTRY` | `CATCH`, `CLEANUP` |
| `LOOP`, `DO`, `WHILE` | |
| `SELECT` … `ENDSELECT` (loops only, see below) | |
| `AT FIRST` / `AT LAST` / `AT NEW` / `AT END OF` … `ENDAT` | |
| `METHOD`, `FORM`, `FUNCTION`, `MODULE` | |
| `CLASS … DEFINITION` … `ENDCLASS` | `PUBLIC` / `PROTECTED` / `PRIVATE SECTION` |
| `CLASS … IMPLEMENTATION`, `INTERFACE` | |
| `CATCH SYSTEM-EXCEPTIONS` … `ENDCATCH` | |
| Events: `LOAD-OF-PROGRAM`, `INITIALIZATION`, `AT SELECTION-SCREEN …`, `START-OF-SELECTION`, `END-OF-SELECTION`, `TOP-OF-PAGE`, `END-OF-PAGE`, `AT LINE-SELECTION`, `AT USER-COMMAND`, `AT PFnn` | (no closing statement) |

AMDP methods (`METHOD m BY DATABASE PROCEDURE …`) are blocks whose body is kept as raw SQLScript (its statements end in `;`, not `.`).

**SELECT loops.** Only a SELECT that needs `ENDSELECT` opens a block. The scanner reads the whole statement to decide: a SELECT is a loop unless it is `SELECT SINGLE`, writes `INTO` / `APPENDING [CORRESPONDING FIELDS OF] TABLE` (without `PACKAGE SIZE`), selects only aggregates without `GROUP BY` (`COUNT(*)`, `COALESCE( MAX( a ), 0 )`, `SUM( a ) + SUM( b )`: one row), or is native SQL inside `EXEC SQL`. Strings, templates and comments in the statement are ignored.

**Event blocks** have no closing statement: each one runs until the next event, `FORM`, `CLASS`, `INTERFACE`, `MODULE`, `FUNCTION` or `METHOD`, or the end of the file. They appear in the outline, and `]m` / `af` / `if` work on them like on FORMs. Event keywords are recognised in any casing, but only when a period follows (`START-OF-SELECTION.`), so a method or variable called `initialization` is unaffected. Logical-database `GET node` events aren't recognised (they can't be told from `GET TIME`, `GET REFERENCE`, … cheaply). While typing, a `FORM` below an unclosed `IF` or `LOOP` in an event is taken as part of that block until you close it, like an `ENDMETHOD` below an unclosed `IF`.

- **Folding.** Zed folds by indentation, so blocks fold as long as they're indented, and auto-indent keeps new code indented.
- **Auto-indent.** Statements inside a block are indented one level (2 spaces). `ELSE`, `WHEN`, `CATCH`, `… SECTION` and every `END…` line up with the statement that opened them as you type them, including after empty clauses and after commented-out `*` lines. Pressing Enter after an opening statement (`IF x.`) or at the end of a clause body keeps you at the body's indentation. Event blocks (`START-OF-SELECTION.`, `AT SELECTION-SCREEN …`) indent their statements, and the next event, `FORM` or `CLASS` goes back to column 0. In the last event of a file, new lines keep the indentation of the line above. Measured against SAP's own formatting of standard code, the suggested indent matches on 91–100% of statement lines per file (excluding continuation lines of multi-line statements).
- **Not identical to the SAP pretty printer.** New `CATCH` lines line up with `TRY`, like `ELSE` with `IF`. The pretty printer indents a TRY body by 4 and `CATCH` by 2, which Zed can't express, because it indents one level relative to the previous line. `ENDTRY` still lines up with `TRY` in pretty-printed code. Continuation lines of multi-line statements keep the previous line's indent.
- **Not modelled as blocks:** `DEFINE … END-OF-DEFINITION`, `ON CHANGE OF … ENDON`, `PROVIDE … ENDPROVIDE`, `EXEC SQL … ENDEXEC`, `WITH … ENDWITH` and similar. Their closing lines still outdent.

## Design notes

- **Mostly flat grammar.** A file is a list of statements, and each statement is a list of tokens ending in `.`. ABAP keywords aren't reserved and are case-insensitive, so most keyword colouring happens in `highlights.scm` with `(?i)` regexes. This keeps the parser tolerant of real code, including chained statements, macros and old syntax.
- **Small structures where highlighting needs them.** These are `member_access` (`a->b`, `c=>d`, `i~m`), `call` (`meth( `, with a blank after the paren, per ABAP rules), `access` (`lv(4)`, `DATA(x)`, `e001(zmsg)`), `type_spec` / `ref_type` / `table_type` (`TYPE x`, `REF TO x`, `TABLE OF x`) and `constructor_expression` (`NEW zcl( )`, `CONV string( )`). Without them, the queries would need sibling patterns that scan whole statements. Those were measured at ~10 ms per 50-row chunk inside a 5,000-line `DATA:` chain, and dropped highlights. With the structures it's ~0.1–0.25 ms.
- **Grammar keywords** (TYPE, REF, TO, TABLE, RANGE, OF and the constructor keywords) are recognised in lower, UPPER and Capitalised spelling. Tree-sitter keyword extraction only works with string literals. Other casings still parse, as plain names.
- **Grammar keywords are still plain names where only an identifier fits.** Method, attribute, call and access names can be anything: `lo->value`, `zcl=>new( )`, `METHOD zif~ref.`
- **Data objects after TYPE.** Some statements take a variable after TYPE (`MESSAGE lv TYPE lv_msgty`, `DESCRIBE FIELD lv TYPE lv_type`). Telling them apart would need a scan of the whole statement, so names following the usual convention (`lv_`, `ls_`, `lt_`, `lo_`, `gv_`, `mv_`, `iv_`, …, `sy-`) are coloured as variables there instead of types.
- **Highlight precedence.** In Zed, when several patterns capture the same node, the later pattern wins, so `highlights.scm` is ordered general → specific.
- **Hyphens bind to names.** ABAP requires spaces around `-` as an operator, so `ls_x-field`, `sy-subrc` and `END-OF-SELECTION` each lex as one `name`.
- **Blocks open only on a keyword at the start of a statement.** `IF`, `WHEN`, `METHOD`, … anywhere else are ordinary words: `CALL METHOD`, `COND #( WHEN … )`, `FOR … WHILE`, `lo->method( )`.
- **Blocks tolerate unbalanced code.** Closing statements are optional, so an IF you haven't closed yet doesn't turn the rest of the file into a parse error. Any `END…` closes, and any clause keyword (`ELSE`, `WHEN`, `CATCH`, …) continues, the innermost open block. In valid ABAP that is always the matching one. Accepting them in every block also keeps parser generation under ~2 s, where tracking which block accepts which keyword grew combinatorially with the number of block types. The side effect only shows while typing unbalanced code: an `ENDMETHOD` below an unclosed `IF` closes the `IF` until you add the `ENDIF`. An `END…` with no open block at all is an ordinary statement.
- **Block keywords are still usable as names.** `method = 'GET'.`, `form->run( ).`, `do( ).` and `DATA method TYPE string.` are ordinary statements about variables or methods with those names.
- **Comment toggling uses `"` only.** `*` comments must start in column 0, but Zed matches comment prefixes after indentation, so `* factor` continuation lines would be treated as comments.

## License

MIT, see [LICENSE](LICENSE).
