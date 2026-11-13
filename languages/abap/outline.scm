; Outline panel / symbol search (cmd-shift-o).
; Entries nest by range: methods appear under their CLASS ... IMPLEMENTATION,
; METHODS/DATA/... declarations under their CLASS ... DEFINITION or INTERFACE.
; Forward declarations (DEFINITION DEFERRED / LOAD) open no block, so they are
; not listed. Chained declarations (`METHODS: a, b.`) list their first name.

; REPORT zprog. / PROGRAM zprog.
((statement
   .
   (name) @context
   .
   (name) @name)
  (#match? @context "^(?i:report|program)$")) @item

; CLASS lcl DEFINITION ... / CLASS lcl IMPLEMENTATION ... / INTERFACE zif ...
([
  (class_definition open: (statement . (keyword) @context . name: (name) @name . (keyword) @context.extra))
  (class_implementation open: (statement . (keyword) @context . name: (name) @name . (keyword) @context.extra))
  (interface_block open: (statement . (keyword) @context . name: (name) @name))
]) @item

; METHOD run. / METHOD zif_x~save. / FORM x. / FUNCTION z_fm. / MODULE m OUTPUT.
([
  (method_block open: (statement . (keyword) @context . [(name) (keyword) (member_access)] @name))
  (form_block open: (statement . (keyword) @context . [(name) (keyword)] @name))
  (function_block open: (statement . (keyword) @context . [(name) (keyword)] @name))
  (module_block open: (statement . (keyword) @context . [(name) (keyword)] @name))
]) @item

; Declarations in a class definition section or an interface:
; METHODS run ..., DATA mv_x ..., CONSTANTS ..., TYPES ..., EVENTS ...
([
  (section body: (body (statement . (name) @context . [(name) (keyword) (member_access)] @name) @item))
  (interface_block body: (body (statement . (name) @context . [(name) (keyword) (member_access)] @name) @item))
]
  (#match? @context "^(?i:methods|class-methods|data|class-data|constants|types|events|class-events|interfaces|aliases)$")
  (#not-match? @name "^(?i:begin|end)$"))

; Structures: DATA / TYPES / CONSTANTS BEGIN OF name ...
([
  (section body: (body (statement . (name) @context . (name) @_begin . (keyword) . (name) @name) @item))
  (interface_block body: (body (statement . (name) @context . (name) @_begin . (keyword) . (name) @name) @item))
]
  (#match? @context "^(?i:data|class-data|constants|types)$")
  (#match? @_begin "^(?i:begin)$"))
