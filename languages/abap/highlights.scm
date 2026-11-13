; ABAP highlights.
;
; In Zed, when several patterns capture the same node, the LATER pattern wins,
; so this file goes from general to specific. ABAP keywords are not reserved and
; are case-insensitive, so most are matched with (?i) regexes on `name` nodes.
;
; Performance: avoid sibling patterns (`(_ (name) . (name))`) that can range
; over every token of a long statement. Relationships the highlighting needs
; (TYPE x, REF TO x, a->b, calls) are parsed as small nodes in the grammar.
; The only sibling patterns here are anchored to the first children of a
; statement or live inside small `{ }` template expressions.

; ---------------------------------------------------------------------------
; Base
; ---------------------------------------------------------------------------

(name) @variable
(keyword) @keyword
(field_symbol) @variable.special
(comment) @comment
(number) @number
(string) @string
(pragma) @attribute

(template "|" @string)
(template_content) @string
(escape_sequence) @string.escape
(embedded_expression ["{" "}"] @punctuation.special)

(operator) @operator
(member_access operator: _ @operator)
(member_access member: "*" @operator)
["." "," ":"] @punctuation.delimiter
["(" ")" "[" "]"] @punctuation.bracket

; ---------------------------------------------------------------------------
; Types: the operand of TYPE / REF TO / TABLE OF / RANGE OF / LINE OF.
; Placed BEFORE the keyword rules: when the word after a `type` column or
; variable is really a keyword (`SELECT type FROM ...`, `WHERE type IS ...`),
; the keyword rules below win and it keeps its keyword colour.
; (LIKE and other uses of OF are followed by data objects, so not types.)
; ---------------------------------------------------------------------------

(type_name (name) @type)
(type_name (member_access object: (name) @type member: (name) @type))

; ---------------------------------------------------------------------------
; Keywords (any casing; the grammar only tokenises a few of them itself)
; ---------------------------------------------------------------------------

