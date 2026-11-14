REPORT zgreet.

DATA lv_text TYPE string.

START-OF-SELECTION.
  lv_text = zcl_greeter=>greet( ).
  WRITE lv_text.
