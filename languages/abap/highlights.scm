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
; Keywords (any casing; the grammar only tokenises a few of them itself)
; ---------------------------------------------------------------------------

((name) @keyword
  (#match? @keyword "^(?i:abstract|add|add-corresponding|adjacent|aliases|all|append|appending|as|ascending|assert|assign|assigned|assigning|at|authority-check|avg|back|base|begin|binary|blanks|bound|boxed|break-point|buffer|by|bypassing|call|case|cast|casting|catch|chain|changing|check|class|class-data|class-events|class-methods|class-pool|cleanup|clear|client|close|collect|commit|comparing|component|components|compute|concatenate|cond|condense|connection|constants|context|continue|conv|corresponding|count|create|critical|dangerous|data|default|deferred|define|definition|delete|deleting|descending|describe|destination|discarding|display|distinct|divide|divide-corresponding|do|duplicates|duration|else|elseif|empty|end|end-enhancement-section|end-of-definition|end-of-file|end-of-page|end-of-selection|endat|endcase|endcatch|endchain|endclass|enddo|endenhancement|endexec|endform|endfunction|endif|endinterface|endloop|endmethod|endmodule|endon|endprovide|endselect|endtry|endwhile|endwith|enhancement|enhancement-point|enhancement-section|entries|entities|entity|enum|event|events|exact|except|exception|exceptions|exec|exit|export|exporting|extract|fetch|field|field-symbol|field-symbols|fields|filter|final|find|first|for|form|format|free|friends|from|function|function-pool|get|global|group|handler|harmless|having|heading|hide|if|ignoring|implementation|import|importing|in|include|index|inheriting|initialization|inner|input|insert|instance|interface|interface-pool|interfaces|into|join|key|last|leave|left|length|let|level|like|line|line-count|line-size|lines|load|load-of-program|local|long|loop|lower|mapping|match|max|medium|members|message|message-id|method|methods|min|mode|modify|module|move|move-corresponding|multiply|multiply-corresponding|new|new-line|new-page|next|no|non-unique|object|obligatory|occurrence|occurrences|occurs|of|offset|on|open|optional|order|others|outer|output|overlay|pack|package|page|parameter|parameters|perform|pcre|preferred|primary|private|process|program|protected|provide|public|raise|raising|range|ranges|read|read-only|receive|receiving|redefinition|reduce|ref|refresh|regex|reject|replace|report|requested|reserve|respecting|results|resumable|retry|return|returning|risk|rollback|rows|scan|search|section|select|select-options|selection-screen|separated|set|shift|short|single|size|skip|sort|sorted|specified|split|standard|start-of-selection|starting|statics|step|stop|structure|submatches|submit|subtract|subtract-corresponding|sum|supplied|supply|switch|table|tables|task|test|testing|then|times|to|top-of-page|transfer|translate|transporting|try|type|type-pool|type-pools|types|uline|unassign|unique|unpack|until|up|update|upper|using|value|values|wait|when|where|while|with|without|work|write)$"))

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
; Types: TYPE x, REF TO x, TABLE OF x, RANGE OF x
; (LIKE and other uses of OF are followed by data objects, so not types.)
; ---------------------------------------------------------------------------

(type_spec type: (name) @type)
(ref_type type: (name) @type)
(table_type type: (name) @type)

(type_spec type: (member_access object: (name) @type member: (name) @type))
(ref_type type: (member_access object: (name) @type member: (name) @type))
(table_type type: (member_access object: (name) @type member: (name) @type))

(type_spec
  type: (name) @type.builtin
  (#match? @type.builtin "^(?i:abap_bool|any|c|clike|csequence|d|data|decfloat|decfloat16|decfloat34|f|i|int1|int2|int8|n|numeric|object|p|simple|string|t|utclong|x|xsequence|xstring)$"))

(ref_type
  type: (name) @type.builtin
  (#match? @type.builtin "^(?i:data|object)$"))

(table_type
  type: (name) @type.builtin
  (#match? @type.builtin "^(?i:abap_bool|c|d|decfloat16|decfloat34|f|i|int1|int2|int8|n|p|string|t|utclong|x|xstring)$"))

; Words in a type position that are really part of the type syntax:
; TYPE STANDARD TABLE ..., TYPE LINE OF ..., TYPE BEGIN OF ...
(type_spec
  type: (name) @keyword
  (#match? @keyword "^(?i:standard|sorted|hashed|index|line|begin|end|enum|struct|length|value|ref|table|range)$"))

; MESSAGE lv_text TYPE lv_type / MESSAGE ID lv_id TYPE lv_type ...: the operand
; of TYPE is a data object here. Anchored by position (not "any child") so it
; never scans the rest of a long statement.
(statement
  .
  (name) @_message
  .
  (_)
  .
  (type_spec type: (name) @variable)
  (#match? @_message "^(?i:message)$"))

(statement
  .
  (name) @_message
  .
  (_)
  .
  (_)
  .
  (type_spec type: (name) @variable)
  (#match? @_message "^(?i:message)$"))

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
  (#match? @type.builtin "^(?i:abap_bool|c|d|decfloat16|decfloat34|f|i|int1|int2|int8|n|p|string|t|utclong|x|xstring)$"))

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
  (name) @function.method
  (#match? @_call "^(?i:call)$")
  (#match? @_method "^(?i:method)$"))

; ---------------------------------------------------------------------------
; Declarations at the start of a statement
; ---------------------------------------------------------------------------

; METHOD run. / METHODS run ... / FORM x. / PERFORM x. / CLASS-METHODS x ...
(statement
  .
  (name) @_kw
  .
  (name) @function.method
  (#match? @_kw "^(?i:method|methods|class-methods|form|perform|function)$"))

; METHOD zif_repo~save.
(statement
  .
  (name) @_kw
  .
  (member_access member: (name) @function.method)
  (#match? @_kw "^(?i:method|methods|class-methods)$"))

; CLASS lcl_app ... / INTERFACE zif_x ...
(statement
  .
  (name) @_kw
  .
  (name) @type
  (#match? @_kw "^(?i:class|interface|interfaces)$"))
