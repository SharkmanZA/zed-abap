; Text objects for Vim mode: `]m` / `[m` jump between methods, forms, function
; modules and dialog modules; `af` / `if` select one; `]]` / `[[`, `ac` / `ic`
; work on classes and interfaces.

[
  (method_block body: (_)? @function.inside)
  (form_block body: (_)? @function.inside)
  (function_block body: (_)? @function.inside)
  (module_block body: (_)? @function.inside)
] @function.around

; CLASS ... DEFINITION: inside = its sections (and anything before them).
(class_definition
  open: (_)
  [(body) (section)]* @class.inside
  close: (_)?) @class.around

[
  (class_implementation body: (_)? @class.inside)
  (interface_block body: (_)? @class.inside)
] @class.around

(comment)+ @comment.around
