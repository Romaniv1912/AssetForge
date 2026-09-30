# Test & benchmark fixtures

Real-world images from the [scikit-image](https://scikit-image.org) sample data
set (`skimage/data`), used by the test suite and `npm run benchmark`.
Synthetic fixtures (gradients, flat graphics, transparent illustrations with
soft edges, pixel art, huge/tiny images) are generated deterministically by
`tests/helpers/synthetic.ts`.

| File | Content | Source / licence |
| --- | --- | --- |
| `astronaut.png` | Portrait photo (avatar-like), 512×512 | NASA, public domain |
| `chelsea.png` | Photo of a cat, 451×300 | Stéfan van der Walt, CC0 |
| `coffee.png` | Photo of a coffee cup, 600×400 | Rachel Michetti, CC0 |
| `rocket.jpg` | JPEG photo, 640×427 | SpaceX, CC0 |
| `logo.png` | Illustration on white (RGBA container, fully opaque), 500×500 | scikit-image logo, BSD-3-Clause |
| `hubble_deep_field.jpg` | Very detailed JPEG image, 1000×872 | NASA, public domain |
| `text.png` | Grayscale scanned text, 448×172 | scikit-image, public domain |

See scikit-image's `skimage/data/README.txt` for the full attribution.
