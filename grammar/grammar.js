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
 *
 * Block structure (for the nested outline, auto-indent and text objects):
 *   IF/ELSEIF/ELSE/ENDIF, CASE/WHEN/ENDCASE, LOOP, DO, WHILE, TRY/CATCH/CLEANUP,
 *   METHOD, FORM, FUNCTION, MODULE, CLASS ... DEFINITION (with SECTIONs),
 *   CLASS ... IMPLEMENTATION, INTERFACE.
 * A block opens only on a keyword at the START of a statement, so these words
 * stay ordinary names anywhere else (`CALL METHOD`, `COND #( WHEN ...)`,
 * `FOR ... WHILE`, `lo->method`). Closing statements are optional: an unclosed
 * IF simply extends to the enclosing ENDMETHOD (or end of file) instead of
 * producing a parse error, and a stray ENDIF with no open IF is an ordinary
 * statement. Blocks are right-associative, so following statements belong to
 * the innermost open block.
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

// Statement-start keyword: the three spellings above plus CamelCase for
// compound words (EndIf, ElseIf, EndLoop, ...).
const kw = (word, camel) => camel
  ? choice(ci(word), camel)
  : ci(word);

const CONSTRUCTORS = [
  'new', 'value', 'conv', 'cast', 'exact', 'corresponding',
  'reduce', 'cond', 'switch', 'filter',
];

// Keywords that open, continue or close a block. Each gets a statement rule
// `_s_<kw>`: `KEYWORD <tokens> .`, exposed as a `statement` node whose first
// child is (keyword). (Aliasing an inline seq() would not create a node.)
const BLOCK_KEYWORDS = [
  'if', 'elseif', 'else', 'case', 'when', 'loop', 'do', 'while',
  'try', 'catch', 'cleanup', 'method', 'form', 'function', 'module',
];

// Keywords that close a modelled block. (ENDSELECT, ENDAT, ENDON, ... are not
// here: their blocks aren't modelled, so they stay ordinary statements.)
const END_KEYWORDS = [
  'endif', 'endcase', 'endloop', 'enddo', 'endwhile', 'endtry', 'endcatch',
  'endmethod', 'endform', 'endfunction', 'endmodule',
  'endclass', 'endinterface',
];

// Words that open a block. ABAP keywords aren't reserved, so these are also
// valid variable / method names:
// - at the start of a statement followed by an operator, they name a variable
//   (`method = 'GET'.`, `form->run( ).`): see `_s_keyword_variable`;
// - anywhere after the first word of a statement they are plain names
//   (`DATA method TYPE string.`, `lo->do( )`).
// Clause keywords (ELSE, WHEN, CATCH, ... SECTION) are not included: they must
// stay able to end the body before them.
const OPENER_KEYWORDS = [
  'if', 'case', 'loop', 'do', 'while', 'try', 'method', 'form', 'function', 'module',
  'class', 'interface',
];

const stmt = ($, k) => alias($[`_s_${k}`], $.statement);

// A clause: its opening statement and the statements it governs.
const clause = ($, k) => prec.right(seq(
  field('open', stmt($, k)),
  optional(field('body', $.body)),
));

// Every block: opening statement, body, any clauses, optional closing
// statement. Every block accepts every clause and every END (see `_end`), so
// a clause keyword attaches to the innermost open block. In valid ABAP that
// is always the right one; in unbalanced code it at least never unwinds the
// enclosing blocks.
const block = ($, open) => prec.right(seq(
  field('open', open),
  optional(field('body', $.body)),
  repeat($._clause),
  optional(field('close', $._end)),
));
const simpleBlock = ($, k) => block($, stmt($, k));

