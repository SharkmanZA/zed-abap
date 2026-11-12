// External scanner for ABAP.
//
// Handles full-line comments: a `*` in the first column comments out the rest
// of the line. A `*` anywhere else is an operator (`SELECT *`, `a * b`), which
// a regex can't distinguish, so we check the column here. Returning false
// hands control back to the internal lexer, which also lexes `"` comments.

#include "tree_sitter/parser.h"

enum TokenType { COMMENT };

void *tree_sitter_abap_external_scanner_create(void) { return NULL; }
void tree_sitter_abap_external_scanner_destroy(void *payload) {}
unsigned tree_sitter_abap_external_scanner_serialize(void *payload, char *buffer) { return 0; }
void tree_sitter_abap_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {}

static bool is_space(int32_t c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
}

bool tree_sitter_abap_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  if (!valid_symbols[COMMENT]) return false;

  while (is_space(lexer->lookahead)) lexer->advance(lexer, true);

  if (lexer->lookahead != '*' || lexer->get_column(lexer) != 0) return false;

  while (lexer->lookahead != '\n' && lexer->lookahead != '\r' && !lexer->eof(lexer)) {
    lexer->advance(lexer, false);
  }
  lexer->result_symbol = COMMENT;
  return true;
}
