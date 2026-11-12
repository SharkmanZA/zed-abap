; Outline panel / symbol search (cmd-shift-o).
; The grammar is flat, so entries are not nested; CLASS ... DEFINITION and
; CLASS ... IMPLEMENTATION show as separate entries. Forward declarations
; (DEFINITION DEFERRED / LOAD) are skipped. Interface method implementations
; (`METHOD zif_x~meth.`) are labelled with the full `zif_x~meth`.

((statement
   .
   (name) @context
   .
   [(name) (member_access)] @name
   (#match? @context "^(?i:report|program|class|interface|method|form|function|module)$")) @item
  (#not-match? @item "(?i)\\s(deferred|load)\\s*\\.$"))
