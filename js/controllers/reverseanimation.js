import { queryAll } from '../utils/util'

/**
 * Handles playing a frame's incoming animation *in reverse* when the
 * user navigates backwards.
 *
 * reveal.js models a deck as a sequence of frames (still resting states)
 * separated by animations (the transitions *into* each frame). Written out:
 *
 *     a A b B c C
 *
 * where capital letters are still frames and lowercase letters are the
 * animation that precedes/leads into each frame. Navigating forward already
 * plays the incoming animation of the destination frame (reveal.js autoplays
 * embedded media when a slide/fragment becomes visible). Navigating backwards,
 * however, normally jumps to the *previous* frame and autoplays *its* incoming
 * animation forwards — e.g. going back from `B` plays `a` forwards and lands on
 * `A`.
 *
 * This controller changes that: going back from `B` replays `B`'s own incoming
 * animation (`b`) in reverse and rests on `A`.
 *
 * Fragment CSS animations and auto-animate already reverse naturally (they are
 * state based), so they are left to reveal.js' existing behaviour. The case
 * that needs real work — and the one this controller focuses on — is embedded
 * media, since HTML5 `<video>`/`<audio>` cannot reliably play backwards. Two
 * strategies are supported:
 *
 *   1. A pre-reversed companion file, referenced via `data-reverse-src`, is
 *      played forwards through a buffer element layered over the original.
 *      This gives the smoothest result.
 *   2. A runtime fallback that steps `currentTime` backwards on every animation
 *      frame. No extra assets required, though its smoothness depends on how
 *      densely the source video is keyframe encoded.
 *
 * A media element only participates when it carries the `data-reversible`
 * attribute, so decorative, looping or background media is never affected.
 */
export default class ReverseAnimation {

	constructor( Reveal ) {

		this.Reveal = Reveal;

		// True while a reverse animation is playing. Guards against re-entrancy
		// and lets a second backwards key press fast-forward to the end.
		this.isReversing = false;

		// True while we replay the "real" navigation after a reverse animation
		// has finished. Prevents the navigation from being intercepted again.
		this.replaying = false;

		// While true, SlideContent will rest reversible media on its final
		// frame instead of autoplaying it forward when a frame becomes visible.
		this.suppressAutoplay = false;

		// Cancels the reverse animation that is currently in flight, if any.
		this._cancel = null;

	}

	/**
	 * Whether the reverse-animation feature is currently active.
	 */
	isEnabled() {

		return this.Reveal.getConfig().reverseAnimations !== false;

	}

	/**
	 * Called at the top of the backwards navigation methods. If the current
	 * frame has a reversible incoming animation this takes over: it plays that
	 * animation in reverse and, once complete, runs `replayNavigation()` to
	 * perform the actual backwards move (with autoplay suppressed on arrival).
	 *
	 * @param {function} replayNavigation The original navigation call to run
	 * once the reverse animation has finished.
	 * @return {boolean} true if this controller has taken over navigation and
	 * the caller should return immediately, false to proceed as normal.
	 */
	handleBackward( replayNavigation ) {

		// Let the replayed navigation run untouched
		if( this.replaying ) return false;

		if( !this.isEnabled() ) return false;

		// Reverse animations only make sense in the regular linear view
		if( this.Reveal.getConfig().rtl ) return false;
		if( this.Reveal.isScrollView() || this.Reveal.isOverview() || this.Reveal.isPrintView() ) return false;

		// A second backwards press while reversing fast-forwards to the end
		if( this.isReversing ) {
			if( this._cancel ) this._cancel();
			return true;
		}

		let target = this.getReversibleTarget();
		if( !target ) return false;

		this.isReversing = true;

		this.playReverse( target.media ).then( () => {

			this.isReversing = false;
			this._cancel = null;

			// Perform the real backwards navigation, resting the destination
			// frame's incoming media on its final frame rather than replaying
			// it forwards.
			this.suppressAutoplay = true;
			this.replaying = true;
			replayNavigation();
			this.replaying = false;
			this.suppressAutoplay = false;

		} );

		return true;

	}

	/**
	 * Locates the reversible incoming media for the frame we are about to
	 * leave. Supports both the "fragment" model (each fragment is a frame) and
	 * the "slide" model (each slide is a frame).
	 *
	 * @return {?{frame: HTMLElement, media: HTMLMediaElement}}
	 */
	getReversibleTarget() {

		let slide = this.Reveal.getCurrentSlide();
		if( !slide ) return null;

		// Fragment model: the current fragment is the frame being left
		let currentFragment = slide.querySelector( '.fragment.current-fragment' );
		if( currentFragment ) {
			let media = currentFragment.querySelector( 'video[data-reversible], audio[data-reversible]' );
			if( media ) return { frame: currentFragment, media };
		}

		// Only intercept if there is somewhere to navigate back to.
		if( this.Reveal.getSlidePastCount() > 0 ) {

			// Slide model: a reversible media element that isn't in a fragment
			let media = queryAll( slide, 'video[data-reversible], audio[data-reversible]' )
				.find( el => !el.closest( '.fragment' ) );
			if( media ) return { frame: slide, media };

			// Background video model (e.g. Manim Slides). The <video> lives in
			// the slide's separate .slide-background element.
			if( this.Reveal.getConfig().reverseBackgroundVideos && slide.slideBackgroundElement ) {
				let bgVideo = slide.slideBackgroundElement.querySelector( 'video' );
				if( bgVideo ) {
					// A pre-reversed companion clip may be supplied on the
					// section via data-background-video-reverse. Forward it to
					// the video as data-reverse-src so the smooth buffer path is
					// used instead of runtime seeking.
					let reverseSrc = slide.getAttribute( 'data-background-video-reverse' );
					if( reverseSrc && !bgVideo.hasAttribute( 'data-reverse-src' ) ) {
						bgVideo.setAttribute( 'data-reverse-src', reverseSrc );
					}
					return { frame: slide, media: bgVideo };
				}
			}
		}

		return null;

	}

