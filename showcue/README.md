# Unique AV Show Cue

Show playback for theatre and live events, in the spirit of MiX16 GO — for Windows (Mac build also possible).

- **Cue list with one GO button** – audio, video, image, stop, black-screen, OSC and MIDI cues
- **Audio** – per-cue volume, fade in/out, start/end points, loop, and per-cue output device **and channels** (e.g. send cue 3 to outputs 5–6 of your interface)
- **Video & images on a second screen** – full screen on a projector/TV, fades and crossfades, fit/fill/stretch, hold last frame
- **Follow** – start the next cue *with* this one or *after it ends*, with an optional delay
- **MIDI control** – learn any note/CC/program change for GO, Stop All, Panic, Pause, Prev/Next, a master-volume fader, or to fire a specific cue
- **OSC control** – UDP port 53000 by default; also accepts MiX16-style addresses; optional standby feedback
- **Show files** (`.showcue`) – save/load, double-click to open; media paths are also stored relative to the show file so a show folder can be moved to another PC
- **Show lock**, Pause/Resume All, Stop All with fade, Panic, double-GO protection, live clock and remaining-time counters

## Get the Windows installer (no programming tools needed)

1. In **GitHub Desktop**: *File → Add local repository…* → choose this folder → *Publish repository*.
2. On github.com open the repository → **Actions** tab → **Build Windows installer**. It runs on every push to `main` (or click **Run workflow**).
3. When it finishes (about 5 minutes), open the run and download **Unique-AV-Show-Cue-Windows** → unzip → run the `Setup` `.exe`.

Windows SmartScreen may warn because the installer isn't code-signed; choose *More info → Run anyway*.

## Run or build on a PC yourself

Install [Node.js](https://nodejs.org) (LTS), then in this folder:

```
npm install
npm start          # run the app
npm run dist       # build the Windows installer into dist/
```

## Using it

| Key | Action |
|---|---|
| Space / Enter | GO |
| ↑ / ↓ | Move standby |
| Esc | Stop all (fade) |
| Shift+Esc | Panic – stop now |
| P | Pause / resume all |
| Ctrl+L | Lock / unlock |
| Ctrl+S / Ctrl+O | Save / open show |

- Drag audio, video or image files from Explorer onto the cue list, or use the **Add** buttons.
- Click a cue to make it the standby cue and edit it on the right.
- **Settings (⚙)**: choose the output screen, default audio output, OSC port/feedback and MIDI mappings.
- **Multichannel interfaces**: in Windows *Sound settings → your interface → Configure*, set the speaker layout (e.g. 7.1) so Windows exposes all outputs; then pick channels per cue. Click *Show device names* in Settings if devices appear unnamed.

### OSC

| Address | Action |
|---|---|
| `/showcue/go` `[n]` | GO (optionally standby cue n first) |
| `/showcue/cue n` | Fire cue n without moving standby |
| `/showcue/setgo n` | Set standby to cue n |
| `/showcue/next`, `/showcue/prev` | Move standby |
| `/showcue/stopall`, `/showcue/panic` | Stop with fade / immediately |
| `/showcue/pauseall`, `/showcue/resumeall` | Pause / resume |
| `/showcue/master 0-100` | Master volume |

`/mix16showcue/...` equivalents also work. With a feedback host set, the app sends `/showcue/standby <number> <name>` when standby changes.

### Supported media

Audio: WAV, MP3, M4A/AAC, FLAC, OGG/Opus, AIFF. Video: MP4/MOV/M4V (H.264), WebM, MKV. Images: JPG, PNG, GIF, WebP, BMP, SVG.
ProRes and HEVC/H.265 are not supported — convert those to H.264 MP4 first.

## Project layout

```
src/main.js          app window, menus, show files, OSC, output window, media streaming
src/app.js           cue list, inspector, playback engine, MIDI/OSC handling
src/audio-router.js  per-device / per-channel audio routing and fades
src/output.js        second-screen video/image player
src/osc.js           OSC encoder/decoder
```
