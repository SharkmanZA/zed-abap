// External scanner for ABAP.
//
// COMMENT:    a `*` in the first column comments out the rest of the line. A
//             `*` anywhere else is an operator (`SELECT *`, `a * b`), which a
//             regex can't distinguish, so we check the column here. Returning
//             false hands control back to the internal lexer, which also lexes
//             `"` comments.
//
// CALL_OPEN:  the `(` of a functional call. ABAP requires the `(` to follow the
//             name directly and to be followed by a blank or `)`:
//             `meth( x )`, `meth( )`. A `(` followed by anything else is
//             offset/length or an inline declaration (`lv(4)`, `DATA(x)`) and
//             is left to the internal lexer.
//
// SQLSCRIPT:  the body of an AMDP method (`METHOD m BY DATABASE PROCEDURE ...`),
//             taken raw up to (not including) the line whose first word is
//             ENDMETHOD. SQLScript statements end in `;`, so the ABAP grammar
//             can't parse them.
//
// CATCH_SYSTEM_EXCEPTIONS: `CATCH SYSTEM-EXCEPTIONS` in any casing, so it opens
//             its own block instead of a TRY `CATCH` clause. Telling the two
//             apart needs the word after CATCH, which the parser can't see.
//
// SELECT_LOOP: the SELECT of a SELECT statement that needs ENDSELECT. A loop
//             and a single SELECT start alike, so this reads ahead to the
//             statement's period (skipping strings, templates and comments)
//             and only emits the token for a loop: a SELECT with a FROM that
//             is not SELECT SINGLE, not INTO / APPENDING [CORRESPONDING
//             FIELDS OF] TABLE (unless PACKAGE SIZE is given), not a select
//             list of aggregates only (`COUNT(*)`, `COALESCE( MAX( a ), 0 )`,
//             `SUM( a ) + SUM( b )`) without GROUP BY, which is one row, and
//             not native SQL (`EXEC SQL. SELECT ... ENDEXEC.`, which contains
//             ENDEXEC). Otherwise the SELECT is left to the internal lexer
//             and the statement stays an ordinary one.
//
// AT_EVENT:   the AT of AT SELECTION-SCREEN / LINE-SELECTION / USER-COMMAND /
//             PFnn, which start event blocks. Every other AT at the start of
//             a statement opens an AT ... ENDAT block.
//
// EVENT_KEYWORD: INITIALIZATION, START-OF-SELECTION, END-OF-SELECTION,
//             TOP-OF-PAGE, END-OF-PAGE and LOAD-OF-PROGRAM, in any casing,
//             when a period follows (or DURING, for TOP-OF-PAGE). Only then:
//             `initialization( ).` or `initialization = 1.` in a method is
//             an ordinary statement.
//
// EVENT_END:  an empty token before FORM / CLASS / INTERFACE / MODULE /
//             FUNCTION / METHOD followed by a name (or `:`), which ends an
//             event block (START-OF-SELECTION, ...). Inside the block those
//             words could also start a statement (`form( ).`), which the
//             parser can't rule out with one token of lookahead. Only in the
//             spellings the grammar's keywords use (lower, UPPER,
//             Capitalised): in others the keyword wouldn't follow.
//
// ERROR_SENTINEL is never used by a grammar rule, so it is only ever valid
// during error recovery, when tree-sitter marks every symbol valid. In that
// state we don't emit the context-dependent tokens.

#include "tree_sitter/parser.h"

enum TokenType {
  COMMENT, CALL_OPEN, ERROR_SENTINEL, SQLSCRIPT, CATCH_SYSTEM_EXCEPTIONS, SELECT_LOOP, AT_EVENT,
  EVENT_END, EVENT_KEYWORD,
};

void *tree_sitter_abap_external_scanner_create(void) { return NULL; }
void tree_sitter_abap_external_scanner_destroy(void *payload) {}
unsigned tree_sitter_abap_external_scanner_serialize(void *payload, char *buffer) { return 0; }
void tree_sitter_abap_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {}

static bool is_space(int32_t c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
}

