; Auto-indent.
;
; Zed indents the lines after the start of an @indent range by one level and,
; when a range ends, aligns the next line with the row the range started on.
; Ranges start at the block's first line (no @start), so END... / ELSE / WHEN
; align with the line holding the opening keyword even when the opening
; statement spans several lines (`CLASS zcl DEFINITION` / `PUBLIC` / `...`).
;
; Pressing Enter right after an opening statement (`IF x.`) is covered by these
; ranges whenever anything follows (an unclosed IF extends to the enclosing
; END...), and by `increase_indent_pattern` in config.toml otherwise.

; Blocks: everything between the opening and the closing statement is one
; level in (CASE: the WHEN lines; CLASS ... DEFINITION: the SECTION lines).
[
  (case_block close: (_)? @end)
  (loop_block close: (_)? @end)
  (do_block close: (_)? @end)
  (while_block close: (_)? @end)
  (select_block close: (_)? @end)
  (at_block close: (_)? @end)
  (method_block close: (_)? @end)
  (form_block close: (_)? @end)
  (function_block close: (_)? @end)
  (module_block close: (_)? @end)
  (catch_system_exceptions_block close: (_)? @end)
  (class_definition close: (_)? @end)
  (class_implementation close: (_)? @end)
  (interface_block close: (_)? @end)
] @indent

; IF / TRY as a whole: from just after the keyword to the closing statement,
; so ENDIF / ENDTRY align with IF / TRY even in code where ELSE or CATCH is
; indented differently (the SAP pretty printer puts CATCH 2 in from TRY).
; Starting after the keyword keeps this range separate from the first
; clause's range, which starts on the same row.
[
  (if_block (if_clause open: (statement . (keyword) @start)) close: (_)? @end)
  (try_block (try_clause open: (statement . (keyword) @start)) close: (_)? @end)
] @indent

; Clauses (IF / ELSEIF / ELSE, WHEN, TRY / CATCH / CLEANUP, ... SECTION): one
; level in for the statements each one governs. A clause's range runs up to
; the next clause or the closing statement, not just its last statement, so
; Enter at the end of a clause body (or in an empty clause) stays in the body,
; and a closing statement after a column-0 `*` comment still lines up with
; its opener. Comments between the two are skipped.
(_
  [
    (if_clause)
    (elseif_clause)
    (else_clause)
    (when_clause)
    (try_clause)
    (catch_clause)
    (cleanup_clause)
    (section)
  ] @indent
  .
  (comment)*
  .
  [
    (elseif_clause)
    (else_clause)
    (when_clause)
    (catch_clause)
    (cleanup_clause)
    (section)
    (statement)
  ] @end)

; Event blocks (START-OF-SELECTION, AT SELECTION-SCREEN, ...) have no closing
; statement. Their range runs up to the next event, FORM, CLASS, ... (skipping
; comments, which may sit on the last statement's line), so Enter after an
; event's last statement stays in the event. The last event in a file has
; nothing after it: there increase_indent_pattern indents its first line, and
; later lines keep the line above's indentation.
(source_file
  (event_block (body)) @indent
  .
  (comment)*
  .
  (_) @end)

; The last clause of an unclosed block: up to the end of the clause.
[
  (if_clause)
  (elseif_clause)
  (else_clause)
  (when_clause)
  (try_clause)
  (catch_clause)
  (cleanup_clause)
  (section)
] @indent
