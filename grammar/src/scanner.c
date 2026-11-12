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

#include "tree_sitter/parser.h"

enum TokenType { COMMENT, CALL_OPEN };

void *tree_sitter_abap_external_scanner_create(void) { return NULL; }
void tree_sitter_abap_external_scanner_destroy(void *payload) {}
unsigned tree_sitter_abap_external_scanner_serialize(void *payload, char *buffer) { return 0; }
void tree_sitter_abap_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {}

static bool is_space(int32_t c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
}

bool tree_sitter_abap_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  // No whitespace is skipped first: the `(` must touch the preceding name.
  if (valid_symbols[CALL_OPEN] && lexer->lookahead == '(') {
    lexer->advance(lexer, false);
    lexer->mark_end(lexer);
    if (is_space(lexer->lookahead) || lexer->lookahead == ')') {
      lexer->result_symbol = CALL_OPEN;
      return true;
    }
    return false;
  }

  if (!valid_symbols[COMMENT]) return false;

  while (is_space(lexer->lookahead)) lexer->advance(lexer, true);

  if (lexer->lookahead != '*' || lexer->get_column(lexer) != 0) return false;

  while (lexer->lookahead != '\n' && lexer->lookahead != '\r' && !lexer->eof(lexer)) {
    lexer->advance(lexer, false);
  }
  lexer->result_symbol = COMMENT;
  return true;
}
