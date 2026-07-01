# Reverse Animations

This fork adds **reverse animations**: when you navigate *backwards* over a frame
whose incoming animation is a media element, that animation is replayed **in
reverse** instead of jumping to the previous frame and playing *its* animation
forwards.

## The problem it solves

Think of a deck as a sequence of frames (still resting states) separated by
animations (the transitions *into* each frame):

```
a  A  b  B  c  C
```

Capital letters are still frames; lowercase letters are the animation that leads
into each frame. So `b` is the animation that carries you from `A` into `B`.

- **Forward already works.** On frame `B`, pressing <kbd>→</kbd> plays animation
  `c` forwards and rests on `C`. reveal.js autoplays a frame's incoming media
  when it becomes visible.
- **Backwards used to be wrong.** On frame `B`, pressing <kbd>←</kbd> jumped to
  the previous frame `A` and autoplayed *its* incoming animation `a` forwards.
- **Now it's right.** On frame `B`, pressing <kbd>←</kbd> replays `B`'s own
  incoming animation (`b`) in reverse and rests on `A`.

## Usage

Mark the incoming media element of a frame with `data-reversible`:

```html
<section>
  <h3>Frame B</h3>
  <video src="b.mp4" data-autoplay data-reversible></video>
</section>
```

- Frames may be **separate slides** (each `<section>` is a frame) or
  **fragments** within a slide (each `.fragment` is a frame). Both work.
- Only media with `data-reversible` participates, so decorative, looping or
  background videos are never affected.
- The still a frame rests on is the video's **final frame**. Author each clip so
  its last frame matches the still, and its first frame matches the previous
  frame's still, and forward/backward navigation will line up seamlessly.

### Fragment example

```html
<section>
  <div class="fragment"><video src="b.mp4" data-autoplay data-reversible></video></div>
  <div class="fragment"><video src="c.mp4" data-autoplay data-reversible></video></div>
</section>
```

## How reverse playback is produced

HTML5 `<video>` cannot reliably play backwards (negative `playbackRate` is
effectively unsupported in Chrome), so two strategies are available:

### 1. Pre-reversed companion file (smoothest) — `data-reverse-src`

Provide a separately encoded, reversed version of the clip:

```html
<video
  src="b.mp4"
  data-reverse-src="b-reversed.mp4"
  data-autoplay
  data-reversible
></video>
```

When navigating backwards the reversed clip is played *forwards* through a hidden
buffer element (`.reverse-buffer`) layered exactly over the original, giving
smooth, decoder-friendly playback. Create the reversed clip with e.g.:

```sh
ffmpeg -i b.mp4 -vf reverse -af areverse b-reversed.mp4
```

### 2. Runtime seek (no extra assets)

If no `data-reverse-src` is given, the video is stepped backwards a frame at a
time by decrementing `currentTime` on each animation frame. This needs no extra
files, but its smoothness depends on how densely the source is keyframe encoded —
seeking backwards across sparse keyframes is expensive. For smooth results with
this approach, encode with dense keyframes (ideally all-intra), e.g.:

```sh
ffmpeg -i b.mp4 -g 1 -c:v libx264 -preset slow b-allintra.mp4
```

## Configuration

The feature is on by default and can be disabled globally:

```js
Reveal.initialize({
  reverseAnimations: true // default; set false to disable
});
```

## Other animation types

reveal.js has three animation mechanisms. Reverse animations focus on the one
that needs it:

| Mechanism | Reversing backwards |
| --- | --- |
| Fragment CSS animations (`fade-up`, `grow`, …) | Already reverse naturally — hiding a fragment plays its transition backwards. No change. |
| [Auto-Animate](https://revealjs.com/auto-animate/) | Already reverses — backwards navigation runs the FLIP from current → previous. No change. |
| Embedded media (`<video>` / `<audio>`) | Handled by this feature via `data-reversible`. |

## Notes & limitations

- A second <kbd>←</kbd> press while a reverse animation is in flight
  fast-forwards it to the end and completes the move.
- Reverse animations apply to the standard linear/horizontal + vertical views.
  They are skipped in scroll view, overview, print view, and RTL decks.
- `<audio>` is supported by the runtime-seek strategy the same way as video.

See [`examples/reverse-animation.html`](../examples/reverse-animation.html) for a
runnable demo.