static bool is_word_char(int32_t c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
         c == '_' || c == '-' || c == '/' || c == '%' || c == '$';
}

static int32_t lower(int32_t c) { return (c >= 'A' && c <= 'Z') ? c + 32 : c; }

// Consume `word` (lower case) case-insensitively, as a whole word.
static bool match_word(TSLexer *lexer, const char *word) {
  for (const char *p = word; *p; p++) {
    if (lower(lexer->lookahead) != *p) return false;
    lexer->advance(lexer, false);
  }
  return !is_word_char(lexer->lookahead);
}

static bool scan_sqlscript(TSLexer *lexer) {
  while (is_space(lexer->lookahead)) lexer->advance(lexer, true);
  if (lexer->eof(lexer)) return false;
  // Empty body: ENDMETHOD right away (also on the same line as the opener).
  if (lower(lexer->lookahead) == 'e' && match_word(lexer, "endmethod")) return false;

  for (;;) {
    while (lexer->lookahead != '\n' && !lexer->eof(lexer)) lexer->advance(lexer, false);
    lexer->mark_end(lexer);
    if (lexer->eof(lexer)) break;
    lexer->advance(lexer, false);  // '\n'
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t' || lexer->lookahead == '\r') {
      lexer->advance(lexer, false);
    }
    if (lower(lexer->lookahead) == 'e' && match_word(lexer, "endmethod")) break;
  }
  lexer->result_symbol = SQLSCRIPT;
  return true;
}

// ---- Words ------------------------------------------------------------------

#define WORD_MAX 32

// Read a whole word, lower-cased into `buf`. Words longer than the buffer come
// back empty, so they never match a keyword. Returns whether the word is
// spelled like the grammar's keywords: lower, UPPER or Capitalised.
static bool read_word(TSLexer *lexer, char *buf) {
  unsigned n = 0;
  bool too_long = false, any_lower = false, upper_after_first = false;
  while (is_word_char(lexer->lookahead)) {
    int32_t c = lexer->lookahead;
    if (c >= 'a' && c <= 'z') any_lower = true;
    if (c >= 'A' && c <= 'Z' && n > 0) upper_after_first = true;
    if (n + 1 < WORD_MAX) buf[n++] = (char)lower(c);
    else too_long = true;
    lexer->advance(lexer, false);
  }
  buf[too_long ? 0 : n] = 0;
  return !(any_lower && upper_after_first);
}

// Own helpers rather than <string.h>: Zed builds the scanner to WebAssembly
// against a minimal C library.
static bool streq(const char *a, const char *b) {
  while (*a && *a == *b) a++, b++;
  return *a == *b;
}

static bool word_in(const char *w, const char *const *list) {
  for (; *list; list++) if (streq(w, *list)) return true;
  return false;
}

// ---- SELECT loops -----------------------------------------------------------

static const char *const AGGREGATES[] = {
  "avg", "count", "max", "median", "min", "stddev", "string_agg", "sum", "var", NULL,
};

// Words in a select list that are not column names.
static const char *const LIST_KEYWORDS[] = {
  "all", "and", "between", "case", "distinct", "else", "end", "escape", "in", "is",
  "like", "not", "null", "or", "then", "when", NULL,
};

// Words that end a `FIELDS ...` select list (new syntax).
static const char *const LIST_END[] = {
  "into", "appending", "where", "group", "having", "order", "union", "intersect", "except",
  "up", "offset", "for", "bypassing", "connection", "privileged", "package", NULL,
};

// A SELECT statement longer than this (in characters and words) is assumed
// unfinished, so an unterminated SELECT isn't read to the end of a big file.
#define SELECT_SCAN_LIMIT 20000

// After an opening quote: up to the closing one ('' / `` are escapes).
static void skip_string(TSLexer *lexer, int32_t quote) {
  lexer->advance(lexer, false);
  while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
    int32_t c = lexer->lookahead;
    lexer->advance(lexer, false);
    if (c == quote) {
      if (lexer->lookahead != quote) return;
      lexer->advance(lexer, false);
    }
  }
}