	/**
	 * Plays the given media element in reverse.
	 *
	 * @param {HTMLMediaElement} media
	 * @return {Promise} resolves once the reverse animation has finished (or
	 * has been fast-forwarded).
	 */
	playReverse( media ) {

		return new Promise( resolve => {

			let done = false;
			let cleanup = () => {};

			const finish = () => {
				if( done ) return;
				done = true;
				cleanup();
				resolve();
			};

			let reverseSrc = media.getAttribute( 'data-reverse-src' );

			if( reverseSrc ) {

				// Strategy 1: play a pre-reversed companion file forwards
				let buffer = this.getReverseBuffer( media, reverseSrc );

				const onEnded = () => finish();
				cleanup = () => {
					buffer.removeEventListener( 'ended', onEnded );
					buffer.pause();
					buffer.style.display = 'none';
				};

				buffer.addEventListener( 'ended', onEnded );
				buffer.currentTime = 0;
				// Override the default `display: none` from the stylesheet
				buffer.style.display = 'block';

				let promise = buffer.play();
				if( promise && typeof promise.catch === 'function' ) {
					promise.catch( () => finish() );
				}

				// Fast-forward jumps straight to the reversed end state
				this._cancel = () => finish();

			}
			else {

				// Strategy 2: step currentTime backwards each animation frame
				let rafId = null;
				let last = null;
				let rate = media.playbackRate || 1;

				media.pause();

				// Make sure we start from the resting (final) frame
				if( isFinite( media.duration ) && media.currentTime === 0 ) {
					media.currentTime = Math.max( 0, media.duration - 0.001 );
				}

				const step = timestamp => {
					if( last === null ) last = timestamp;
					let delta = ( timestamp - last ) / 1000;
					last = timestamp;

					let time = media.currentTime - rate * delta;
					if( !isFinite( time ) || time <= 0 ) {
						media.currentTime = 0;
						finish();
						return;
					}

					media.currentTime = time;
					rafId = requestAnimationFrame( step );
				};

				cleanup = () => {
					if( rafId ) cancelAnimationFrame( rafId );
				};

				// Fast-forward snaps to the start of the clip (the previous
				// frame's resting image)
				this._cancel = () => {
					try { media.currentTime = 0; } catch( e ) {}
					finish();
				};

				rafId = requestAnimationFrame( step );

			}

		} );

	}

	/**
	 * Lazily creates (and positions) a hidden `<video>` layered over the given
	 * media element that plays the pre-reversed source.
	 *
	 * @param {HTMLMediaElement} media
	 * @param {string} reverseSrc
	 * @return {HTMLVideoElement}
	 */
	getReverseBuffer( media, reverseSrc ) {

		let buffer = media._reverseBuffer;

		if( !buffer ) {
			buffer = document.createElement( 'video' );
			buffer.className = 'reverse-buffer';
			buffer.src = reverseSrc;
			buffer.muted = true;
			buffer.defaultMuted = true;
			buffer.playsInline = true;
			buffer.setAttribute( 'playsinline', '' );
			buffer.setAttribute( 'data-ignore', '' );
			buffer.preload = 'auto';
			media.parentNode.appendChild( buffer );
			media._reverseBuffer = buffer;
		}

		// Position the buffer exactly over the original media element
		let parent = media.parentNode;
		if( getComputedStyle( parent ).position === 'static' ) {
			parent.style.position = 'relative';
		}

		buffer.style.position = 'absolute';
		buffer.style.left = media.offsetLeft + 'px';
		buffer.style.top = media.offsetTop + 'px';
		buffer.style.width = media.offsetWidth + 'px';
		buffer.style.height = media.offsetHeight + 'px';
		buffer.style.objectFit = getComputedStyle( media ).objectFit;
		buffer.style.zIndex = 10;

		return buffer;

	}

	/**
	 * Navigate to the previous/next slide *without* playing any animation,
	 * resting the destination on its still (final) frame. This is the
	 * counterpart to the animated left/right navigation and is used for
	 * "jump" navigation, e.g. bound to the up/down arrow keys via the
	 * `instantNavigation` config option.
	 *
	 * @param {'next'|'prev'} direction
	 */
	restNavigate( direction ) {

		let navigate = direction === 'next' ? this.Reveal.navigateRight : this.Reveal.navigateLeft;

		// replaying: skip the reverse-animation interception on backwards moves.
		// suppressAutoplay: rest the destination media on its final frame
		// rather than playing its animation.
		this.replaying = true;
		this.suppressAutoplay = true;
		try {
			navigate( { skipFragments: true } );
		}
		finally {
			this.suppressAutoplay = false;
			this.replaying = false;
		}

	}

	/**
	 * Rests a reversible media element on its final frame (its still image),
	 * paused. This is the state a frame settles into after its incoming
	 * animation has played, and the state we want when landing on a frame by
	 * navigating backwards.
	 *
	 * @param {HTMLMediaElement} media
	 */
	restMedia( media ) {

		const rest = () => {
			try {
				media.pause();
				if( isFinite( media.duration ) && media.duration > 0 ) {
					media.currentTime = Math.max( 0, media.duration - 0.001 );
				}
			}
			catch( e ) {}
		};

		if( media.readyState >= 1 && isFinite( media.duration ) ) {
			rest();
		}
		else {
			media.addEventListener( 'loadedmetadata', rest, { once: true } );
		}

	}

}
