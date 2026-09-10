/**
 * Films prepared for offline viewing.
 *
 * The file is meant to leave the app: it lands in the phone's downloads and
 * is opened by whatever plays video there. Nothing here plays it back --
 * this page is about knowing what is ready and freeing the quota.
 */

// While something is being prepared, the page follows along. A film takes
// minutes, so this is a progress bar, not a live feed.
const POLL_MS = 4000;

class DownloadsPage {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('downloads-list');
        this.hint = document.getElementById('downloads-hint');
        this.timer = null;
    }

    async show() {
        await this.refresh();
    }

    hide() {
        clearInterval(this.timer);
        this.timer = null;
    }

    async refresh() {
        let data;
        try {
            data = await API.downloads.list();
        } catch (err) {
            this.container.innerHTML =
                `<div class="empty-state"><p>Could not read the list</p></div>`;
            return;
        }
        this.render(data);

        // Poll only while there is something to watch
        const busy = data.items.some(i => i.status === 'queued' || i.status === 'running');
        clearInterval(this.timer);
        this.timer = busy ? setInterval(() => this.refresh(), POLL_MS) : null;
    }

    render(data) {
        this.hint.textContent =
            `${this.gb(data.used)} of ${this.gb(data.budget)} used`
            + ` · ${this.gb(data.freeBytes)} free on the server`;

        if (!data.items.length) {
            this.container.innerHTML = '<div class="empty-state">'
                + '<p>Nothing downloaded</p>'
                + '<p class="hint">Open a film or an episode and choose Download'
                + ' to keep it for a journey</p>'
                + '</div>';
            return;
        }

        this.container.innerHTML = '';
        for (const item of data.items) {
            this.container.appendChild(this.row(item));
        }
    }

    row(item) {
        const el = document.createElement('div');
        el.className = `download-row status-${item.status}`;

        const state = {
            queued: item.estimate ? `Waiting · about ${this.gb(item.estimate)}` : 'Waiting',
            running: `Preparing… ${Math.round((item.progress || 0) * 100)}%`,
            ready: this.gb(item.size),
            failed: item.error || 'Failed'
        }[item.status] || item.status;

        el.innerHTML = `
            <div class="download-info">
                <div class="download-name">${item.name || item.item_id}</div>
                <div class="download-state">${state}</div>
                ${item.status === 'running'
                ? `<div class="download-bar"><span style="width:${Math.round((item.progress || 0) * 100)}%"></span></div>`
                : ''}
            </div>
            <div class="download-actions"></div>`;

        const actions = el.querySelector('.download-actions');

        if (item.status === 'ready') {
            // A plain link, so the phone's own download manager takes it --
            // which is why the URL carries its own signature rather than
            // relying on the header the app would have added.
            const a = document.createElement('a');
            a.className = 'btn btn-primary';
            a.href = item.link;
            a.setAttribute('download', '');
            a.textContent = 'Save to device';
            actions.appendChild(a);
        }

        if (item.status === 'failed') {
            const retry = document.createElement('button');
            retry.className = 'btn';
            retry.textContent = 'Try again';
            retry.addEventListener('click', async () => {
                await API.downloads.request(item.item_id).catch(() => { });
                this.refresh();
            });
            actions.appendChild(retry);
        }

        const del = document.createElement('button');
        del.className = 'btn media-close-btn';
        del.textContent = item.status === 'running' ? 'Cancel' : 'Remove';
        del.addEventListener('click', async () => {
            await API.downloads.remove(item.item_id).catch(() => { });
            this.refresh();
        });
        actions.appendChild(del);

        return el;
    }

    gb(bytes) {
        // Nothing held is a real figure -- "0.0 GB of 10.0 GB used" -- and
        // has to read differently from a size the server never gave us.
        if (bytes == null) return '—';
        return (bytes / 1024 ** 3).toFixed(1) + ' GB';
    }
}

window.DownloadsPage = DownloadsPage;
