/**
 * A page of horizontal rows, one per category.
 *
 * A dropdown holding thirty-four categories is a poor way to browse
 * anything, and a hopeless one with a remote: you cannot see what is in a
 * category without choosing it, and choosing it means walking a list.
 * Rows put the categories and their contents on the same screen.
 *
 * Rows are built as they are needed. Thirty-four categories of up to six
 * hundred films each is far more than a Fire TV will render at once, so a
 * few rows go up immediately and the rest follow as the page is scrolled.
 */

// Items shown per row. The row scrolls horizontally, and nobody walks past
// a dozen with a d-pad before losing patience. It is also a memory budget:
// each poster is a decoded bitmap, and they add up fast.
const ROW_LIMIT = 12;

// Rows built before the scroll sentinel takes over.
const FIRST_ROWS = 3;

class CategoryRows {
    /**
     * @param {HTMLElement} container
     * @param {function} makeCard  (item) => HTMLElement
     */
    constructor(container, makeCard) {
        this.container = container;
        this.makeCard = makeCard;
        this.groups = [];
        this.built = 0;

        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) this.buildNext();
        }, { rootMargin: '300px' });
    }

    /**
     * Empty the rows that are far off screen and refill them when they come
     * back. Without this, browsing a catalogue of this size just keeps
     * allocating: measured on the device after eight scrolls, twelve rows
     * held 169 decoded posters and 114MB of bitmap, none of it ever
     * released. A Fire TV Stick does not have that to spare, and what it
     * does instead is draw frames in pieces.
     *
     * The section keeps the height it had, so nothing jumps.
     */
    recycle() {
        const keep = window.innerHeight * 2;
        for (const section of this.container.querySelectorAll('.cat-row')) {
            const box = section.getBoundingClientRect();
            const far = box.bottom < -keep || box.top > window.innerHeight + keep;
            const scroller = section.querySelector('.horizontal-scroll');
            if (!scroller) continue;

            if (far && scroller.children.length) {
                // Never empty the row the selection is standing in
                if (section.contains(document.activeElement)) continue;
                section.style.minHeight = box.height + 'px';
                scroller.replaceChildren();
                scroller.dataset.emptied = '1';
            } else if (!far && scroller.dataset.emptied) {
                const group = this.groups[Number(section.dataset.index)];
                if (!group) continue;
                for (const item of group.items.slice(0, ROW_LIMIT)) {
                    const card = this.makeCard(item);
                    if (card) scroller.appendChild(card);
                }
                delete scroller.dataset.emptied;
                section.style.minHeight = '';
            }
        }
    }

    /** @param {Array} groups  [{ title, items }] */
    render(groups) {
        this.observer.disconnect();
        this.groups = (groups || []).filter(g => g.items?.length);
        this.built = 0;
        this.container.innerHTML = '';
        // The grid container is a centred flex wrap; rows need a block
        this.container.classList.add('showing-rows');

        if (this.groups.length === 0) {
            this.container.innerHTML =
                '<div class="empty-state"><p>Nothing here</p></div>';
            return;
        }

        this.sentinel = document.createElement('div');
        this.sentinel.className = 'cat-rows-sentinel';
        this.container.appendChild(this.sentinel);

        for (let i = 0; i < FIRST_ROWS; i++) this.buildNext();
        this.observer.observe(this.sentinel);

        this.onScroll = this.onScroll || (() => {
            clearTimeout(this.recycleTimer);
            this.recycleTimer = setTimeout(() => this.recycle(), 200);
        });
        this.container.removeEventListener('scroll', this.onScroll);
        this.container.addEventListener('scroll', this.onScroll, { passive: true });
    }

    buildNext() {
        const group = this.groups[this.built];
        if (!group) {
            this.observer.disconnect();
            this.sentinel?.remove();
            return;
        }
        this.built++;

        const section = document.createElement('section');
        section.className = 'cat-row';
        section.dataset.index = String(this.built - 1);

        const heading = document.createElement('h3');
        heading.className = 'cat-row-title';
        heading.textContent = group.title;
        section.appendChild(heading);

        const scroller = document.createElement('div');
        scroller.className = 'horizontal-scroll';
        for (const item of group.items.slice(0, ROW_LIMIT)) {
            const card = this.makeCard(item);
            if (card) scroller.appendChild(card);
        }
        section.appendChild(scroller);

        this.container.insertBefore(section, this.sentinel);
    }

    destroy() {
        this.observer.disconnect();
        clearTimeout(this.recycleTimer);
        this.container.removeEventListener('scroll', this.onScroll);
    }
}

/**
 * Category names come decorated the way channel groups do -- "─ ✧･ﾟ||
 * Comédies" -- and the decoration is noise on a heading.
 */
CategoryRows.cleanTitle = function (name) {
    let text = String(name || '').trim();

    // "─ ✧･ﾟ|| Comédies": everything up to the last pipe is ornament, but
    // only when it holds no letters or digits of its own -- "Canal+ | Ciné"
    // must keep both halves. Note that some of the ornament these
    // providers use is classified as a letter, so a plain \p{L} strip
    // stops in the middle of it.
    const piped = text.match(/^(.*?)[|｜]+\s*(.+)$/);
    if (piped && !/[a-z0-9]/i.test(piped[1])) text = piped[2];

    // Leading and trailing rules, dots and box-drawing
    const ORNAMENT = '\\s\\-–—_.·•*=~#─━│┃✧✦★☆･｡ﾟﾞ';
    text = text.replace(new RegExp(`^[${ORNAMENT}]+`), '')
        .replace(new RegExp(`[${ORNAMENT}]+$`), '');
    return text.trim() || String(name || '').trim();
};

window.CategoryRows = CategoryRows;
