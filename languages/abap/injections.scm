; AMDP methods (`METHOD m BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT ...`)
; contain SQLScript. If a SQL language is installed in Zed, highlight it.
((sqlscript) @injection.content
  (#set! injection.language "sql"))
