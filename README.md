# Unique AV Show Cue

Show playback for theatre and live events, in the spirit of MiX16 GO — for Windows and Mac.

- **Cue list with one GO button** – audio, video, image, stop, black-screen, OSC and MIDI cues
- **Audio** – per-cue volume, fade in/out, start/end points, loop, and per-cue output device **and channels** (e.g. send cue 3 to outputs 5–6 of your interface)
- **Video & images on a second screen** – full screen on a projector/TV, fades and crossfades, fit/fill/stretch, hold last frame
- **Waveform trim editor** – select a song and its waveform appears at the bottom: drag the green IN and red OUT markers (or type times), drag the orange square at the top of the IN marker to add a fade-in (or type it in *Fade in*; the waveform shows the fade as it will sound), drag the orange square near OUT for the fade-out, set the cue's *Gain* (−24 to +12 dB; the waveform and peak readout show the result and turn red where it would clip), preview the cut, and tick *Fade at Out* to fade the song out automatically at the cut point. Your audio file is never changed.
- **Follow** – start the next cue *with* this one or *after it ends*, with an optional delay
- **One cue at a time** – Settings → *Playback* (saved with the show): when a cue starts, the previous one fades out (your fade time) or stops at once. Works for GO, pads, MIDI, OSC and keys; cues linked with *Follow: start with* still play together. A yellow *1 at a time* tag in the toolbar shows it's on
- **MIDI control** – learn any note/CC/program change for GO, Stop All, Panic, Pause, Prev/Next, a master-volume fader, or to fire a specific cue
- **MIDI Editor** – click *MIDI* in the top bar (or Ctrl/Cmd+Shift+M). Laid out like MiX16's MIDI editor: one row per control (GO, Stop All, Panic, Pause, Prev/Next, Master) and per cue (Play, Pause, Stop, Volume), plus OUT rows for MIDI cues. Select rows, play a note/CC/program change on your controller (or press a computer key) and click *Assign* – or *Assign Manually…*. Filters, Multiple Selection, a Ch. Note per row, and New / Open / Save / Export (CSV) for the mappings. While it's open your controller only teaches and doesn't fire cues
- **Master meter** – a stereo peak meter next to the master fader shows the audio level going out of every output (audio cues and video sound), with peak hold and a clip warning (click the dB readout to reset it)
- **Mixer** – next to the Playing list, one strip per audio output (the default output plus every interface your cues use) with a level meter, a fader in dB and a mute button, plus a Master strip. Mixer settings are saved with the show
- **Stream Deck / web control** – each Stream Deck button can play a song, GO, stop and more, using the Stream Deck's built-in *Website* action (no plugin needed)
- **OSC control** – UDP port 53000 by default; also accepts MiX16-style addresses; optional standby feedback
- **Show files** (`.showcue`) – save/load, double-click to open; media paths are also stored relative to the show file so a show folder can be moved to another PC
- **Show lock**, Pause/Resume All, Stop All with fade, Panic, double-GO protection, live clock and remaining-time counters

## Get the installers (no programming tools needed)

1. In **GitHub Desktop**: *File → Add local repository…* → choose this folder → *Publish repository*.
2. On github.com open the repository → **Actions** tab → **Build Windows installer**. It runs on every push to `main` (or click **Run workflow**).
3. When it finishes (about 10 minutes), open the run and download **Unique-AV-Show-Cue-Windows** (Setup `.exe`) or **Unique-AV-Show-Cue-Mac** (`.dmg`: `arm64` for Apple Silicon, `x64` for Intel Macs). Released versions are also on the repository's **Releases** page.

Windows SmartScreen may warn because the installer isn't code-signed; choose *More info → Run anyway*.

On a Mac, the app isn't signed with an Apple Developer ID, so the first time macOS may say it "can't be opened" or "is damaged". Fix it once in Terminal:

```
xattr -cr "/Applications/Unique AV Show Cue.app"
```

then open it normally. (Or System Settings → Privacy & Security → *Open Anyway*.)

## Automatic updates

Installed copies check GitHub for a new version when they start and every few hours. **On Windows** updates install themselves (below). **On Mac** the app shows a green *Get 1.x.x* button that opens the download page, because only Apple-signed apps can replace themselves.

