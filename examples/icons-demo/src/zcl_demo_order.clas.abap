CLASS zcl_demo_order DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES zif_demo_order.

    METHODS constructor
      IMPORTING iv_id TYPE i.

  PRIVATE SECTION.
    DATA mv_id TYPE i.
    DATA mt_items TYPE zif_demo_order=>tt_items.
ENDCLASS.


CLASS zcl_demo_order IMPLEMENTATION.

  METHOD constructor.
    mv_id = iv_id.
  ENDMETHOD.

  METHOD zif_demo_order~add_item.
    APPEND is_item TO mt_items.
  ENDMETHOD.

  METHOD zif_demo_order~total.
    rv_total = REDUCE #( INIT sum = 0
                         FOR item IN mt_items
                         NEXT sum = sum + item-amount ).
  ENDMETHOD.

ENDCLASS.