((name) @keyword
  (#match? @keyword "^(?i:abstract|add|add-corresponding|adjacent|aliases|all|append|appending|as|ascending|assert|assign|assigned|assigning|at|authority-check|avg|back|base|begin|binary|blanks|bound|boxed|break-point|buffer|by|bypassing|call|case|cast|casting|catch|chain|changing|check|class|class-data|class-events|class-methods|class-pool|cleanup|clear|client|close|collect|commit|comparing|component|components|compute|concatenate|cond|condense|connection|constants|context|continue|conv|corresponding|count|create|critical|dangerous|data|default|deferred|define|definition|delete|deleting|descending|describe|destination|discarding|display|distinct|divide|divide-corresponding|do|duplicates|duration|else|elseif|empty|end|end-enhancement-section|end-of-definition|end-of-file|end-of-page|end-of-selection|endat|endcase|endcatch|endchain|endclass|enddo|endenhancement|endexec|endform|endfunction|endif|endinterface|endloop|endmethod|endmodule|endon|endprovide|endselect|endtry|endwhile|endwith|enhancement|enhancement-point|enhancement-section|entries|entities|entity|enum|event|events|exact|except|exception|exceptions|exec|exit|export|exporting|extract|fetch|field|field-symbol|field-symbols|fields|filter|final|find|first|for|form|format|free|friends|from|function|function-pool|get|global|group|handler|harmless|hashed|having|heading|hide|if|ignoring|implementation|import|importing|in|include|index|inheriting|initialization|inner|input|insert|instance|interface|interface-pool|interfaces|into|join|key|last|leave|left|length|let|level|like|line|line-count|line-size|lines|load|load-of-program|local|long|loop|lower|mapping|match|max|medium|members|message|message-id|method|methods|min|mode|modify|module|move|move-corresponding|multiply|multiply-corresponding|new|new-line|new-page|next|no|non-unique|object|obligatory|occurrence|occurrences|occurs|of|offset|on|open|optional|order|others|outer|output|overlay|pack|package|page|parameter|parameters|perform|pcre|preferred|primary|private|process|program|protected|provide|public|raise|raising|range|ranges|read|read-only|receive|receiving|redefinition|reduce|ref|refresh|regex|reject|replace|report|requested|reserve|respecting|results|resumable|retry|return|returning|risk|rollback|rows|scan|search|section|select|select-options|selection-screen|separated|set|shift|short|single|size|skip|sort|sorted|specified|split|standard|start-of-selection|starting|statics|step|stop|struct|structure|submatches|submit|subtract|subtract-corresponding|sum|supplied|supply|switch|table|tables|task|test|testing|then|times|to|top-of-page|transfer|translate|transporting|try|type|type-pool|type-pools|types|uline|unassign|unique|unpack|until|up|update|upper|using|value|values|wait|when|where|while|with|without|work|write)$"))

; Logical and comparison operators
((name) @keyword.operator
  (#match? @keyword.operator "^(?i:and|or|not|equiv|is|between|bit-and|bit-or|bit-xor|bit-not|mod|div|eq|ne|lt|gt|le|ge|co|cn|ca|na|cs|ns|cp|np|bt|nb|byte-co|byte-cn|byte-ca|byte-na|byte-cs|byte-ns)$"))

((name) @variable.special
  (#match? @variable.special "^(?i:me|super|sy|syst|sy-[A-Za-z0-9_]+|syst-[A-Za-z0-9_]+|text-[A-Za-z0-9_]+)$"))

((name) @constant.builtin
  (#match? @constant.builtin "^(?i:abap_true|abap_false|abap_undefined|space|initial|null)$"))

; String template formatting options: { lv WIDTH = 10 ALIGN = RIGHT }
(embedded_expression
  (name) @keyword
  .
  (operator) @_eq
  (#eq? @_eq "="))

(embedded_expression
  (operator) @_eq
  .
  (name) @constant.builtin
  (#eq? @_eq "=")
  (#match? @constant.builtin "^(?i:left|right|center|upper|lower|raw|user|environment|iso|sign_as_postfix|scientific|scientific_with_leading_zero|simple|engineering)$"))

; ---------------------------------------------------------------------------
; Built-in types and data objects in type positions (after the keyword rules,
; so `TYPE REF TO data` / `TYPE any` / `TYPE object` win over keyword colour)
; ---------------------------------------------------------------------------

(type_name
  (name) @type.builtin
  (#match? @type.builtin "^(?i:abap_bool|any|c|clike|csequence|d|data|decfloat|decfloat16|decfloat34|f|i|int1|int2|int8|n|numeric|object|p|simple|string|t|utclong|x|xsequence|xstring)$"))

; Some statements take a data object after TYPE: `MESSAGE lv TYPE lv_msgty`,
; `DESCRIBE FIELD lv TYPE lv_type`, `CREATE DATA lr TYPE (lv_name)`. Telling
; them apart needs the statement keyword, which would mean scanning siblings,
; so this uses the usual ABAP naming convention instead: lv_ ls_ lt_ lo_ lr_,
; gv_ mv_ iv_ ev_ cv_ rv_ pv_ ..., and sy-/syst- fields.
(type_name
  (name) @variable
  (#match? @variable "^(?i:sy-|syst-|[lgmpiecr][vsto]_)"))

; ---------------------------------------------------------------------------
; Calls: meth( ), lines( itab ), NEW zcl( ), CONV string( )
; ---------------------------------------------------------------------------

(call name: (name) @function)

(call
  name: (name) @function.builtin
  (#match? @function.builtin "^(?i:abs|boolc|boolx|ceil|char_off|cmax|cmin|concat_lines_of|condense|contains|contains_any_not_of|contains_any_of|cos|count|count_any_not_of|count_any_of|escape|exp|find|find_any_not_of|find_any_of|find_end|floor|frac|from_mixed|insert|ipow|line_exists|line_index|lines|log|log10|match|matches|nmax|nmin|numofchar|repeat|replace|rescale|reverse|round|segment|shift_left|shift_right|sign|sin|sqrt|strlen|substring|substring_after|substring_before|substring_from|substring_to|tan|to_lower|to_mixed|to_upper|translate|trunc|xsdbool|xstrlen)$"))

(constructor_expression type: (call name: (name) @type))

(constructor_expression
  type: (call name: (name) @type.builtin)
  (#match? @type.builtin "^(?i:abap_bool|any|c|clike|csequence|d|data|decfloat|decfloat16|decfloat34|f|i|int1|int2|int8|n|numeric|object|p|simple|string|t|utclong|x|xsequence|xstring)$"))

; ---------------------------------------------------------------------------
; Member access: lo->attr, lo->meth( ), zcl=>const, zif~meth
; (Last, so method and attribute names are never recoloured as keywords or
; builtins just because of their spelling.)
; ---------------------------------------------------------------------------

(member_access member: (name) @property)
(member_access member: (call name: (name) @function.method))

(member_access
  object: (name) @type
  operator: ["=>" "~"])

; CALL METHOD lo->meth. / CALL METHOD zcl=>meth. / CALL METHOD meth.
(statement
  .
  (name) @_call
  .
  (name) @_method
  .
  (member_access member: (name) @function.method)
  (#match? @_call "^(?i:call)$")
  (#match? @_method "^(?i:method)$"))

(statement
  .
  (name) @_call
  .
  (name) @_method
  .
  [(name) (keyword)] @function.method
  (#match? @_call "^(?i:call)$")
  (#match? @_method "^(?i:method)$"))

; ---------------------------------------------------------------------------
; Declarations
; ---------------------------------------------------------------------------

; METHODS run ... / CLASS-METHODS x ... (declarations stay plain statements)
(statement
  .
  (name) @_kw
  .
  [(name) (keyword)] @function.method
  (#match? @_kw "^(?i:methods|class-methods)$"))

; PERFORM x. (same colour as the FORM it calls)
(statement
  .
  (name) @_kw
  .
  [(name) (keyword)] @function
  (#match? @_kw "^(?i:perform)$"))

; INTERFACES zif_x.
(statement
  .
  (name) @_kw
  .
  (name) @type
  (#match? @_kw "^(?i:interfaces)$"))

; Block openers: METHOD run. / METHOD zif_x~save.
(method_block
  open: (statement
    .
    (keyword)
    .
    [
      (name) @function.method
      (keyword) @function.method
      (member_access member: (name) @function.method)
    ]))

; FORM x. / FUNCTION z_fm. / MODULE m OUTPUT.
([
  (form_block open: (statement . (keyword) . [(name) (keyword)] @function))
  (function_block open: (statement . (keyword) . [(name) (keyword)] @function))
  (module_block open: (statement . (keyword) . [(name) (keyword)] @function))
])

; CLASS lcl ... / INTERFACE zif ... (blocks and DEFERRED / LOAD declarations).
; Anchored to the first two children: an unanchored child pattern on
; `statement` would scan every token of long statements (5,000-line DATA:).
(statement . (keyword) . name: (name) @type)

; AMDP method body: SQLScript, shown as embedded code. (injections.scm hands
; it to a SQL grammar when one is installed.)
(sqlscript) @embedded
