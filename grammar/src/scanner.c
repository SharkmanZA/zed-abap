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
// ERROR_SENTINEL is never used by a grammar rule, so it is only ever valid
// during error recovery, when tree-sitter marks every symbol valid. In that
// state we don't emit the context-dependent tokens.

#include "tree_sitter/parser.h"

enum TokenType { COMMENT, CALL_OPEN, ERROR_SENTINEL, SQLSCRIPT, CATCH_SYSTEM_EXCEPTIONS };

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

  if (valid_symbols[CATCH_SYSTEM_EXCEPTIONS] && !in_error_recovery && lower(lexer->lookahead) == 'c') {
    if (!match_word(lexer, "catch")) return false;
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