On Windows: A new version downloads in the background; a green **Update ready** button then appears top right. Click it to restart and install now, or the update installs the next time the app is closed. The app never restarts by itself, so a show is never interrupted. Turn the checks off (or check manually) in **Settings → Updates**, or use *Help → Check for Updates…*.

**To release an update:**
1. Change `"version"` in `package.json` to a higher number (e.g. `1.1.0` → `1.2.0`).
2. Commit and push in GitHub Desktop.
3. The **Build installers** action builds Windows and Mac versions and publishes a GitHub Release named `v1.2.0`. Every installed copy picks it up.

Pushing without changing the version still builds an installer (under Actions) but does not publish an update.

**The GitHub repository must be public** for installed copies to see updates. With a private repository the build still works, but the update check reports "No published release found".

## Run or build on a PC yourself

Install [Node.js](https://nodejs.org) (LTS), then in this folder:

```
npm install
npm start          # run the app
npm run dist       # build the Windows installer into dist/
npm run dist:mac   # on a Mac: build the Apple Silicon DMG into dist/
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
- **Cutting a song**: select it, then drag the IN/OUT markers on the waveform. Click the waveform and press `I` / `O` to set points at the cursor; ←/→ nudges the cursor. *Hear start* / *Hear end* play the first/last 5 seconds of the cut. Preview plays on the computer's default output, with the cue's gain, and shows on the Default mixer strip.
- **Pads view**: the *☰ List / ▦ Pads* switch in the toolbar shows every cue as a MiX16-style channel strip: name, volume fader, elapsed/remaining time, a big numbered play button, pause, stop and loop. Folders become tabs along the top and there is a Master fader on the right; the Playing list, mixer and waveform stay at the bottom. Click the numbered button to play, click it again while it plays to fade it out (Settings can make it play again on top instead). Pads don't move standby, so GO carries on where it was.
- **MIDI pads**: in the Pads view click *MIDI Learn*, click a pad, then hit a key or pad on your MIDI controller (click anywhere on the strip). Repeat for each pad and click *Done learning* (or Esc). Each pad shows its key; ✕ clears it. A key only belongs to one pad.
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

### Stream Deck

The app listens on this computer for simple web addresses (turn it off or change the port in **Settings → Stream Deck / web control**). To make a button that plays a song:

1. Note the song's number in the app's **#** column (say it is 3).
2. In the Stream Deck app, drag **System → Website** onto a key.
3. In the URL box type `http://localhost:53000/cue/3`.
4. Tick **Access in background** (otherwise a browser window opens every time).
5. Give the key a title, e.g. the song name. Press it: cue 3 plays.

Repeat for each song. Other useful keys:

| URL | Action |
|---|---|
| `http://localhost:53000/go` | GO (fire the standby cue) |
| `http://localhost:53000/cue/3` | Play cue 3 without moving standby |
| `http://localhost:53000/go/3` | Jump standby to cue 3 and GO |
| `http://localhost:53000/standby/3` · `/next` · `/prev` | Move standby |
| `http://localhost:53000/stop` · `/panic` | Stop all with fade / immediately |
| `http://localhost:53000/pause` · `/resume` | Pause / resume all |
| `http://localhost:53000/master/80` | Master volume to 80 |

The Stream Deck must be plugged into the same computer as the app, and the app must be open (it doesn't need to be the front window). The buttons follow cue numbers, so if you renumber cues, update the keys. Space, Esc and P also work through the Stream Deck *Hotkey* action, but only while the app is the front window.

### Supported media

Audio: WAV, MP3, M4A/AAC, FLAC, OGG/Opus, AIFF. Video: MP4/MOV/M4V (H.264), WebM, MKV. Images: JPG, PNG, GIF, WebP, BMP, SVG.
ProRes and HEVC/H.265 are not supported — convert those to H.264 MP4 first.

## Project layout

```
src/main.js          app window, menus, show files, OSC, output window, media streaming
src/app.js           cue list, inspector, playback engine, MIDI/OSC handling
src/waveform.js      waveform trim editor
src/updater.js       automatic updates from GitHub Releases
src/audio-router.js  per-device / per-channel audio routing and fades
src/output.js        second-screen video/image player
src/osc.js           OSC encoder/decoder
```
