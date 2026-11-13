# README screenshots

The main README shows these images. `auto-indent.gif` is still optional: its `<img>` tag is commented out until the file exists.

Use only code from this repo's `examples/` folder, never real customer or product code: the repo is public.

| File | What to capture | How |
| --- | --- | --- |
| `highlighting.png` | `examples/sample.abap` in the editor, roughly the first 40 lines, project panel closed | `cmd-shift-4`, then `space`, click the Zed window |
| `outline.png` | The outline (`cmd-shift-o`) on `examples/icons-demo/src/zcl_demo_order.clas.abap`, showing the methods nested under `CLASS … IMPLEMENTATION` | Crop to the editor and the outline list |
| `file-icons.png` | The project panel with `examples/icons-demo/src/` expanded, icon theme **Zed (Default) + ABAP** selected | Crop to the panel |
| `auto-indent.gif` (optional) | In a new `.abap` buffer: type `IF lv_x > 0.` Enter, a statement, Enter, `ELSE.`, …, `ENDIF.` | Kap or CleanShot, ≤ 10 s, ≤ 2 MB |

Tips:
- Crop to the Zed window (no macOS menu bar) and keep each PNG under ~500 KB (`sips --resampleWidth 1400 file.png`).
- Use the same Zed theme and font size for every shot.
