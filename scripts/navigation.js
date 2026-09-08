(() => {
    // Keep ordinary links working when JavaScript or HTTP fetching is unavailable.
    if (!window.fetch || !window.history.pushState || !/^https?:$/.test(location.protocol)) return;

    const container = document.querySelector('.container');
    const contentSelector = ':scope > [data-page-content]';
    if (!container || !container.querySelector(contentSelector)) return;

    const directory = new URL('.', location.href);
    const pageKey = (url) => url.pathname.replace(/\/$/, '/index.html') + url.search;
    const readPage = (doc) => ({
        content: doc.querySelector('.container > [data-page-content]'),
        title: doc.title,
        description: doc.querySelector('meta[name="description"]')?.content || ''
    });
    let currentURL = new URL(location.href);
    let pendingRequest;
    let panelAnimation;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pages = new Map([[pageKey(currentURL), readPage(document)]]);
    // Cache a detached copy so focus and loading attributes cannot alter it.
    pages.get(pageKey(currentURL)).content = pages.get(pageKey(currentURL)).content.cloneNode(true);

    const status = document.createElement('p');
    status.className = 'navigation-status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    container.querySelector('#navbar').after(status);

    history.scrollRestoration = 'manual';

    function finishResize() {
        panelAnimation?.cancel();
        panelAnimation = undefined;
        container.classList.remove('is-resizing');
    }

    function replaceContent(content) {
        // Start at the visible height, even if a previous resize is still running.
        const startHeight = getComputedStyle(container).height;
        finishResize();
        container.querySelector(contentSelector).replaceWith(content);
        const endHeight = getComputedStyle(container).height;
        if (reducedMotion.matches || !container.animate || startHeight === endHeight) {
            return Promise.resolve();
        }

        container.classList.add('is-resizing');
        const animation = container.animate([
            { height: startHeight },
            { height: endHeight }
        ], {
            duration: 1200,
            easing: 'cubic-bezier(0.4, 0, 0.2, 1)'
        });
        panelAnimation = animation;
        return animation.finished.catch(() => {}).then(() => {
            if (panelAnimation === animation) finishResize();
        });
    }

    // Return to natural sizing if the viewport or motion preference changes.
    window.addEventListener('resize', finishResize);
    reducedMotion.addEventListener('change', finishResize);

    function saveScroll() {
        // During Back/Forward, the address changes before the content arrives.
        if (pendingRequest || pageKey(new URL(location.href)) !== pageKey(currentURL)) return;
        history.replaceState({ ...history.state, pageScroll: [scrollX, scrollY] }, '');
    }

    function updateNavigation() {
        container.querySelectorAll('#navbar a[href]').forEach((link) => {
            if (pageKey(new URL(link.href)) === pageKey(currentURL)) {
                link.setAttribute('aria-current', 'page');
            } else {
                link.removeAttribute('aria-current');
            }
        });
    }

    function restorePosition(url, position) {
        if (position) {
            window.scrollTo(position[0], position[1]);
            return;
        }
        let anchor;
        try {
            anchor = document.getElementById(decodeURIComponent(url.hash.slice(1)));
        } catch {
            // A malformed fragment should not interrupt page navigation.
        }
        if (anchor) anchor.scrollIntoView();
        else window.scrollTo(0, 0);
    }

    async function navigate(url, { fromHistory = false, position } = {}) {
        pendingRequest?.abort();
        pendingRequest = undefined;
        if (!fromHistory) saveScroll();
        const request = new AbortController();
        pendingRequest = request;
        container.setAttribute('aria-busy', 'true');
        status.hidden = true;

        try {
            const key = pageKey(url);
            let page = pages.get(key);
            if (!page) {
                const response = await fetch(url.href, { signal: request.signal });
                if (!response.ok) throw new Error('Page request failed');
                const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
                page = readPage(doc);
                if (!page.content) throw new Error('Page content is missing');
                pages.set(key, page);
            }
            // A newer click always wins, including when it uses a cached page.
            if (request.signal.aborted) return;

            const content = document.importNode(page.content, true);
            // Include photos in the destination height before starting the resize.
            await Promise.allSettled(Array.from(content.querySelectorAll('img'), (image) => image.decode()));
            if (request.signal.aborted) return;
            if (!fromHistory) history.pushState({ pageScroll: [0, 0] }, '', url.href);
            const resized = replaceContent(content);
            currentURL = url;
            document.title = page.title;
            document.querySelector('meta[name="description"]').content = page.description;
            updateNavigation();

            const heading = content.querySelector('h1') || content;
            heading.setAttribute('tabindex', '-1');
            heading.focus({ preventScroll: true });
            if (!fromHistory && !url.hash) restorePosition(url);
            await resized;
            if (request.signal.aborted) return;
            // Saved positions and anchors may only exist once the panel has grown.
            if (fromHistory || url.hash) restorePosition(url, position);
        } catch (error) {
            if (request.signal.aborted) return;
            if (fromHistory) {
                // Do not leave the address bar describing different content.
                location.reload();
                return;
            }
            status.textContent = 'This page could not be loaded. Please try the link again.';
            status.hidden = false;
        } finally {
            if (pendingRequest === request) {
                pendingRequest = undefined;
                container.removeAttribute('aria-busy');
                saveScroll();
            }
        }
    }

    document.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
            event.shiftKey || event.altKey) return;
        const link = event.target.closest('a[href]');
        if (!link || link.hasAttribute('download') ||
            (link.target && link.target !== '_self')) return;
        const url = new URL(link.href);
        if (url.origin !== location.origin || new URL('.', url).href !== directory.href ||
            (!url.pathname.endsWith('.html') && !url.pathname.endsWith('/'))) return;

        if (pageKey(url) === pageKey(currentURL) &&
            pageKey(new URL(location.href)) === pageKey(currentURL)) {
            pendingRequest?.abort();
            pendingRequest = undefined;
            container.removeAttribute('aria-busy');
            status.hidden = true;
            // Let the browser handle same-page anchors, including a bare #.
            if (link.getAttribute('href').includes('#')) return;
            event.preventDefault();
            restorePosition(url);
            return;
        }
        event.preventDefault();
        navigate(url);
    });

    window.addEventListener('popstate', (event) => {
        navigate(new URL(location.href), {
            fromHistory: true,
            position: event.state?.pageScroll
        });
    });
    let scrollFrame;
    window.addEventListener('scroll', () => {
        if (scrollFrame) return;
        scrollFrame = requestAnimationFrame(() => {
            scrollFrame = undefined;
            saveScroll();
        });
    }, { passive: true });

    saveScroll();
    updateNavigation();
})();
