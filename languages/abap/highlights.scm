; ABAP highlights.
;
; In Zed, when several patterns capture the same node, the LATER pattern wins,
; so this file goes from general to specific. ABAP keywords are not reserved and
; are case-insensitive, so they are matched with (?i) regexes on `name` nodes.

; ---------------------------------------------------------------------------
; Base
; ---------------------------------------------------------------------------

(name) @variable
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
["." "," ":"] @punctuation.delimiter
["(" ")" "[" "]"] @punctuation.bracket

; ---------------------------------------------------------------------------
; Types: TYPE x / LIKE x / REF TO x / TABLE OF x / RANGE OF x
; ---------------------------------------------------------------------------

(_
  (name) @_kw
  .
  (name) @type
  (#match? @_kw "^(?i:type|like|of)$"))

(_
  (name) @_kw
  .
  (name) @_to
  .
  (name) @type
  (#match? @_kw "^(?i:ref)$")
  (#match? @_to "^(?i:to)$"))

((name) @type.builtin
  (#match? @type.builtin "^(?i:abap_bool|c|d|decfloat16|decfloat34|f|i|int1|int2|int8|n|p|string|t|utclong|x|xstring|any|data|clike|csequence|xsequence|numeric|simple|table|index|standard|sorted|hashed)$"))

; ---------------------------------------------------------------------------
; Calls: meth( ), lo_obj->meth( ), zcl=>meth( )
; ---------------------------------------------------------------------------

(call name: (name) @function)

; Class / interface on the left of => and ~
(_
  (name) @type
  .
  (operator) @_op
  (#match? @_op "^(=>|~)$"))

; ---------------------------------------------------------------------------
; Built-ins
; ---------------------------------------------------------------------------

((name) @variable.special
  (#match? @variable.special "^(?i:me|super|sy|syst|sy-[A-Za-z0-9_]+|syst-[A-Za-z0-9_]+|text-[A-Za-z0-9_]+)$"))

((name) @constant.builtin
  (#match? @constant.builtin "^(?i:abap_true|abap_false|abap_undefined|space|initial|null)$"))

; ---------------------------------------------------------------------------
; Keywords
; ---------------------------------------------------------------------------

((name) @keyword
  (#match? @keyword "^(?i:abstract|add|add-corresponding|adjacent|aliases|all|append|appending|as|ascending|assert|assign|assigning|at|authority-check|avg|back|base|begin|binary|blanks|boxed|break-point|by|bypassing|call|case|cast|casting|catch|chain|changing|check|class|class-data|class-events|class-method|class-methods|class-pool|cleanup|clear|client|close|collect|commit|comparing|component|components|compute|concatenate|cond|condense|constants|context|continue|conv|corresponding|count|create|critical|dangerous|data|default|deferred|define|definition|delete|deleting|descending|describe|destination|display|distinct|divide|divide-corresponding|do|duplicates|duration|else|elseif|end|end-enhancement-section|end-of-definition|end-of-file|end-of-page|end-of-selection|endat|endcase|endcatch|endchain|endclass|enddo|endenhancement|endexec|endform|endfunction|endif|endinterface|endloop|endmethod|endmodule|endon|endprovide|endselect|endtry|endwhile|endwith|enhancement|enhancement-point|enhancement-section|entities|entity|enum|event|events|exact|except|exception|exceptions|exec|exit|export|exporting|extract|fetch|field|field-symbol|field-symbols|fields|filter|final|find|first|for|form|format|free|friends|from|function|function-pool|get|global|group|handler|harmless|having|hide|if|ignoring|implementation|import|importing|in|include|index|inheriting|initialization|inner|insert|instance|interface|interface-pool|interfaces|into|join|key|last|leave|left|length|let|level|like|line|load-of-program|local|long|loop|lower|matches|max|medium|message|method|methods|min|mode|modify|module|move|move-corresponding|multiply|multiply-corresponding|new|next|no|non-unique|object|obligatory|occurrences|occurs|of|offset|on|open|optional|order|others|outer|overlay|pack|parameter|parameters|perform|pcre|preferred|primary|private|process|program|protected|provide|public|raise|raising|range|ranges|read|read-only|receive|receiving|redefinition|reduce|ref|refresh|regex|reject|replace|report|reserve|respecting|results|resumable|retry|return|returning|risk|rollback|rows|scan|search|section|select|select-options|selection-screen|separated|set|shift|short|single|skip|sort|sorted|split|standard|start-of-selection|starting|statics|stop|structure|submatches|submit|subtract|subtract-corresponding|sum|supply|switch|table|tables|task|test|testing|then|times|to|top-of-page|transfer|translate|transporting|try|type|type-pool|type-pools|types|unassign|unique|unpack|until|up|update|upper|using|value|values|wait|when|where|while|with|work|write)$"))

; Logical and comparison operators
((name) @keyword.operator
  (#match? @keyword.operator "^(?i:and|or|not|equiv|is|between|bit-and|bit-or|bit-xor|bit-not|mod|div|eq|ne|lt|gt|le|ge|co|cn|ca|na|cs|ns|cp|np|bt|nb|byte-co|byte-cn|byte-ca|byte-na|byte-cs|byte-ns)$"))

; Built-in functions win over keywords that share a name (replace( ), find( ), ...)
(call
  name: (name) @function.builtin
  (#match? @function.builtin "^(?i:abs|boolc|boolx|ceil|char_off|cmax|cmin|concat_lines_of|condense|contains|contains_any_not_of|contains_any_of|cos|count|count_any_not_of|count_any_of|escape|exp|find|find_any_not_of|find_any_of|find_end|floor|frac|from_mixed|insert|ipow|line_exists|line_index|lines|log|log10|match|matches|nmax|nmin|numofchar|repeat|replace|rescale|reverse|round|segment|shift_left|shift_right|sign|sin|sqrt|strlen|substring|substring_after|substring_before|substring_from|substring_to|tan|to_lower|to_mixed|to_upper|translate|trunc|xsdbool|xstrlen)$"))
