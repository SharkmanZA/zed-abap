/**
 * Tree-sitter grammar for ABAP.
 *
 * Deliberately "flat": a source file is a list of statements, each a list of
 * tokens ending in a period. ABAP keywords are not reserved and are
 * case-insensitive, so instead of encoding every statement form we tokenise
 * reliably and leave keyword recognition to the highlight queries
 * (`#match?` with `(?i)` regexes). This keeps the parser tolerant of any
 * real-world ABAP, including chained statements (`DATA: a, b.`) and macros.
 */

const NAME_PART = /[A-Za-z0-9_%$\/]+/;

module.exports = grammar({
  name: 'abap',

  // `comment` is both external and internal: the C scanner handles
  // `*` comments (which only count when `*` is in column 0) and the internal
  // lexer handles `"` comments when the scanner declines.
  externals: $ => [$.comment],

  extras: $ => [/\s/, $.comment],

  rules: {
    source_file: $ => repeat($.statement),

    statement: $ => seq(repeat($._token), '.'),

    _token: $ => choice(
      $.name,
      $.call,
      $.field_symbol,
      $.number,
      $.string,
      $.template,
      $.pragma,
      $.operator,
      $.parenthesized,
      $.bracketed,
      ':',
      ',',
    ),

    // Identifiers and keywords. Hyphens bind tightly because ABAP requires
    // whitespace around the minus operator, so `ls_x-field`, `sy-subrc` and
    // `END-OF-SELECTION` are each a single name. Optional /NAMESPACE/ prefix.
    name: _ => token(seq(
      optional(/\/[A-Za-z0-9_]+\//),
      /[A-Za-z_%$][A-Za-z0-9_%$\/]*/,
      repeat(seq('-', NAME_PART)),
    )),

    // `method( ... )`, `DATA(lv)`, `lines( itab )` — name immediately followed by `(`.
    call: $ => seq(
      field('name', $.name),
      token.immediate('('),
      repeat($._token),
      ')',
    ),

    field_symbol: _ => token(seq(/<[A-Za-z0-9_\/]+>/, repeat(seq('-', NAME_PART)))),

    number: _ => /\d+/,

    string: _ => token(choice(
      seq("'", repeat(choice(/[^'\n]/, "''")), "'"),
      seq('`', repeat(choice(/[^`\n]/, '``')), '`'),
    )),

    // String templates: |Hello { lv_name WIDTH = 10 }!\n|
    template: $ => seq(
      '|',
      repeat(choice(
        $.template_content,
        $.escape_sequence,
        $.embedded_expression,
      )),
      '|',
    ),

    // Higher lexical precedence than `"` comments and whitespace so that
    // characters inside a template are never mistaken for either.
    template_content: _ => token.immediate(prec(1, /[^|{}\\]+/)),

    escape_sequence: _ => token.immediate(prec(1, /\\[|{}\\nrt]/)),

    embedded_expression: $ => seq(
      token.immediate('{'),
      repeat($._token),
      '}',
    ),

    pragma: _ => /##[A-Za-z0-9_]+(\[[^\]\n]*\])*/,

    // Everything operator-ish: = <> <= >= + - * / ** && ?= -> => ~ @ # ! &
    operator: _ => token(prec(-1, /[=<>+\-*\/&?~@#!^]+/)),

    parenthesized: $ => seq('(', repeat($._token), ')'),

    bracketed: $ => seq('[', repeat($._token), ']'),

    comment: _ => token(seq('"', /[^\n]*/)),
  },
});