module.exports = grammar({
  name: 'abap',

  // `comment` is both external and internal: the C scanner handles `*`
  // comments (only in column 0) and the internal lexer handles `"` comments.
  // `_call_open` is a "(" directly after a name and followed by a blank or ")".
  // `_error_sentinel` is never used by a rule, so the scanner sees it as valid
  // only during error recovery (when every symbol is valid).
  // `sqlscript` is the raw body of an AMDP method (`METHOD m BY DATABASE
  // PROCEDURE ...`), up to the line starting with ENDMETHOD: SQLScript
  // statements end in `;`, not `.`. `_catch_system_exceptions` is
  // `CATCH SYSTEM-EXCEPTIONS` (any casing), which opens its own block rather
  // than a TRY clause.
  externals: $ => [
    $.comment, $._call_open, $._error_sentinel, $.sqlscript, $._catch_system_exceptions,
  ],

  extras: $ => [/\s/, $.comment],

  word: $ => $.name,

  conflicts: $ => [
    [$._keyword, $.constructor_expression],
  ],

  rules: {
    source_file: $ => repeat($._item),

    // The first word is never a block keyword (that would open a block), so
    // it uses `_token_base`; later words may be (`DATA method TYPE string.`).
    statement: $ => seq(
      optional(seq(choice($._token_base, $.operator), repeat($._token))),
      '.',
    ),

    // ---- Block structure -------------------------------------------------

    _item: $ => choice(
      $.statement,
      $.if_block,
      $.case_block,
      $.loop_block,
      $.do_block,
      $.while_block,
      $.try_block,
      $.method_block,
      $.form_block,
      $.function_block,
      $.module_block,
      $.class_definition,
      $.class_implementation,
      $.interface_block,
      $.catch_system_exceptions_block,
      alias($._s_declaration_only, $.statement),
      alias($._s_keyword_variable, $.statement),
    ),

    _clause: $ => choice(
      $.elseif_clause,
      $.else_clause,
      $.when_clause,
      $.catch_clause,
      $.cleanup_clause,
      $.section,
    ),

    // Statements between a block's opening statement and its next clause or
    // closing statement.
    body: $ => prec.right(repeat1($._item)),

    if_block: $ => prec.right(seq(
      $.if_clause,
      repeat($._clause),
      optional(field('close', $._end)),
    )),
    if_clause: $ => clause($, 'if'),
    elseif_clause: $ => clause($, 'elseif'),
    else_clause: $ => clause($, 'else'),

    case_block: $ => simpleBlock($, 'case'),
    when_clause: $ => clause($, 'when'),

    try_block: $ => prec.right(seq(
      $.try_clause,
      repeat($._clause),
      optional(field('close', $._end)),
    )),
    try_clause: $ => clause($, 'try'),
    catch_clause: $ => clause($, 'catch'),
    cleanup_clause: $ => clause($, 'cleanup'),

    loop_block: $ => simpleBlock($, 'loop'),
    do_block: $ => simpleBlock($, 'do'),
    while_block: $ => simpleBlock($, 'while'),
    form_block: $ => simpleBlock($, 'form'),
    function_block: $ => simpleBlock($, 'function'),
    module_block: $ => simpleBlock($, 'module'),

    // METHOD m. ... ENDMETHOD.  /  METHOD m BY DATABASE PROCEDURE ... <SQLScript> ENDMETHOD.
    method_block: $ => choice(
      simpleBlock($, 'method'),
      prec.right(seq(
        field('open', alias($._s_method_by, $.statement)),
        optional(field('body', $.sqlscript)),
        optional(field('close', $._end)),
      )),
    ),
    _s_method_by: $ => seq(
      alias($._kw_method, $.keyword),
      repeat($._token),
      alias($._kw_by, $.keyword),
      repeat($._token),
      '.',
    ),

    // CATCH SYSTEM-EXCEPTIONS ... ENDCATCH.
    catch_system_exceptions_block: $ => block($, alias($._s_catch_system_exceptions, $.statement)),
    _s_catch_system_exceptions: $ => seq(
      alias($._catch_system_exceptions, $.keyword),
      repeat($._token),
      '.',
    ),

    // CLASS lcl DEFINITION [options]. ... PUBLIC SECTION. ... ENDCLASS.
    class_definition: $ => block($, alias($._s_class_definition, $.statement)),
    section: $ => prec.right(seq(
      field('open', alias($._s_section, $.statement)),
      optional(field('body', $.body)),
    )),
    class_implementation: $ => block($, alias($._s_class_implementation, $.statement)),
    interface_block: $ => block($, alias($._s_interface, $.statement)),

    _s_class_definition: $ => seq(
      alias($._kw_class, $.keyword),
      field('name', $.name),
      alias($._kw_definition, $.keyword),
      repeat($._token),
      '.',
    ),
    _s_class_implementation: $ => seq(
      alias($._kw_class, $.keyword),
      field('name', $.name),
      alias($._kw_implementation, $.keyword),
      repeat($._token),
      '.',
    ),
    _s_interface: $ => seq(
      alias($._kw_interface, $.keyword),
      field('name', $.name),
      repeat($._token),
      '.',
    ),
    _s_section: $ => seq(
      alias(choice($._kw_public, $._kw_protected, $._kw_private), $.keyword),
      alias($._kw_section, $.keyword),
      repeat($._token),
      '.',
    ),

    // Forward declarations open no block:
    //   CLASS lcl DEFINITION DEFERRED [PUBLIC]. / CLASS lcl DEFINITION LOAD.
    //   CLASS lcl DEFINITION LOCAL FRIENDS ... / INTERFACE zif DEFERRED|LOAD.
    // plus CLASS statements in casings the grammar doesn't tokenise.
    _s_declaration_only: $ => choice(
      seq(
        alias($._kw_class, $.keyword),
        field('name', $.name),
        alias($._kw_definition, $.keyword),
        alias(choice($._kw_deferred, $._kw_load, $._kw_local), $.keyword),
        repeat($._token),
        '.',
      ),
      seq(
        alias($._kw_interface, $.keyword),
        field('name', $.name),
        alias(choice($._kw_deferred, $._kw_load), $.keyword),
        repeat($._token),
        '.',
      ),
      seq(alias($._kw_class, $.keyword), repeat($._token), '.'),
    ),

    // `method = 'GET'.`, `form->run( ).`, `interface = 'X'.`: a variable that
    // shares a block keyword's name. A block statement never continues with an
    // assignment or member operator (other operators can follow its keyword:
    // `ELSEIF !act IS BOUND.`), and right after such a keyword
    // `_assignment_operator` out-ranks the general operator token.
    _s_keyword_variable: $ => seq(
      alias(choice(...OPENER_KEYWORDS.map(k => $[`_kw_${k}`])), $.name),
      alias($._assignment_operator, $.operator),
      repeat($._token),
      '.',
    ),
    _assignment_operator: _ => token(prec(1, choice(
      '=', '?=', '+=', '-=', '*=', '/=', '&&=', '->', '=>',
    ))),

    // Any END... statement closes the innermost open block. In valid ABAP that
    // is always the matching one, and accepting every END keyword in every
    // block keeps the set of tokens that can follow a block the same in all
    // nesting contexts, which keeps parser generation fast (tracking which
    // END is valid where made it grow combinatorially with the number of
    // block types). Side effect, only in unbalanced code while typing: an
    // ENDMETHOD below an unclosed IF closes the IF. An END... with no open
    // block at all is an ordinary statement.
    _end: $ => alias($._s_end, $.statement),
    _s_end: $ => seq(
      alias(choice(...END_KEYWORDS.map(k => $[`_kw_${k}`])), $.keyword),
      repeat($._token),
      '.',
    ),

    // Statement rules for the block keywords (see BLOCK_KEYWORDS).
    ...Object.fromEntries(BLOCK_KEYWORDS.map(k => [`_s_${k}`, $ => seq(
      alias($[`_kw_${k}`], $.keyword),
      repeat($._token),
      '.',
    )])),

    _token: $ => choice($._token_no_operator, $.operator),

    _token_no_operator: $ => choice(
      $._token_base,
      alias(choice(...OPENER_KEYWORDS.map(k => $[`_kw_${k}`])), $.name),
    ),

    _token_base: $ => choice(
      $._primary,
      $.number,
      $.string,
      $.template,
      $.pragma,
      $.parenthesized,
      $.bracketed,
      $.type_spec,
      $.ref_type,
      $.table_type,
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
      $.constructor_expression,
    ),

    // A name in a position where only an identifier makes sense (method,
    // attribute, call or access name). Grammar keywords are accepted here as
    // plain names: `lo->value`, `zcl=>new( )`, `METHOD zif~ref.`
    _identifier: $ => choice($.name, alias($._any_keyword, $.name)),

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
      field('name', $._identifier),
      alias($._call_open, '('),
      repeat($._token),
      ')',
    ),

    // `(` with no blank after it: offset/length `lv(4)`, inline declarations
    // `DATA(x)`, short-form messages `e001(zmsg)`, `VALUE(rv)` parameters.
    access: $ => seq(
      field('name', $._identifier),
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
      field('member', choice(
        $._identifier,
        $.call,
        $.access,
        $.parenthesized,                      // dynamic: lo->(lv_attr)
        alias(token.immediate('*'), '*'),     // dereference: lr->*
      )),
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

    // The type operand of TYPE / REF TO / TABLE OF / RANGE OF / LINE OF.
    type_name: $ => choice($.name, $.member_access),

    // TYPE x. The operand is optional so `SELECT type, text ...` still parses.
    type_spec: $ => prec.right(seq(
      alias($._kw_type, $.keyword),
      optional(choice(
        field('type', $.type_name),
        $.ref_type,
        $.table_type,
      )),
    )),

    // REF TO x
    ref_type: $ => prec.right(1, seq(
      alias($._kw_ref, $.keyword),
      alias($._kw_to, $.keyword),
      optional(field('type', $.type_name)),
    )),

    // TABLE OF x / RANGE OF x / LINE OF x. `OF x` is optional: generic
    // `TYPE TABLE`, `INTO TABLE @lt`, `DELETE TABLE lt ...`.
    table_type: $ => prec.right(1, seq(
      alias(choice($._kw_table, $._kw_range, $._kw_line), $.keyword),
      optional(seq(
        alias($._kw_of, $.keyword),
        optional(choice(field('type', $.type_name), $.ref_type)),
      )),
    )),

    // NEW zcl_foo( ), CONV string( x ), VALUE ty_tab( ), REF ty( x ) ...
    // (`VALUE #( )` is just keyword + operator + parenthesized.)
    constructor_expression: $ => seq(
      alias(choice($._kw_ref, ...CONSTRUCTORS.map(k => $[`_kw_${k}`])), $.keyword),
      field('type', $.call),
    ),

    // Keywords that are tokens in the grammar, usable on their own anywhere.
    // (A lone TYPE / TABLE / RANGE / LINE is already a type_spec / table_type with no
    // operand.)
    _keyword: $ => alias(choice(
      $._kw_ref, $._kw_to, $._kw_of,
      ...CONSTRUCTORS.map(k => $[`_kw_${k}`]),
    ), $.keyword),

    _any_keyword: $ => choice(
      $._kw_type, $._kw_ref, $._kw_to, $._kw_table, $._kw_range, $._kw_line, $._kw_of,
      ...CONSTRUCTORS.map(k => $[`_kw_${k}`]),
      // so `do( )`, `lo->method( )`, `zcl=>if` stay calls / names
      ...OPENER_KEYWORDS.map(k => $[`_kw_${k}`]),
    ),

    _kw_type: _ => ci('type'),

    // Statement-start (block) keywords.
    _kw_if: _ => kw('if'),
    _kw_elseif: _ => kw('elseif', 'ElseIf'),
    _kw_else: _ => kw('else'),
    _kw_endif: _ => kw('endif', 'EndIf'),
    _kw_case: _ => kw('case'),
    _kw_when: _ => kw('when'),
    _kw_endcase: _ => kw('endcase', 'EndCase'),
    _kw_loop: _ => kw('loop'),
    _kw_endloop: _ => kw('endloop', 'EndLoop'),
    _kw_do: _ => kw('do'),
    _kw_enddo: _ => kw('enddo', 'EndDo'),
    _kw_while: _ => kw('while'),
    _kw_endwhile: _ => kw('endwhile', 'EndWhile'),
    _kw_try: _ => kw('try'),
    _kw_catch: _ => kw('catch'),
    _kw_cleanup: _ => kw('cleanup', 'CleanUp'),
    _kw_endtry: _ => kw('endtry', 'EndTry'),
    _kw_method: _ => kw('method'),
    _kw_endmethod: _ => kw('endmethod', 'EndMethod'),
    _kw_form: _ => kw('form'),
    _kw_endform: _ => kw('endform', 'EndForm'),
    _kw_function: _ => kw('function'),
    _kw_endfunction: _ => kw('endfunction', 'EndFunction'),
    _kw_module: _ => kw('module'),
    _kw_endmodule: _ => kw('endmodule', 'EndModule'),
    _kw_class: _ => kw('class'),
    _kw_definition: _ => kw('definition'),
    _kw_implementation: _ => kw('implementation'),
    _kw_deferred: _ => kw('deferred'),
    _kw_load: _ => kw('load'),
    _kw_local: _ => kw('local'),
    _kw_endclass: _ => kw('endclass', 'EndClass'),
    _kw_endcatch: _ => kw('endcatch', 'EndCatch'),
    _kw_by: _ => kw('by'),
    _kw_interface: _ => kw('interface'),
    _kw_endinterface: _ => kw('endinterface', 'EndInterface'),
    _kw_public: _ => kw('public'),
    _kw_protected: _ => kw('protected'),
    _kw_private: _ => kw('private'),
    _kw_section: _ => kw('section'),
    _kw_ref: _ => ci('ref'),
    _kw_to: _ => ci('to'),
    _kw_table: _ => ci('table'),
    _kw_range: _ => ci('range'),
    _kw_line: _ => ci('line'),
    _kw_of: _ => ci('of'),
    ...Object.fromEntries(CONSTRUCTORS.map(k => [`_kw_${k}`, _ => ci(k)])),
  },
});
