INTERFACE zif_demo_order
  PUBLIC.

  TYPES: BEGIN OF ty_item,
           name   TYPE string,
           amount TYPE i,
         END OF ty_item,
         tt_items TYPE STANDARD TABLE OF ty_item WITH EMPTY KEY.

  METHODS add_item
    IMPORTING is_item TYPE ty_item.

  METHODS total
    RETURNING VALUE(rv_total) TYPE i.

ENDINTERFACE.