// From an opening `|` to its closing one. Embedded expressions `{ ... }` may
// contain strings and further templates.
static void skip_template(TSLexer *lexer) {
  char stack[16];  // 'T' template text, 'E' embedded expression
  int top = 0;
  stack[0] = 'T';
  lexer->advance(lexer, false);
  while (!lexer->eof(lexer)) {
    int32_t c = lexer->lookahead;
    if (stack[top] == 'T') {
      if (c == '\n') return;  // unterminated
      lexer->advance(lexer, false);
      if (c == '\\') { if (!lexer->eof(lexer)) lexer->advance(lexer, false); }
      else if (c == '|') { if (top == 0) return; top--; }
      else if (c == '{' && top < 15) stack[++top] = 'E';
    } else {
      if (c == '\'' || c == '`') { skip_string(lexer, c); continue; }
      lexer->advance(lexer, false);
      if (c == '}') top--;
      else if (c == '|' && top < 15) stack[++top] = 'T';
    }
  }
}

enum Phase { PH_LIST, PH_OTHER, PH_FIELDS };

// What the last word of a select list was, until the next token says whether
// it was a column (`a,` / `a FROM`), a function (`coalesce(`) or an aggregate.
enum Pending { P_NONE, P_AGGREGATE, P_NAME };

// Called with the lexer just after the word SELECT (token end already marked).
static bool select_is_loop(TSLexer *lexer) {
  char w[WORD_MAX];
  unsigned depth = 0, scanned = 0;
  unsigned aggregate_depth = 0;  // depth inside the outermost aggregate's ( ), 0 = outside
  enum Phase phase = PH_LIST;
  enum Pending pending = P_NONE;
  bool col0 = false;             // at column 0 (for `*` comments)
  bool first = true;             // next token is the first after SELECT
  bool saw_from = false, into_table = false, package_size = false, group_by = false;
  bool in_into = false;          // right after INTO / APPENDING
  bool after_package = false, after_group = false;
  bool has_aggregate = false, has_column = false;
  bool skip_word = false;        // next word is an alias (AS x) or host variable (@x)
  bool expect_item = true;       // a `*` here is all columns, not multiplication

  for (;;) {
    if (lexer->eof(lexer) || ++scanned > SELECT_SCAN_LIMIT) return false;
    int32_t c = lexer->lookahead;
    if (c == '\n') { lexer->advance(lexer, false); col0 = true; continue; }
    if (is_space(c)) { lexer->advance(lexer, false); col0 = false; continue; }
    bool at_col0 = col0;
    col0 = false;
    bool in_list = (phase == PH_LIST || phase == PH_FIELDS) && aggregate_depth == 0;

    // A name followed by anything but `(` is a column.
#define RESOLVE_PENDING() do { if (pending != P_NONE) has_column = true; pending = P_NONE; } while (0)

    if (c == '"' || (c == '*' && at_col0)) {
      while (lexer->lookahead != '\n' && !lexer->eof(lexer)) lexer->advance(lexer, false);
      continue;
    }
    if (c == '\'' || c == '`' || c == '|') {
      if (c == '|') skip_template(lexer);
      else skip_string(lexer, c);
      if (in_list) { RESOLVE_PENDING(); expect_item = false; }
      in_into = false;
      first = false;
      continue;
    }

    if (c == '.') {
      lexer->advance(lexer, false);
      // `a.col` / `1.5` in native SQL: not the end of the statement.
      if (is_word_char(lexer->lookahead)) { first = false; continue; }
      break;
    }

    if (is_word_char(c)) {
      read_word(lexer, w);
      if (first) {
        first = false;
        if (streq(w, "single")) return false;
        if (streq(w, "distinct")) continue;
      }
      if (streq(w, "endexec")) return false;

      if (depth == 0) {
        if (in_into) {
          if (streq(w, "corresponding") || streq(w, "fields") || streq(w, "of")) continue;
          if (streq(w, "table")) into_table = true;
          in_into = false;
          continue;
        }
        if (after_package && streq(w, "size")) package_size = true;
        if (after_group && streq(w, "by")) group_by = true;
        after_package = streq(w, "package");
        after_group = streq(w, "group");

        if (streq(w, "into") || streq(w, "appending")) {
          if (in_list) RESOLVE_PENDING();
          in_into = true;
          phase = PH_OTHER;
          continue;
        }
        if (streq(w, "from")) {
          if (phase == PH_LIST) { RESOLVE_PENDING(); phase = PH_OTHER; }
          saw_from = true;
          continue;
        }
        if (streq(w, "fields") && phase == PH_OTHER && saw_from) {
          phase = PH_FIELDS;
          expect_item = true;
          continue;
        }
        if (phase == PH_FIELDS && word_in(w, LIST_END)) {
          RESOLVE_PENDING();
          phase = PH_OTHER;
          continue;
        }
      }

      if (in_list) {
        RESOLVE_PENDING();  // two words in a row: the first was a column
        expect_item = false;
        if (skip_word) { skip_word = false; continue; }
        if (streq(w, "as")) { skip_word = true; continue; }
        if ((w[0] >= '0' && w[0] <= '9') || w[0] == '-') continue;  // number, minus
        if (word_in(w, LIST_KEYWORDS)) continue;
        pending = word_in(w, AGGREGATES) ? P_AGGREGATE : P_NAME;
      }
      continue;
    }

    // Punctuation and operators.
    lexer->advance(lexer, false);
    if (c == ':' && first) return false;  // chained SELECT:
    first = false;
    in_into = false;
    if (c == '(') {
      if (in_list) {
        if (pending == P_AGGREGATE) { aggregate_depth = depth + 1; has_aggregate = true; }
        pending = P_NONE;  // a name before `(` is a function
        skip_word = false;
        expect_item = true;
      }
      depth++;
      continue;
    }
    if (c == ')') {
      if (in_list) RESOLVE_PENDING();
      if (depth > 0) depth--;
      if (aggregate_depth > depth) aggregate_depth = 0;
      expect_item = false;
      continue;
    }
    if (in_list) {
      RESOLVE_PENDING();
      if (c == '*' && expect_item) has_column = true;  // SELECT * / t~*
      if (c == '@') skip_word = true;
      expect_item = c == ',' || c == '~';
    }
#undef RESOLVE_PENDING
  }

  if (pending != P_NONE) has_column = true;
  if (!saw_from) return false;  // `select = 1.`: a variable
  if (has_aggregate && !has_column && !group_by) return false;  // one row
  if (into_table && !package_size) return false;
  return true;
}

