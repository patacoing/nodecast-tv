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
// twenty with a d-pad before losing patience; the category page is there
// for the ones who want the rest.
const ROW_LIMIT = 20;

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
