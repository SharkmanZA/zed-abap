*&---------------------------------------------------------------------*
*& Report zdemo_order_report
*&---------------------------------------------------------------------*
REPORT zdemo_order_report.

PARAMETERS p_id TYPE i DEFAULT 1.

START-OF-SELECTION.
  DATA(lo_order) = NEW zcl_demo_order( p_id ).
  lo_order->zif_demo_order~add_item( VALUE #( name = 'Pen' amount = 3 ) ).

  IF lo_order->zif_demo_order~total( ) > 0.
    WRITE: / |Order { p_id } total:|, lo_order->zif_demo_order~total( ).
  ELSE.
    WRITE: / 'Empty order'.
  ENDIF.