// After the word SELECT.
static bool scan_select_loop(TSLexer *lexer) {
  lexer->mark_end(lexer);
  if (!is_space(lexer->lookahead)) return false;
  if (!select_is_loop(lexer)) return false;
  lexer->result_symbol = SELECT_LOOP;
  return true;
}

// ---- Events -------------------------------------------------------------------

static const char *const EVENT_WORDS[] = {
  "initialization", "start-of-selection", "end-of-selection", "top-of-page", "end-of-page",
  "load-of-program", NULL,
};

// After an event word: only an event if a period follows (or DURING).
static bool scan_event_keyword(TSLexer *lexer, const char *word) {
  lexer->mark_end(lexer);
  while (is_space(lexer->lookahead)) lexer->advance(lexer, false);
  if (lexer->lookahead == '.') {
    lexer->result_symbol = EVENT_KEYWORD;
    return true;
  }
  if (streq(word, "top-of-page") && lower(lexer->lookahead) == 'd') {
    char w[WORD_MAX];
    read_word(lexer, w);
    if (streq(w, "during")) {
      lexer->result_symbol = EVENT_KEYWORD;
      return true;
    }
  }
  return false;
}

// After the word AT.
static bool scan_at_event(TSLexer *lexer) {
  lexer->mark_end(lexer);
  if (!is_space(lexer->lookahead)) return false;
  while (is_space(lexer->lookahead)) lexer->advance(lexer, false);
  char w[WORD_MAX];
  read_word(lexer, w);
  bool event = streq(w, "selection-screen") || streq(w, "line-selection") ||
               streq(w, "user-command");
  if (!event && w[0] == 'p' && w[1] == 'f' && w[2] >= '0' && w[2] <= '9') {
    event = w[3] == 0 || (w[3] >= '0' && w[3] <= '9' && w[4] == 0);
  }
  if (!event) return false;
  lexer->result_symbol = AT_EVENT;
  return true;
}

