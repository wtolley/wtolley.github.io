(() => {
    // Keep ordinary links working when JavaScript or HTTP fetching is unavailable.
    if (!window.fetch || !window.history.pushState || !/^https?:$/.test(location.protocol)) return;

    const container = document.querySelector('.container');
    const contentSelector = ':scope > [data-page-content]';
    if (!container || !container.querySelector(contentSelector)) return;

    const siteRoot = new URL('../', document.currentScript.src);
    // The persistent navbar must keep pointing to the site root after a deep link.
    container.querySelectorAll('#navbar a[href]').forEach((link) => {
        link.href = new URL(link.getAttribute('href'), location.href).href;
    });
    const topLevelPages = new Set(Array.from(container.querySelectorAll('#navbar a[href]'), (link) => new URL(link.href).pathname));
    const pageKey = (url) => url.pathname.replace(/\/$/, '/index.html') + url.search;
    function readPage(doc, url) {
        const content = doc.querySelector('.container > [data-page-content]')?.cloneNode(true);
        // Imported markup otherwise resolves relative URLs against the *previous* page.
        content?.querySelectorAll('[href], [src], [poster]').forEach((element) => {
            for (const attribute of ['href', 'src', 'poster']) {
                const value = element.getAttribute(attribute);
                if (value && !value.startsWith('#')) element.setAttribute(attribute, new URL(value, url).href);
            }
        });
        return { content, title: doc.title, description: doc.querySelector('meta[name="description"]')?.content || '' };
    }
    let currentURL = new URL(location.href);
    let pendingRequest;
    let resizeAnimation;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pages = new Map([[pageKey(currentURL), readPage(document, currentURL)]]);
    // Cache a detached copy so focus and loading attributes cannot alter it.
    pages.get(pageKey(currentURL)).content = pages.get(pageKey(currentURL)).content.cloneNode(true);

    const status = document.createElement('p');
    status.className = 'navigation-status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    container.querySelector('#navbar').after(status);

    history.scrollRestoration = 'manual';

    function finishResize() {
        resizeAnimation?.cancel();
        resizeAnimation = undefined;
        container.classList.remove('is-resizing');
    }

    function replaceContent(content) {
        // Capture the visible content size before interrupting an earlier resize.
        const previousContent = container.querySelector(contentSelector);
        const previousStyle = getComputedStyle(previousContent);
        const startSize = {
            height: previousContent.getBoundingClientRect().height,
            marginTop: previousStyle.marginTop,
            marginBottom: previousStyle.marginBottom
        };
        finishResize();
        previousContent.replaceWith(content);
        const contentStyle = getComputedStyle(content);
        const endSize = {
            height: contentStyle.height,
            marginTop: contentStyle.marginTop,
            marginBottom: contentStyle.marginBottom
        };
        // Main and the home-page wrapper have different padding and box sizing.
        const boxExtra = content.getBoundingClientRect().height - parseFloat(endSize.height);
        startSize.height = `${Math.max(0, startSize.height - boxExtra)}px`;
        if (reducedMotion.matches || !content.animate ||
            (startSize.height === endSize.height &&
             startSize.marginTop === endSize.marginTop &&
             startSize.marginBottom === endSize.marginBottom)) {
            return Promise.resolve();
        }

        // Animate the inner box; the outer panel's natural height follows it exactly.
        container.classList.add('is-resizing');
        const animation = content.animate([startSize, endSize], {
            duration: 1200,
            easing: 'cubic-bezier(0.4, 0, 0.2, 1)'
        });
        resizeAnimation = animation;
        return animation.finished.catch(() => {}).then(() => {
            if (resizeAnimation === animation) finishResize();
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
            const destination = new URL(link.href);
            const isCoursePage = currentURL.pathname.startsWith(new URL('courses/', siteRoot).pathname);
            if (pageKey(destination) === pageKey(currentURL) ||
                (isCoursePage && destination.pathname === new URL('teaching.html', siteRoot).pathname)) {
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
                page = readPage(doc, new URL(response.url || url.href));
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
        const isCoursePage = url.pathname.startsWith(new URL('courses/', siteRoot).pathname);
        if (url.origin !== location.origin ||
            (!topLevelPages.has(url.pathname) && !isCoursePage && url.pathname !== siteRoot.pathname) ||
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
