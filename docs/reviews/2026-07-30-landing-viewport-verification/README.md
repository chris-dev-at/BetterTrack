# Landing phone viewport verification — PR #973

These screenshots provide the visual acceptance evidence for #955’s landing-header
breakpoint. They were captured at a 760 CSS-pixel height using Chromium at the
named viewport widths. `before` is the landing site from
`f2de78f2006713bfeae1ea115c7eadbfb1cf3758`, immediately before this PR’s landing
commit; `after` is this PR’s landing site with registration discovery answered as
`open`.

`manifest.json` records each viewport’s document width. The changed header has no
horizontal overflow in either language at 320, 360, 375, or 400 CSS pixels.
The baseline visibly overflows at English 320px and German 320px/360px; the
screenshots preserve the before/after comparison even where the older layout
happened to fit.

| Language | 320px                                                   | 360px                                                   | 375px                                                   | 400px                                                   |
| -------- | ------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| English  | [before](en-320-before.png) / [after](en-320-after.png) | [before](en-360-before.png) / [after](en-360-after.png) | [before](en-375-before.png) / [after](en-375-after.png) | [before](en-400-before.png) / [after](en-400-after.png) |
| Deutsch  | [before](de-320-before.png) / [after](de-320-after.png) | [before](de-360-before.png) / [after](de-360-after.png) | [before](de-375-before.png) / [after](de-375-after.png) | [before](de-400-before.png) / [after](de-400-after.png) |
