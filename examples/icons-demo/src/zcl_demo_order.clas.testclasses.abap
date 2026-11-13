CLASS ltc_order DEFINITION FINAL FOR TESTING
  DURATION SHORT
  RISK LEVEL HARMLESS.

  PRIVATE SECTION.
    METHODS total_sums_items FOR TESTING.
ENDCLASS.


CLASS ltc_order IMPLEMENTATION.

  METHOD total_sums_items.
    DATA(lo_order) = NEW zcl_demo_order( 1 ).
    lo_order->zif_demo_order~add_item( VALUE #( name = 'Pen' amount = 3 ) ).
    lo_order->zif_demo_order~add_item( VALUE #( name = 'Ink' amount = 4 ) ).

    cl_abap_unit_assert=>assert_equals( act = lo_order->zif_demo_order~total( )
                                        exp = 7 ).
  ENDMETHOD.

ENDCLASS.
