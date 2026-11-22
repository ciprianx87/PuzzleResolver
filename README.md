# 🧩 Puzzle Resolver

A phone-friendly web app that helps you finish a real jigsaw puzzle. You take three photos:

1. **Box**: the finished picture on the box lid.
2. **Built**: what you have already assembled.
3. **Pieces**: the loose pieces spread out on a plain, even background.

The app then works **one line at a time** (row or column). It highlights the loose pieces that belong in the
next line and draws arrows to where they go in your puzzle. Each piece also gets a small arrow that shows which
way is *up*, so you know how to turn it.

Everything runs in the browser on your phone. No photos are uploaded anywhere.

## Using it

Open the site on your phone (see *Hosting* below) and go through the four tabs:

| Step | What to do |
|------|------------|
| **1 · Box** | Take or pick a photo of the box picture and drag the 4 corners onto the picture's corners. Enter the number of pieces. The app estimates columns × rows; correct them if needed (count the pieces along one edge). The grid overlay should line up with the picture. |
| **2 · Built** | Photograph the puzzle from straight above and drag the corners to where the corners of the *finished* puzzle will be. The app compares every cell with the box picture and marks the filled ones in green. Tap a cell to fix a mistake. |
| **3 · Pieces** | Spread pieces face up on a plain cloth, board or table so they don't touch, and photograph them. Detected pieces are outlined; red outlines mean touching pieces. Use the sensitivity slider if the outlines are off. |
| **4 · Solve** | Shows the next incomplete row. Coloured arrows go from each piece to its cell. Use ◀ ▶ to change line, or switch to columns. After placing the pieces, tap **✓ I placed these** to move on without retaking photos. |

**👁 Preview** (on the Pieces and Solve steps) places *every* loose piece in the photo at once and shows what the
puzzle would look like. Each piece is cut out of your photo, turned upright and drawn in its best cell, tabs
included. Uncertain guesses get an orange dashed border. Cells with no matching piece in the photo yet are
hatched and show the box picture faded, so you can see at a glance what is still missing.

The **Demo** button generates a synthetic 48-piece puzzle so you can try the whole flow without a real one.

### Your photos are kept

Your photos are stored in the browser on your device (IndexedDB), exactly as you took them. The app does not
keep the smaller copies it uses for processing. It also asks the browser to keep this storage permanently. Only
what *you* entered is saved next to the photos:

- the corner positions, saved as fractions of the image size so they don't depend on resolution
- the grid size and background sensitivity
- cells you corrected by tapping, and cells marked by **✓ I placed these**
- where the pieces you placed were in the pieces photo, matched by position rather than detection order

Everything the algorithm computes (filled cells, piece outlines, matches) is recomputed from the saved photos
every time the app loads. When the app is updated with a better algorithm, your existing photos are processed
again automatically and you don't need to retake them. This also protects your progress when a mobile browser
reloads the page while the camera is open.

Photos stay on the device and browser where they were taken. **Reset** clears everything.

## How it works

- **Rectification**: the 4 corners define a homography. The box picture and the built puzzle are both warped to
  the same flat grid of `cols × rows` cells.
- **Filled cells**: an 8×8 Lab-colour descriptor of the centre of each cell in the built photo is compared with
  the same cell of the box picture. A colour calibration is estimated from the cells that agree. Otsu
  thresholding in log space then separates filled cells from empty ones.
- **Piece segmentation**: the background colour is modelled from the photo border on a coarse block grid, which
  tolerates uneven light. Pixels far from it are foreground; the mask is cleaned up with morphology and split
  into connected components.
- **Piece pose**: the orientation (mod 90°) comes from a histogram of outline normals, refined by maximising the
  edge sharpness of the projection profiles. The centre and size of the square core come from the width
  profiles; the narrow tabs drop out.
- **Matching**: each piece's core is described at 4 rotations and scored against every empty cell. The piece
  colours are first calibrated against the still-empty part of the box picture. Pieces are assigned to the
  line's cells greedily by a two-way softmax confidence. Low-confidence guesses are shown dashed.
- **Preview**: all available pieces are assigned to all empty cells at once with the Hungarian algorithm (minimum
  total appearance distance, one piece per cell), using the same confidence measure.

The code is plain ES modules with no build step and no dependencies:

```
index.html, css/style.css
js/app.js         UI flow, state, persistence
js/geometry.js    homography + perspective warp
js/segment.js     background model, piece mask, pose estimation
js/match.js       descriptors, filled detection, scoring, line assignment
js/render.js      overlay with arrows, match cards
js/quadeditor.js  draggable corner editor with magnifier
js/demo.js        synthetic puzzle generator
tools/eval.js     accuracy check on synthetic puzzles
```

Accuracy check (in the browser console on the running site):

```js
const e = await import('/tools/eval.js'); await e.run(20)
```

## Hosting

It is a static site.

- **GitHub Pages**: Settings → Pages → *Deploy from branch* → `main` / root. Then open
  `https://<user>.github.io/PuzzleResolver/` on your phone.
- **Local network**: run `python -m http.server 8765` in this folder and open `http://<your-PC-IP>:8765` on
  your phone (same Wi-Fi). The camera works through the file picker, so HTTPS is not required.

## Tips for good results

- Shoot from straight above in even light, without flash glare.
- Use a background whose colour differs from the puzzle (for example a plain sheet or a dark board).
- Keep pieces apart and face up. Photograph a few dozen at a time rather than all of them.
- If the box picture is cropped or has a border, place the corners exactly on the picture area.