// After FORM / CLASS / ...: a name (or `:` of a chained statement) follows.
static bool scan_event_end(TSLexer *lexer) {
  bool blank = is_space(lexer->lookahead);
  while (is_space(lexer->lookahead)) lexer->advance(lexer, false);
  int32_t c = lexer->lookahead;
  bool name = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '/';
  if (!(c == ':' || (blank && name))) return false;
  lexer->result_symbol = EVENT_END;  // empty: the end was marked before the word
  return true;
}

bool tree_sitter_abap_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  bool in_error_recovery = valid_symbols[ERROR_SENTINEL];

  // No whitespace is skipped first: the `(` must touch the preceding name.
  if (valid_symbols[CALL_OPEN] && !in_error_recovery && lexer->lookahead == '(') {
    lexer->advance(lexer, false);
    lexer->mark_end(lexer);
    if (is_space(lexer->lookahead) || lexer->lookahead == ')') {
      lexer->result_symbol = CALL_OPEN;
      return true;
    }
    return false;
  }

  if (valid_symbols[SQLSCRIPT] && !in_error_recovery) return scan_sqlscript(lexer);

  while (is_space(lexer->lookahead)) lexer->advance(lexer, true);

  if (valid_symbols[COMMENT] && lexer->lookahead == '*' && lexer->get_column(lexer) == 0) {
    while (lexer->lookahead != '\n' && lexer->lookahead != '\r' && !lexer->eof(lexer)) {
      lexer->advance(lexer, false);
    }
    lexer->result_symbol = COMMENT;
    return true;
  }

  if (in_error_recovery) return false;
  if (!valid_symbols[SELECT_LOOP] && !valid_symbols[AT_EVENT] && !valid_symbols[EVENT_KEYWORD] &&
      !valid_symbols[CATCH_SYSTEM_EXCEPTIONS] && !valid_symbols[EVENT_END]) {
    return false;
  }
  // Every word handled below starts with one of these letters.
  switch (lower(lexer->lookahead)) {
    case 'a': case 'c': case 'e': case 'f': case 'i': case 'l': case 'm': case 's': case 't':
      break;
    default:
      return false;
  }

  // The statement's first word decides. Mark the end here first: EVENT_END is
  // empty, the other tokens move the end past their words.
  lexer->mark_end(lexer);
  char w[WORD_MAX];
  bool keyword_spelling = read_word(lexer, w);
  if (w[0] == 0) return false;

  if (valid_symbols[SELECT_LOOP] && streq(w, "select")) return scan_select_loop(lexer);
  if (valid_symbols[AT_EVENT] && streq(w, "at")) return scan_at_event(lexer);
  if (valid_symbols[EVENT_KEYWORD] && word_in(w, EVENT_WORDS)) return scan_event_keyword(lexer, w);

  if (valid_symbols[EVENT_END] && keyword_spelling &&
      (streq(w, "form") || streq(w, "class") || streq(w, "interface") ||
       streq(w, "module") || streq(w, "function") || streq(w, "method"))) {
    return scan_event_end(lexer);
  }

  if (valid_symbols[CATCH_SYSTEM_EXCEPTIONS] && streq(w, "catch")) {
    if (lexer->lookahead != ' ' && lexer->lookahead != '\t' && lexer->lookahead != '\n' &&
        lexer->lookahead != '\r') {
      return false;
    }
    while (is_space(lexer->lookahead)) lexer->advance(lexer, false);
    if (!match_word(lexer, "system-exceptions")) return false;
    lexer->mark_end(lexer);
    lexer->result_symbol = CATCH_SYSTEM_EXCEPTIONS;
    return true;
  }

  return false;
}
