# Takes

A free screen recorder that replaces Loom, in one HTML file.

## Try it

- Open https://takes.guessandclick.net, **or**
- download `dist/takes.html` and double-click it (Chrome or Edge).

There is no account to make and nothing to install.

## What it does

- Records your screen, your microphone and a camera bubble, with pause and stop.
- The bubble can be a circle or a rectangle, in any corner.
- The bubble can play a video file in place of the live camera.
- Real webcams are preferred over virtual cameras automatically.
- Trims both ends and cuts out a middle section, and the saved file matches.
- Makes English captions on your own computer, and you can edit any line.
- Gives you a transcript you can search, click to jump, copy, and save as `.txt`, `.srt` or `.vtt`.
- Burns the captions into the video, if you choose.
- Saves in a tall 9:16 shape, if you choose.
- Downloads as an MP4, or saves into a folder that syncs to your cloud.
- Keeps a private library in your own browser.

## What it does not do

- No hosted share links, view counts or comments.
- Chrome and Edge only.
- Not tested on a Mac.
- Captions are English only, and they download about 50 to 70 MB of tools from free public download servers when you use them.
- Trimmed, cut, burned or vertical saves need the internet for the editing tool, and take a few seconds per minute of video.
- The library lives in one browser on one computer.

## Privacy

Takes never uploads anything. You choose where your files go.

The only outside requests are to `cdn.jsdelivr.net` and `huggingface.co`, which hands the caption model to its own delivery host.
Those requests happen only when you use captions or an edited save.
There are no accounts, no cookies and no tracking.

## How it is built

Many source files in, one file out.
`node build.mjs` joins `src/` into `dist/takes.html`.
`node --test` runs the unit tests (236).
There are no dependencies to install.
It needs Node 22 or newer.

```
node build.mjs
node --test
```

## Credits

- Transformers.js (Apache-2.0) and the Whisper tiny.en model (MIT), for captions.
- Mediabunny (MPL-2.0), for edited saves.
- The Outfit typeface, by the Outfit Project Authors (SIL Open Font License 1.1).

Made by Guess and Click.

License: MIT. See `LICENSE`.
