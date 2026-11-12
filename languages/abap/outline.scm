; Outline panel / symbol search (cmd-shift-o).
; The grammar is flat, so entries are not nested; CLASS ... DEFINITION and
; CLASS ... IMPLEMENTATION show as separate entries.

(statement
  .
  (name) @context
  .
  (name) @name
  (#match? @context "^(?i:report|program|class|interface|method|form|function|module)$")) @item
