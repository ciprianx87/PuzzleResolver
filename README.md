# 🧩 Puzzle Resolver

A phone-friendly web app that helps you finish a real jigsaw puzzle. You take three photos:

1. **Box**: the finished picture on the box lid.
2. **Built**: what you have already assembled.
3. **Pieces**: the loose pieces spread out on a plain, even background.

The app then shows **where the loose pieces you photographed go**. It only shows the pieces it is confident
about, most confident first, and draws arrows from each piece to its spot in your puzzle. Each piece also gets a
small arrow that shows which way is *up*, so you know how to turn it.

Everything runs in the browser on your phone. No photos are uploaded anywhere.

## Using it

Open the site on your phone (see *Hosting* below) and go through the four tabs:

| Step | What to do |
|------|------------|
| **1 · Box** | Take or pick a photo of the box picture and drag the 4 corners onto the picture's corners. A sideways or upside-down photo is fine: the app turns it to match your puzzle (or use **↻ Rotate picture**). Enter the number of pieces. The app estimates columns × rows; correct them if needed by counting the pieces along one edge. |
| **2 · Built** | Photograph the puzzle from straight above and drag the corners to where the corners of the *finished* puzzle will be. Check that the grid lines follow the seams between pieces. Cells covered by the assembled puzzle are marked in green; loose pieces lying on the cloth are not counted. Tap a cell to fix a mistake. |
| **3 · Pieces** | Spread pieces face up on a plain cloth or board and photograph them from above. Add as many photos as you need, each of a different part of the cloth. Floor, chairs or the box at the edges are ignored. Detected pieces are outlined; red marks groups of touching pieces, which are skipped. Use the sensitivity slider if the outlines are off. |
| **4 · Solve** | Shows where the loose pieces in your photos go, ten at a time, most confident first. Coloured arrows go from each piece to its cell; ◀ ▶ shows the next ten. Pieces the app isn't sure about are left out unless you tick **Show guesses too**. After placing the pieces, tap **✓ I placed these** to move on without retaking photos. **Grey scale: shapes & lines from nearby pieces** is a second method that ignores colours and light: it only fills the gaps next to the assembled puzzle, using the piece shapes, the lines that continue from the neighbouring pieces and the box picture in grey. **Grow from my assembled pieces** fills the gaps next to your assembled pieces one at a time, at every rotation, and each proposed piece must also fit the next ones (tabs and blanks, outlines, lines across the seam). It keeps several alternatives (backtracking) and lists the pieces in the order to place them; a piece is never shown as surer than the proposed pieces it leans on. |

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
- **Box orientation**: each 90° rotation of the box picture that fits the puzzle's shape is compared with the
  assembled cells, and the best one is kept.
- **Filled cells**: the cloth colour is learned from around the puzzle. The built photo is segmented like a
  pieces photo, and everything that isn't cloth or a loose piece counts as assembled. A cell is filled when
  the assembled puzzle covers its middle, allowing a small offset for a bowed border. When no surface is visible
  around the puzzle, the app falls back to comparing colours with the box picture.
- **Piece segmentation**: the cloth is the photo's dominant colour, modelled on a coarse block grid that
  tolerates uneven light. Anything far from it is foreground. Blobs touching the photo edge (floor, chair, box)
  or much bigger than a piece (assembled sections) are ignored, and a loose piece must be surrounded by cloth.
  Groups of touching pieces are split at their narrow necks using distance-transform seeds. Blobs without a
  piece-like square core, and pieces sitting edge to edge on a grid (an assembled row in the photo), are
  dropped.
- **Piece pose**: the orientation (mod 90°) is where the mask's projection profiles have the sharpest steps
  (the straight core edges line up with the axes), searched over the full 0–90° range with anti-aliased profiles.
  The centre and size of the square core come from the width profiles; the narrow tabs drop out.
- **Matching the picture**: each piece is cut out of its photo, core plus tabs, with the cloth that shows through
  its blanks masked out, and slid over the box picture around every empty cell (masked normalised
  cross-correlation per Lab channel, coarse pass over all cells, then a finer pass over the best 30). This compares
  the structure of the picture and ignores brightness and contrast, which differ a lot between the box print and
  the pieces on the table. Before that, the box picture is bent onto the puzzle with a smooth shift field measured
  on the assembled cells (a box lid is never flat; shifts of half a cell are normal). A calibrated colour term and a
  contrast term (a striped piece doesn't belong in plain sky) are added, box areas covered by a sticker or
  starburst are left out, and cells that resemble every piece are corrected for (hub correction).
- **Shape**: each side is classified as tab, blank or flat: border cells need flat sides and interior cells must
  not have them. Next to an assembled piece, the built photo shows whether its tab pokes into the gap, so the new
  piece needs a blank there, or a tab otherwise. Each side's outline is also compared with the hole the assembled
  neighbours leave, and the colours along it with the neighbour's edge.
- **Placement**: all loose pieces are assigned to the empty cells at once with the Hungarian algorithm (minimum
  total distance, one piece per cell). Each placement gets a two-way softmax confidence (how much better this cell
  is than others for the piece, and this piece than others for the cell). Solve and Preview show only confident
  placements unless guesses are asked for.

The code is plain ES modules with no build step and no dependencies:

```
index.html, css/style.css
js/app.js         UI flow, state, persistence
js/geometry.js    homography + perspective warp
js/segment.js     background model, piece mask, pose estimation
js/match.js       descriptors, filled detection, scoring, assignment
js/template.js    picture matching: box shift field, piece templates, masked correlation
js/grow.js        growing outwards from the assembled pieces (beam search with piece-to-piece fit)
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

After changing any file in `js/` or `css/`, run `python tools/stamp.py` before committing. It writes each file's
content fingerprint into `index.html`, so a phone that cached an older version never mixes old and new files.

## Limitations

- Areas of one uniform colour (a plain sky, pale water) can't be told apart by the picture; only the shape cues
  next to assembled pieces narrow them down. Expect those pieces to stay unsure.
- A box photo with a crease, glare or an inset picture printed over part of it misleads the matching there. Take
  the box photo flat, without glare, filling the frame.
- Pieces lying against each other are split apart, but their outlines are less exact: keep them apart.
- A piece photographed twice (overlapping photos) is treated as two pieces.
- Corners found by *Auto corners* are a starting point. Check them, especially on a box photo.

## Tips for good results

- Shoot from straight above in even light, without flash glare.
- Use a background whose colour differs from the puzzle (for example a plain sheet or a dark board).
- Keep pieces apart and face up. Photograph a few dozen at a time rather than all of them.
- If the box picture is cropped or has a border, place the corners exactly on the picture area.
