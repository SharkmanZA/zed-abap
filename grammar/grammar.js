/**
 * Tree-sitter grammar for ABAP.
 *
 * Mostly "flat": a source file is a list of statements, each a list of tokens
 * ending in a period. ABAP keywords are not reserved and are case-insensitive,
 * so most keyword recognition is left to the highlight queries (`#match?` with
 * `(?i)` regexes on `name` nodes).
 *
 * A few small structures are parsed so that queries can use cheap parent/child
 * patterns rather than sibling scans across long statements:
 *   - member_access          lo->meth( ), zcl=>const, zif~meth, lr->*
 *   - call                   meth( ... )    (name + "(" + blank, per ABAP rules)
 *   - access                 lv(4), DATA(x), e001(zmsg), VALUE(rv)  (no blank)
 *   - type_spec              TYPE x
 *   - ref_type               REF TO x
 *   - table_type             TABLE OF x / RANGE OF x
 *   - constructor_expression NEW zcl( ), CONV string( ), VALUE ty( ) ...
 * The handful of keywords these need are real tokens (via keyword extraction),
 * but every one of them is also accepted as a standalone token, and their
 * operands are optional, so unusual code still parses.
 */

const NAME_PART = /[A-Za-z0-9_%$\/]+/;

// A keyword in the three spellings used in practice: lower, UPPER, Capitalised.
// Tree-sitter's keyword extraction only works with string literals, so a
// case-insensitive regex isn't possible here. Other casings parse as `name`
// and are still coloured as keywords by highlights.scm.
const ci = word => choice(
  word.toLowerCase(),
  word.toUpperCase(),
  word[0].toUpperCase() + word.slice(1).toLowerCase(),
);

const CONSTRUCTORS = [
  'new', 'value', 'conv', 'cast', 'exact', 'corresponding',
  'reduce', 'cond', 'switch', 'filter',
];

module.exports = grammar({
  name: 'abap',

  // `comment` is both external and internal: the C scanner handles `*`
  // comments (only in column 0) and the internal lexer handles `"` comments.
  // `_call_open` is a "(" directly after a name and followed by a blank or ")".
  externals: $ => [$.comment, $._call_open],

  extras: $ => [/\s/, $.comment],

  word: $ => $.name,

  conflicts: $ => [
    [$._keyword, $.constructor_expression],
  ],

  rules: {
    source_file: $ => repeat($.statement),

    statement: $ => seq(repeat($._token), '.'),

    _token: $ => choice(
      $._primary,
      $.number,
      $.string,
      $.template,
      $.pragma,
      $.operator,
      $.parenthesized,
      $.bracketed,
      $.type_spec,
      $.ref_type,
      $.table_type,
      $.constructor_expression,
      $._keyword,
      ':',
      ',',
    ),

    _primary: $ => choice(
      $.name,
      $.call,
      $.access,
      $.field_symbol,
      $.member_access,
    ),

    // Identifiers and keywords. Hyphens bind tightly because ABAP requires
    // whitespace around the minus operator, so `ls_x-field`, `sy-subrc` and
    // `END-OF-SELECTION` are each a single name. Optional /NAMESPACE/ prefix.
    name: _ => token(seq(
      optional(/\/[A-Za-z0-9_]+\//),
      /[A-Za-z_%$][A-Za-z0-9_%$\/]*/,
      repeat(seq('-', NAME_PART)),
    )),

    // Functional method call: ABAP requires a blank (or `)`) after the `(`.
    call: $ => seq(
      field('name', $.name),
      alias($._call_open, '('),
      repeat($._token),
      ')',
    ),

    // `(` with no blank after it: offset/length `lv(4)`, inline declarations
    // `DATA(x)`, short-form messages `e001(zmsg)`, `VALUE(rv)` parameters.
    access: $ => seq(
      field('name', choice($.name, $._keyword)),
      token.immediate('('),
      repeat($._token),
      ')',
    ),

    member_access: $ => prec.left(seq(
      field('object', $._primary),
      field('operator', choice(
        token.immediate('->'),
        token.immediate('=>'),
        token.immediate('~'),
      )),
      field('member', choice($.name, $.call, $.access, alias(token.immediate('*'), '*'))),
    )),

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

    // Everything operator-ish: = <> <= >= + - * / ** && ?= @ # ! &
    operator: _ => token(prec(-1, /[=<>+\-*\/&?~@#!^]+/)),

    parenthesized: $ => seq('(', repeat($._token), ')'),

    bracketed: $ => seq('[', repeat($._token), ']'),

    comment: _ => token(seq('"', /[^\n]*/)),

    // ---- Type positions -------------------------------------------------

    _type_name: $ => choice($.name, $.member_access),

    // TYPE x. The operand is optional so `SELECT type, text ...` still parses.
    type_spec: $ => prec.right(seq(
      alias($._kw_type, $.keyword),
      optional(choice(
        field('type', $._type_name),
        $.ref_type,
        $.table_type,
      )),
    )),

    // REF TO x
    ref_type: $ => prec.right(1, seq(
      alias($._kw_ref, $.keyword),
      alias($._kw_to, $.keyword),
      optional(field('type', $._type_name)),
    )),

    // TABLE OF x / RANGE OF x. `OF x` is optional: generic `TYPE TABLE`,
    // `INTO TABLE @lt`, `DELETE TABLE lt ...`.
    table_type: $ => prec.right(1, seq(
      alias(choice($._kw_table, $._kw_range), $.keyword),
      optional(seq(
        alias($._kw_of, $.keyword),
        optional(choice(field('type', $._type_name), $.ref_type)),
      )),
    )),

    // NEW zcl_foo( ), CONV string( x ), VALUE ty_tab( ), REF ty( x ) ...
    // (`VALUE #( )` is just keyword + operator + parenthesized.)
    constructor_expression: $ => seq(
      alias(choice($._kw_ref, ...CONSTRUCTORS.map(k => $[`_kw_${k}`])), $.keyword),
      field('type', $.call),
    ),

    // Keywords that are tokens in the grammar, usable on their own anywhere.
    // (A lone TYPE / TABLE / RANGE is already a type_spec / table_type with no
    // operand.)
    _keyword: $ => alias(choice(
      $._kw_ref, $._kw_to, $._kw_of,
      ...CONSTRUCTORS.map(k => $[`_kw_${k}`]),
    ), $.keyword),

    _kw_type: _ => ci('type'),
    _kw_ref: _ => ci('ref'),
    _kw_to: _ => ci('to'),
    _kw_table: _ => ci('table'),
    _kw_range: _ => ci('range'),
    _kw_of: _ => ci('of'),
    ...Object.fromEntries(CONSTRUCTORS.map(k => [`_kw_${k}`, _ => ci(k)])),
  },
});
