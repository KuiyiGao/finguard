# Particle textures

Six textures from the **Particle Pack** (version 1.1) by Kenney (Kenney Vleugels, kenney.nl):
https://kenney.nl/assets/particle-pack

License: **Creative Commons Zero (CC0 1.0)**, http://creativecommons.org/publicdomain/zero/1.0/
("You may use these assets in personal and commercial projects. Credit is not mandatory.")

They come from the pack's `PNG (Transparent)` folder. Each was downscaled from 512 px to 64 px with
`sips -Z 64` and renamed. They are white or gray shapes on a transparent background.
`components/particles` tints them at runtime with the theme's color tokens.

| File | Original | Used for |
|---|---|---|
| `glow.png` | `circle_05.png` | soft motes, halos, the breathing glow |
| `spark.png` | `flare_01.png` | sparks along the scan sweep, glints at the gate |
| `star.png` | `star_06.png` | burst stars when a receipt is sealed |
| `ring.png` | `circle_02.png` | the shockwave ring of a burst, impact rings |
| `magic.png` | `magic_05.png` | sparkling motes while Steward gathers from a source |
| `trace.png` | `trace_07.png` | streaks drawn along the velocity of fast particles |

Total size: about 18 KB.
