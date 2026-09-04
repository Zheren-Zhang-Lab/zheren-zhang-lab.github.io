(() => {
    'use strict';

    // Change the version suffix when returning visitors should see this intro again.
    const STORAGE_KEY = 'zheren-lab-intro-v5';

    // Main timing controls.
    const FULL_IMAGE_HOLD_MS = 900;
    const SURROUNDINGS_FADE_MS = 4700;
    const BUILDING_HOLD_MS = 900;
    const BUILDING_FADE_MS = 1700;
    const FINAL_BLACK_HOLD_MS = 300;
    const HOMEPAGE_REVEAL_MS = 700;
    const EXIT_FADE_MS = 1000;

    const root = document.documentElement;
    const intro = document.getElementById('site-intro');
    const skipButton = document.getElementById('intro-skip');

    if (!intro || !root.classList.contains('intro-active')) return;

    const scene = intro.querySelector('[data-intro-scene="1"]');
    const image = scene.querySelector('img');
    const sketch = intro.querySelector('.intro-sketch');
    const sketchImage = sketch.querySelector('img');
    const iris = intro.querySelector('.intro-iris');
    const blackout = intro.querySelector('.intro-blackout');
    const totalDuration = FULL_IMAGE_HOLD_MS + SURROUNDINGS_FADE_MS
        + BUILDING_HOLD_MS + BUILDING_FADE_MS;
    let stopped = false;
    let finishTimer;
    let handoffTimer;
    let removalTimer;
    let frozenAnimations = [];

    root.style.setProperty('--intro-homepage-reveal', `${HOMEPAGE_REVEAL_MS}ms`);

    // Returning visitors never request the intro image.
    image.src = image.dataset.src;
    sketchImage.src = sketchImage.dataset.src;

    const rememberIntro = () => {
        try { localStorage.setItem(STORAGE_KEY, 'seen'); } catch (_) {}
    };

    const finish = ({ lockBlack = false } = {}) => {
        if (stopped) return;
        stopped = true;
        window.clearTimeout(finishTimer);

        // Preserve the rendered frame throughout the overlay fade. Cancelling here
        // would restore the blackout's CSS opacity (0) and briefly reveal the photo.
        if (lockBlack) blackout.style.opacity = '1';
        frozenAnimations = intro.getAnimations({ subtree: true });
        frozenAnimations.forEach(animation => animation.pause());

        rememberIntro();

        const revealHomepage = () => {
            root.classList.add('intro-revealing');
            intro.classList.add('is-leaving');
            removalTimer = window.setTimeout(() => {
                root.classList.remove('intro-active', 'intro-revealing');
                root.style.removeProperty('--intro-homepage-reveal');
                intro.remove();
                frozenAnimations.forEach(animation => animation.cancel());
                frozenAnimations = [];
            }, EXIT_FADE_MS);
        };

        // Natural completion holds the fully black frame; Skip begins the same soft
        // homepage reveal immediately from whichever frame the visitor skipped.
        if (lockBlack) {
            handoffTimer = window.setTimeout(revealHomepage, FINAL_BLACK_HOLD_MS);
        } else {
            revealHomepage();
        }
    };

    const play = () => {
        scene.style.opacity = '1';

        // The feathered dark perimeter closes around the facade without moving the photo.
        iris.animate([
            { opacity: 0, transform: 'translate(-50%, -50%) scale(3.2)' },
            { opacity: 0.28, transform: 'translate(-50%, -50%) scale(2.35)', offset: 0.22 },
            { opacity: 0.78, transform: 'translate(-50%, -50%) scale(1.38)', offset: 0.68 },
            { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' }
        ], {
            delay: FULL_IMAGE_HOLD_MS,
            duration: SURROUNDINGS_FADE_MS,
            easing: 'cubic-bezier(0.42, 0, 0.2, 1)',
            fill: 'both'
        });

        // During the existing building-hold stage, the photograph resolves into an
        // aligned architectural drawing instead of switching via a CSS filter.
        sketch.animate([
            { opacity: 0 },
            { opacity: 1 }
        ], {
            delay: FULL_IMAGE_HOLD_MS + SURROUNDINGS_FADE_MS,
            duration: BUILDING_HOLD_MS,
            easing: 'cubic-bezier(0.45, 0, 0.22, 1)',
            fill: 'both'
        });

        // Only after the surroundings are dark does the building itself disappear.
        blackout.animate([
            { opacity: 0 },
            { opacity: 1 }
        ], {
            delay: FULL_IMAGE_HOLD_MS + SURROUNDINGS_FADE_MS + BUILDING_HOLD_MS,
            duration: BUILDING_FADE_MS,
            easing: 'cubic-bezier(0.45, 0, 0.25, 1)',
            fill: 'both'
        });

        finishTimer = window.setTimeout(() => finish({ lockBlack: true }), totalDuration);
    };

    skipButton.addEventListener('click', finish);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') finish();
    });

    const ready = image.decode ? image.decode().catch(() => {}) : Promise.resolve();
    ready.then(play);

    window.addEventListener('pagehide', () => {
        window.clearTimeout(finishTimer);
        window.clearTimeout(handoffTimer);
        window.clearTimeout(removalTimer);
    }, { once: true });
})();
