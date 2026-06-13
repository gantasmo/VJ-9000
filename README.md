# VJ-9000

VJ-9000 is a browser-based, audio-reactive visual engine for live performance. It renders a live camera, video clips, or still images through a real-time WebGL effects stack with MIDI-mappable controls and audio reactivity. It runs standalone in a browser and serves as the live-visuals engine embedded in [theDAW](https://github.com/gantasmo/theDAW).

## Capabilities

- **Sources.** A live camera (a local webcam, or a phone, tablet, or headset camera reached over the LAN), video clips, and still-image backdrops. Clips and images load by drag-and-drop or a file picker, and a CAM/MEM crossfader blends the camera against a loaded clip.
- **Effects.** A composable GPU chain covering:
  - Color and optics: hue, saturation, contrast, brightness, invert, edge detect.
  - Geometry: mirror X/Y, kaleidoscope, radial mirror, tiling, equirectangular 360, stereo side-by-side and top-bottom, soft edges.
  - Generative: reaction-diffusion (Gray-Scott), SDF raymarch portal, topographic isolines, fluid displacement.
  - Depth: depth fog, tilt-shift miniature, z-quantized plane splits, and depth-edge outline, all derived from a luminance depth proxy.
  - Distortion and glitch: feedback, glitch, RGB ghost and split, chromatic aberration, buffer backskip, strobe, pixelate, wave warp.
  - Time: playback speed, reverse, posterize-time, echo trails, slit-scan, time displacement.
  - Post: scanlines, vignette, CRT, and CSS-filter looks for sepia, grayscale, and blur.
- **Reactivity and automation.** Audio reactivity from the host player's levels or a local microphone, BPM sync, an auto-LFO, and an Autopilot that sequences effects and clip switches automatically.
- **Control.** Every control is MIDI-mappable, and a performance SOLO mode isolates a single effect for setup.
- **Recording.** Captures the live canvas to WebM (VP9 and Opus) at 720p, 1080p, or 4K. When embedded in theDAW, the take is transcoded by theDAW's backend to H.264, H.265, ProRes, or a PNG sequence.
- **Performance.** Render-scale tiers trade sharpness for frame rate, and the render loop parks itself at roughly 0% GPU when the host tab is backgrounded.

## theDAW integration

Inside theDAW's VJ tab, VJ-9000 runs in an iframe and communicates with the host over `postMessage`:

- theDAW streams its master-player audio levels at about 30fps so the visuals react to whatever is playing, forwards MIDI, and pushes track metadata and play/pause state.
- The host's SLIDE tab stays in two-way sync with VJ-9000's controls, so a fader moved in either place updates the other.
- Clips and images imported into VJ-9000 upload to theDAW's library, and their session `blob:` URLs are replaced with stable library URLs so a cue survives a reload.
- A LAN URL and QR code make the output reachable from a phone or tablet on the same network for a second screen or a camera source.

## Running locally

Prerequisites: Node.js.

```bash
npm install

# Development with HMR:
npm run dev

# Production build and serve (how theDAW runs it):
npm run build
npm run preview
```

theDAW spawns this app automatically as a sidecar, so a manual run is only needed when developing VJ-9000 itself.
