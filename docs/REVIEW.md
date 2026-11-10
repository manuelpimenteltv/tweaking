# Video review

## How frame accuracy works

Browsers report playback position as floating-point seconds and decode to the nearest available frame. Loupe makes frame references exact like this:

1. **Rational frame rates.** ffprobe's rate is stored as `num/den` (e.g. `24000/1001`), never as `23.976`. All timecode math lives in `src/lib/timecode.ts` and is shared by the browser and the server.
2. **Constant-frame-rate review proxies.** The worker (`src/server/jobs/proxy.ts`) re-encodes every video to H.264 at exactly that rate (`-fps_mode cfr`), with a keyframe every 12 frames (`-g 12`) so seeks and steps decode quickly. Variable-frame-rate sources are normalized to their average rate. Comments on VFR media therefore refer to the proxy timeline, and the Details tab flags the source as **VFR**.
3. **Seeking to the middle of a frame.** Going to frame *n* sets `currentTime = (n + 0.5) / fps`, so rounding can't land on the neighbouring frame.
4. **Reading the frame actually shown.** During playback the player uses `requestVideoFrameCallback`, which reports the presented frame's media time. While paused, the frame you stepped to is authoritative, so rapid key presses never lose frames.
5. **Timecode.** Displayed as SMPTE from the clip's start timecode (from the camera or editorial metadata). 29.97 and 59.94 use drop-frame notation (`;`). Comments store the frame number, the rate and the timecode at creation.

The end-to-end test checks this against the frame counter burned into the test video.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Space / K | Play / pause |
| ← / → | Previous / next frame |
| Shift + ← / → | Back / forward 1 second |
| J / L | Back 5 s / play (press again for 2×) |
| Home / End | First / last frame |
| C | Comment at the current frame |
| D | Draw on the current frame |
| A | Show / hide annotations |
| M | Mute |
| F | Fullscreen (double-click on the picture also works) |
| Esc | Stop drawing / deselect |
| ? | Show the shortcut list |

In the comment box: Enter posts, Shift+Enter adds a new line, and `@` opens mention suggestions.

## Data rules

- Comments, replies and drawings belong to **one version**. They are never moved to a new version, because frames can't be mapped reliably between edits. The panel shows how much feedback remains on other versions, with links to them.
- Drawings are vectors in normalized coordinates (`annotations` table), independent of the media. Originals and proxies are never modified.
- Resolve/reopen: editors, project managers and admins can resolve any thread; anyone can resolve threads they started.
- Mentions are only accepted for people who can see the project.
- Authors can delete their own comments (soft delete, which also removes their drawing).

## Documents, slides, spreadsheets and images (Phase 3)

| Format | How it's shown | Comment anchors |
|---|---|---|
| PDF | The original, rendered by PDF.js | Page, or an area of a page (draw to mark it) |
| Word, RTF, ODT, TXT, Pages | LibreOffice → review PDF (labelled as a rendering) | Page / area |
| PowerPoint, ODP, Keynote | LibreOffice → review PDF, slide thumbnails, presentation mode | Slide / area |
| Excel, ODS, Numbers, CSV, TSV | Grid built from the workbook: displayed values, formulas, styles, merges, hidden rows/cols/sheets | Cell (`Sheet!B7`) |
| JPG, PNG, WEBP, GIF, AVIF | Original at full resolution | Area of the image |
| TIFF, PSD, HEIC, BMP… | 4096 px WebP review copy | Area of the image |

Document shortcuts: `PageDown`/`PageUp` next/previous page (←/→ in presentation mode), `+`/`-` zoom, `C` comment, `D` draw, `A` show/hide annotations, `F` fullscreen. Spreadsheet: arrows/Enter/Tab move the selected cell, `C` comments on it. Image: `0` fit, `1` 100%, `+`/`-` zoom.

**Fidelity**: Office files are rendered by LibreOffice. Fonts, SmartArt and complex PowerPoint animations can differ slightly from Microsoft Office. Common Office fonts (Calibri, Cambria via metric-compatible Carlito/Caladea) are installed in the worker image. The original is always available for download.

**Spreadsheets**: values are the ones saved in the file (formulas aren't recalculated). Preview limits are 100,000 rows and 702 columns (A–ZZ) per sheet, and 2 million cells per workbook. Anything beyond is stated on screen.

## Current limits (planned work)

- **Browser color is not a reference monitor.** Proxies are tagged BT.709. HDR sources aren't tone-mapped yet.
- **Progressive MP4 proxies** (1080p/540p) instead of adaptive HLS. That's fine for spots and episodes; adaptive streaming for long-form over slow links is planned (Phase 6).
- **Teammates' new comments appear within 15 seconds** (polling), not instantly. Live updates arrive with notifications (Phase 4), as do email/in-app alerts for @mentions.
- **External clients without an account** can't review yet. Secure review links and the client portal are Phase 4.
- Range comments (in/out) and side-by-side version comparison are not built yet (comparison is Phase 6).
