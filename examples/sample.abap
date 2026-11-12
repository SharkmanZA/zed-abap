*&---------------------------------------------------------------------*
*& Report ZDEMO_ABAP_HIGHLIGHTING
*&---------------------------------------------------------------------*
REPORT zdemo_abap_highlighting.

TABLES: pa0001.

CONSTANTS gc_max TYPE i VALUE 100.

DATA: gt_flights TYPE STANDARD TABLE OF sflight WITH DEFAULT KEY,
      gv_count   TYPE i,
      go_app     TYPE REF TO lcl_app. " application instance

FIELD-SYMBOLS <ls_flight> TYPE sflight.

PARAMETERS p_carr TYPE s_carr_id OBLIGATORY.
SELECT-OPTIONS s_date FOR sy-datum.

CLASS lcl_app DEFINITION FINAL.
  PUBLIC SECTION.
    METHODS run
      IMPORTING iv_carrier      TYPE s_carr_id
      RETURNING VALUE(rv_count) TYPE i
      RAISING   cx_sy_itab_line_not_found.
  PRIVATE SECTION.
    DATA mt_cache TYPE HASHED TABLE OF sflight WITH UNIQUE KEY carrid connid fldate.
ENDCLASS.

CLASS lcl_app IMPLEMENTATION.
  METHOD run.
    SELECT * FROM sflight
      WHERE carrid = @iv_carrier
        AND fldate IN @s_date
      INTO TABLE @DATA(lt_flights)
      UP TO @gc_max ROWS.

    LOOP AT lt_flights ASSIGNING FIELD-SYMBOL(<ls_row>).
      IF <ls_row>-seatsocc > 0 AND <ls_row>-price * 2 >= 1000.
        rv_count = rv_count + 1.
      ELSEIF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
    ENDLOOP.

    DATA(lv_msg) = |Carrier { iv_carrier } has { rv_count WIDTH = 5 ALIGN = RIGHT } flights.\n|.
    DATA(lv_quote) = |Template with "quotes" and \{ braces \}|.
    DATA(lv_lines) = lines( lt_flights ).
    DATA(lv_text) = 'It''s a char literal' && `string literal`.

    mt_cache = VALUE #( FOR ls IN lt_flights WHERE ( price > 0 ) ( ls ) ).
    DATA(ls_first) = lt_flights[ 1 ].
    zcl_logger=>get_instance( )->log( iv_text = lv_msg ) ##NEEDED.
    me->mt_cache = CORRESPONDING #( lt_flights ).

    TRY.
        cl_abap_unit_assert=>assert_equals( act = abap_true exp = xsdbool( rv_count > 0 ) ).
      CATCH cx_root INTO DATA(lx_error).
        MESSAGE lx_error->get_text( ) TYPE 'E'.
    ENDTRY.
  ENDMETHOD.
ENDCLASS.

START-OF-SELECTION.
  go_app = NEW #( ).
  gv_count = go_app->run( p_carr ).
* full-line comment
  WRITE: / 'Flights:', gv_count. "#EC NOTEXT

FORM legacy_form USING pv_value TYPE c.
  CONCATENATE pv_value 'x' INTO DATA(lv_out) SEPARATED BY space.
  /use/cl_namespace=>do_something( ).
ENDFORM.
