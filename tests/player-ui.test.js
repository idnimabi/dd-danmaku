import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../ede.js', import.meta.url), 'utf8');
const functionNames = [
    'initUI', 'stopUIInit', 'finishUIWait', 'getVideoOsdView', 'isUIVisible', 'getActiveVideoOsdView', 'toVersionArray', 'compareVersion', 'getById', 'getByClass',
    'waitForElement', 'destroyAllInterval', 'addHeaderClock', 'removeHeaderClock',
    'onVideoOsdShow', 'onVideoOsdHide', 'beforeDestroy', 'videoTimeUpdateInterval',
    'createDanmaku', 'loadDanmaku', 'onPlaybackStart', 'onPlaybackStop',
];
const functions = functionNames.map(name => {
    const match = source.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`, 'm'));
    assert.ok(match, `Missing function: ${name}`);
    return match[0];
}).join('\n');

// A small DOM fixture for the selectors and node moves used by the player UI.
class Element {
    constructor(tagName = 'div', className = '') {
        this.observers = [];
        this.tagName = tagName;
        this.className = className;
        this.id = '';
        this.children = [];
        this.parentNode = null;
        this.style = {};
    }

    get className() {
        return this._className;
    }

    set className(value) {
        this._className = value;
        this.notifyMutation('attributes');
    }

    get parentElement() {
        return this.parentNode?.tagName === '#document' ? null : this.parentNode;
    }

    notifyMutation(type) {
        for (let node = this; node; node = node.parentNode) {
            for (const { observer, options } of node.observers) {
                if ((node === this || options.subtree) && options[type === 'attributes' ? 'attributes' : 'childList']) {
                    observer.records.push({ type, target: this });
                }
            }
        }
    }

    getClientRects() {
        if (!this.isConnected) return [];
        for (let node = this; node; node = node.parentNode) {
            if (node.className.split(' ').some(name => ['hide', 'page-hidden'].includes(name)) || node.style.display === 'none' || node.hidden) return [];
        }
        return [{}];
    }

    closest(selector) {
        for (let node = this; node; node = node.parentElement) {
            if (node.matches(selector)) return node;
        }
        return null;
    }

    get isConnected() {
        return this.tagName === '#document' || !!this.parentNode?.isConnected;
    }

    append(child) {
        child.remove();
        this.children.push(child);
        child.parentNode = this;
        this.notifyMutation('childList');
    }

    appendChild(child) {
        this.append(child);
    }

    prepend(child) {
        child.remove();
        this.children.unshift(child);
        child.parentNode = this;
        this.notifyMutation('childList');
    }

    insertBefore(child, reference) {
        assert.equal(reference.parentNode, this);
        child.remove();
        this.children.splice(this.children.indexOf(reference), 0, child);
        child.parentNode = this;
        this.notifyMutation('childList');
    }

    remove() {
        if (this.parentNode) {
            this.parentNode.children = this.parentNode.children.filter(child => child !== this);
            this.parentNode.notifyMutation('childList');
            this.parentNode = null;
        }
    }

    matches(selector) {
        const classes = this.className.split(' ');
        if (selector.includes(':not(.hide)') && classes.includes('hide')) return false;
        selector = selector.replaceAll(':not(.hide)', '');
        if (selector.startsWith('#')) return this.id === selector.slice(1);
        if (selector.startsWith('.')) return classes.includes(selector.slice(1));
        if (selector === this.tagName) return true;
        return selector === 'div[data-type="video-osd"]' && this.dataType === 'video-osd';
    }

    querySelectorAll(selector) {
        const parts = selector.split(' ');
        const descendants = this.children.flatMap(child => [child, ...child.descendants()]);
        return descendants.filter(child => {
            if (!child.matches(parts[parts.length - 1])) return false;
            let ancestor = child.parentNode;
            for (let index = parts.length - 2; index >= 0; index--) {
                while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentNode;
                if (!ancestor) return false;
                ancestor = ancestor.parentNode;
            }
            return true;
        });
    }

    descendants() {
        return this.children.flatMap(child => [child, ...child.descendants()]);
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }
}

function setup({ buttonsReady = true, serverVersion = '4.8.10.0', clockEnabled = true } = {}) {
    const document = new Element('#document');
    document.createElement = tag => new Element(tag);
    const header = new Element('div', 'headerMiddle');
    const page = new Element('div', 'graphicContentContainer');
    page.dataType = 'video-osd';
    const controls = new Element('div', 'videoOsdBottom-maincontrols');
    const buttons = new Element('div', 'videoOsdBottom-buttons');
    const media = new Element('video');
    media.currentTime = 0;
    document.append(media);
    document.append(header);
    document.append(page);
    page.append(controls);
    if (buttonsReady) controls.append(buttons);

    const intervals = new Map();
    const timeouts = new Map();
    const observers = new Set();
    const settings = { clock: clockEnabled, height: 100, speed: 1, engine: 'canvas', switch: true, offset: 5 };
    const calls = { loads: [], created: [], cleared: 0, destroyed: 0, observed: [], disconnected: 0, stopPct: 0, filterCancelled: 0 };
    let time = Date.UTC(2026, 9, 25, 12);
    let nextId = 1;
    const context = vm.createContext({
        document,
        console: { log() {} },
        window: { ede: { episode_info: {}, danmaku: null, destroyIntervalIds: [] } },
        ApiClient: { serverVersion: () => serverVersion },
        setInterval(callback) { const id = nextId++; intervals.set(id, callback); return id; },
        clearInterval(id) { intervals.delete(id); },
        setTimeout(callback) { const id = nextId++; timeouts.set(id, callback); return id; },
        clearTimeout(id) { timeouts.delete(id); },
        getComputedStyle: element => ({ visibility: element.style.visibility || 'visible' }),
        MutationObserver: class {
            constructor(callback) {
                this.callback = callback;
                this.targets = new Set();
                this.records = [];
                observers.add(this);
            }
            observe(target, options) {
                this.targets.add(target);
                target.observers.push({ observer: this, options });
            }
            disconnect() {
                for (const target of this.targets) {
                    target.observers = target.observers.filter(entry => entry.observer !== this);
                }
                this.targets.clear();
                this.records = [];
            }
        },
        Date: class extends Date {
            constructor() { super(time); }
        },
        lsGetItem: id => settings[id],
        lsSetItem(id, value) { settings[id] = value; },
        buildProgressBarChart() {},
        embyButton: () => new Element('button'),
        loadOnlineDanmaku: type => calls.loads.push(type),
        onPlaybackStopPct() { calls.stopPct++; },
        danmakuAutoFilterCancel() { calls.filterCancelled++; },
        danmakuParser: comments => comments,
        danmakuFilter: comments => comments,
        buildCurrentDanmakuInfo() {},
        appendvideoOsdDanmakuInfo() {},
        Danmaku: class {
            constructor(options) { this.options = options; calls.created.push(this); }
            show() { this.visible = true; }
            hide() { this.visible = false; }
            clear() { calls.cleared++; }
            destroy() { calls.destroyed++; }
        },
        ResizeObserver: class {
            observe(element) { calls.observed.push(element); }
            disconnect() { calls.disconnected++; }
        },
    });
    vm.runInContext(`
        let mediaContainerQueryStr = '.graphicContentContainer';
        let isVersionOld = false;
        let uiInitIntervalId = null;
        let uiObserver = null;
        let uiView = null;
        let headerClockIntervalId = null;
        const notHide = ':not(.hide)';
        const mediaQueryStr = 'video';
        const check_interval = 200;
        const LOAD_TYPE = { CHECK: 'check', INIT: 'init' };
        const styles = { colors: { highlight: 'blue' } };
        const currentDanmakuInfoContainerId = 'danmakuTab2';
        const classes = {
            videoOsdBottomButtons: 'videoOsdBottom-buttons',
            videoOsdBottomButtonsTopRight: 'videoOsdBottom-buttons-topright',
            videoOsdBottomButtonsRight: 'videoOsdBottom-buttons-right',
        };
        const eleIds = { danmakuCtr: 'danmakuCtr', danmakuWrapper: 'danmakuWrapper' };
        const mediaBtnOpts = [{ label: 'switch' }, { label: 'settings' }];
        const lsKeys = {
            osdHeaderClockEnable: { id: 'clock' }, osdLineChartEnable: { id: 'chart' },
            timelineOffset: { id: 'offset', defaultValue: 0 },
            heightPercent: { id: 'height' }, debugShowDanmakuWrapper: { id: 'debugWrapper' },
            speed: { id: 'speed' }, engine: { id: 'engine' }, switch: { id: 'switch' },
            useFetchPluginXml: { id: 'pluginXml' },
        };
        ${functions}
    `, context);
    return {
        context, document, header, page, controls, buttons, media, intervals, timeouts, observers, settings, calls,
        advanceTime(ms) { time += ms; },
        tick() {
            for (const [id, callback] of Array.from(intervals)) {
                if (intervals.has(id)) callback();
            }
            for (const observer of observers) {
                const records = observer.records.splice(0);
                if (records.length) observer.callback(records);
            }
        },
        menu: () => document.querySelector('#danmakuCtr'),
        leave: () => context.beforeDestroy({ detail: { type: 'video-osd' } }),
    };
}

test('hiding the clock preserves pending button and danmaku-container initialization', async () => {
    const h = setup({ buttonsReady: false });
    h.context.onVideoOsdShow({ type: 'video-osd-show' });
    const pending = h.context.waitForElement('#danmakuContainer', null, 0);
    h.context.onVideoOsdHide({ type: 'video-osd-hide' });
    assert.equal(h.document.querySelector('#headerClock'), null);
    h.tick(); // The outer controls exist, but the inner button area is still absent.
    assert.equal(h.menu(), null);
    h.controls.append(h.buttons);
    const container = new Element();
    container.id = 'danmakuContainer';
    h.page.append(container);
    h.tick();
    assert.equal(await pending, container);
    assert.equal(h.menu().children.length, 2);
    assert.equal(h.intervals.size, 0);
});

test('repeated entries create exactly two buttons and release all timers on exit', () => {
    const h = setup();
    for (let entry = 0; entry < 3; entry++) {
        h.context.onVideoOsdShow({ type: 'video-osd-show' });
        h.tick();
        assert.equal(h.document.querySelectorAll('#danmakuCtr').length, 1);
        assert.equal(h.menu().children.length, 2);
        h.leave();
        assert.equal(h.menu(), null);
        assert.equal(h.document.querySelector('#headerClock'), null);
        assert.equal(h.intervals.size, 0);
        assert.ok(Array.from(h.observers).every(observer => observer.targets.size === 0));
    }
});

test('repeated initialization while rendering is pending does not duplicate buttons', () => {
    const h = setup({ buttonsReady: false });
    h.context.initUI();
    h.context.initUI();
    h.tick();
    assert.equal(h.intervals.size, 1);
    h.controls.append(h.buttons);
    h.tick();
    h.context.initUI();
    assert.equal(h.document.querySelectorAll('#danmakuCtr').length, 1);
    assert.equal(h.menu().children.length, 2);
    assert.equal(h.intervals.size, 0);
});

test('leaving while controls are pending cancels initialization until the next entry', () => {
    const h = setup({ buttonsReady: false });
    h.context.initUI();
    h.leave();
    h.controls.append(h.buttons);
    h.tick();
    assert.equal(h.menu(), null);
    assert.equal(h.intervals.size, 0);
    h.context.initUI();
    assert.equal(h.menu().children.length, 2);
});

test('a menu left in a hidden old page is moved into the current player', () => {
    const h = setup();
    h.context.initUI();
    const menu = h.menu();
    const oldPage = new Element('div', 'graphicContentContainer hide');
    h.document.insertBefore(oldPage, h.page);
    oldPage.append(menu);
    h.context.initUI();
    assert.equal(h.menu(), menu);
    assert.equal(menu.parentNode, h.buttons);
    assert.equal(oldPage.children.length, 0);
});

test('showing the OSD restores removed buttons and follows the visible layout', () => {
    const h = setup();
    const topRight = new Element('div', 'videoOsdBottom-buttons-topright hide');
    h.controls.append(topRight);
    h.context.initUI();
    h.menu().remove();
    h.context.onVideoOsdShow({ type: 'video-osd-show' });
    assert.equal(h.menu().children.length, 2);
    const menu = h.menu();
    h.buttons.className += ' hide';
    topRight.className = 'videoOsdBottom-buttons-topright';
    h.context.onVideoOsdShow({ type: 'video-osd-show' });
    assert.equal(menu.parentNode, topRight);
    h.buttons.className = 'videoOsdBottom-buttons';
    h.context.onVideoOsdShow({ type: 'video-osd-show' });
    assert.equal(menu.parentNode, h.buttons);
    assert.equal(h.document.querySelectorAll('#danmakuCtr').length, 1);
});

test('old clients keep the menu before the right-hand buttons', () => {
    const h = setup({ serverVersion: '4.7.0' });
    h.page.className = '';
    const rightButtons = new Element('div', 'videoOsdBottom-buttons-right');
    h.buttons.append(rightButtons);
    h.context.initUI();
    assert.deepEqual(h.buttons.children, [h.menu(), rightButtons]);
});

test('replacing or detaching the clock does not leak timers or stop unrelated tasks', () => {
    const h = setup();
    const unrelated = h.context.setInterval(() => {});
    h.context.window.ede.destroyIntervalIds.push(unrelated);
    h.context.addHeaderClock();
    const previousClock = h.document.querySelector('#headerClock');
    h.context.addHeaderClock();
    assert.equal(previousClock.isConnected, false);
    assert.equal(h.intervals.size, 2);
    h.document.querySelector('#headerClock').remove();
    h.tick();
    assert.equal(h.intervals.size, 1);
    assert.ok(h.intervals.has(unrelated));
    h.leave();
    assert.equal(h.intervals.size, 0);
});

test('playback starts loading once and OSD visibility changes do not reload danmaku', () => {
    const h = setup();
    h.context.onPlaybackStart({ type: 'playbackstart' });
    assert.deepEqual(h.calls.loads, ['init']);
    assert.equal(h.context.window.ede.loading, true);
    h.context.onVideoOsdShow({ type: 'video-osd-show' });
    h.context.onVideoOsdHide({ type: 'video-osd-hide' });
    h.context.onVideoOsdShow({ type: 'video-osd-show' });
    assert.deepEqual(h.calls.loads, ['init']);
    assert.equal(h.calls.destroyed, 0);
    assert.equal(h.calls.cleared, 0);
});

test('danmaku creation survives clock hiding while waiting for the player container', async () => {
    const h = setup();
    h.page.className += ' hide';
    h.context.onVideoOsdShow({ type: 'video-osd-show' });
    const comments = [{ text: 'hello', time: 1 }];
    const pending = h.context.createDanmaku(comments);
    h.context.onVideoOsdHide({ type: 'video-osd-hide' });
    h.tick();
    assert.equal(h.calls.created.length, 0);
    h.page.className = 'graphicContentContainer';
    h.tick();
    await pending;
    const engine = h.context.window.ede.danmaku;
    assert.equal(engine.options.comments, comments);
    assert.equal(engine.options.media, h.media);
    assert.equal(engine.options.container.parentNode, h.page);
    assert.equal(engine.options.speed, 144);
    assert.equal(engine.visible, true);
    assert.deepEqual(h.calls.observed, [h.page]);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.timeouts.size, 0);
    h.context.onVideoOsdShow({ type: 'video-osd-show' });
    h.context.onVideoOsdHide({ type: 'video-osd-hide' });
    assert.equal(h.context.window.ede.danmaku, engine);
    assert.equal(h.calls.cleared, 0);
});

test('reloading danmaku still replaces the engine, wrapper and resize observer', async () => {
    const h = setup();
    const first = h.context.createDanmaku([{ text: 'first', time: 1 }]);
    h.tick();
    await first;
    const oldWrapper = h.document.querySelector('#danmakuWrapper');
    h.settings.switch = false;
    const comments = [{ text: 'second', time: 2 }];
    const second = h.context.createDanmaku(comments);
    h.tick();
    await second;
    assert.equal(h.calls.destroyed, 1);
    assert.equal(h.calls.disconnected, 1);
    assert.equal(oldWrapper.isConnected, false);
    assert.equal(h.document.querySelectorAll('#danmakuWrapper').length, 1);
    assert.equal(h.context.window.ede.danmaku.options.comments, comments);
    assert.equal(h.context.window.ede.danmaku.visible, false);
});

test('the clock updates, hides, resumes and respects the disabled setting', () => {
    const h = setup();
    h.context.onVideoOsdShow({ type: 'video-osd-show' });
    const clock = h.document.querySelector('#headerClock');
    const firstText = clock.textContent;
    assert.ok(firstText);
    h.advanceTime(1000);
    h.tick();
    assert.notEqual(clock.textContent, firstText);
    h.context.onVideoOsdHide({ type: 'video-osd-hide' });
    assert.equal(clock.isConnected, false);
    assert.equal(h.intervals.size, 0);
    h.context.onVideoOsdShow({ type: 'video-osd-show' });
    assert.equal(h.document.querySelectorAll('#headerClock').length, 1);
    assert.equal(h.intervals.size, 1);
    h.settings.clock = false;
    h.context.removeHeaderClock(); // Same operation as the setting checkbox callback.
    h.context.onVideoOsdShow({ type: 'video-osd-show' });
    assert.equal(h.document.querySelector('#headerClock'), null);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.menu().children.length, 2);
});

test('playback stop still removes the clock and invokes progress and filter cleanup', () => {
    const h = setup();
    h.context.onVideoOsdShow({ type: 'video-osd-show' });
    h.context.onPlaybackStop({ type: 'playbackstop' }, { NowPlayingItem: { Id: 'current-item' } });
    assert.equal(h.document.querySelector('#headerClock'), null);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.calls.stopPct, 1);
    assert.equal(h.calls.filterCancelled, 1);
});

test('only leaving the player clears danmaku, stops progress and resets the timeline offset', async () => {
    const h = setup();
    const pending = h.context.createDanmaku([{ text: 'hello', time: 1 }]);
    h.tick();
    await pending;
    h.context.onVideoOsdShow({ type: 'video-osd-show' });
    h.context.videoTimeUpdateInterval(h.media, true);
    h.tick();
    assert.ok(h.media.currentTime > 0);
    h.context.beforeDestroy({ detail: { type: 'item' } });
    assert.equal(h.calls.cleared, 0);
    assert.equal(h.settings.offset, 5);
    assert.ok(h.media.timeupdateIntervalId);
    assert.ok(h.document.querySelector('#headerClock'));
    h.leave();
    const stoppedAt = h.media.currentTime;
    h.tick();
    assert.equal(h.calls.cleared, 1);
    assert.equal(h.calls.destroyed, 0); // Existing behavior keeps the instance until the next load.
    assert.equal(h.media.currentTime, stoppedAt);
    assert.equal(h.media.timeupdateIntervalId, null);
    assert.equal(h.settings.offset, 0);
    assert.equal(h.context.window.ede.destroyIntervalIds.length, 0);
    assert.equal(h.document.querySelector('#headerClock'), null);
    assert.equal(h.menu(), null);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.timeouts.size, 0);
});

test('pending button initialization is cancelled on exit with the clock disabled', () => {
    const h = setup({ buttonsReady: false, clockEnabled: false });
    h.context.onVideoOsdShow({ type: 'video-osd-show' });
    assert.equal(h.document.querySelector('#headerClock'), null);
    assert.equal(h.intervals.size, 1);
    h.leave();
    h.controls.append(h.buttons);
    h.tick();
    assert.equal(h.menu(), null);
    assert.equal(h.intervals.size, 0);
});

test('re-entry mounts buttons in the event view even without the backdrop class', () => {
    const h = setup();
    h.context.onVideoOsdShow({ type: 'video-osd-show', target: h.page });
    h.leave();
    // Emby 4.10 uses this stable view class and changes graphicContentContainer with the backdrop.
    h.page.className = 'view view-videoosd-videoosd';
    h.context.onVideoOsdShow({ type: 'video-osd-show', target: h.page });
    h.tick();
    assert.equal(h.buttons.querySelector('#danmakuCtr')?.children.length, 2);
});

test('a cached player under a hidden ancestor cannot capture the current view buttons', () => {
    const h = setup();
    const cache = new Element('div', 'hide');
    const oldPage = new Element('div', 'graphicContentContainer');
    const oldControls = new Element('div', 'videoOsdBottom-maincontrols');
    const oldButtons = new Element('div', 'videoOsdBottom-buttons');
    oldControls.append(oldButtons);
    oldPage.append(oldControls);
    cache.append(oldPage);
    h.document.insertBefore(cache, h.page);
    h.context.onVideoOsdShow({ type: 'video-osd-show', target: h.page });
    h.tick();
    assert.equal(h.buttons.querySelector('#danmakuCtr')?.children.length, 2);
    assert.equal(oldButtons.querySelector('#danmakuCtr'), null);
});

test('buttons recover if Emby rebuilds the control area after the show event', () => {
    const h = setup();
    h.context.onVideoOsdShow({ type: 'video-osd-show', target: h.page });
    assert.equal(h.menu().children.length, 2);
    h.buttons.remove();
    const replacement = new Element('div', 'videoOsdBottom-buttons');
    h.controls.append(replacement);
    h.tick();
    assert.equal(replacement.querySelector('#danmakuCtr')?.children.length, 2);
});

test('late cleanup from a cached player leaves the active player and clock intact', () => {
    const h = setup();
    h.context.onVideoOsdShow({ type: 'video-osd-show', target: h.page });
    const oldPage = new Element('div', 'view-videoosd-videoosd');
    h.document.append(oldPage);
    h.context.beforeDestroy({ detail: { type: 'video-osd' }, target: oldPage });
    assert.equal(h.menu()?.parentNode, h.buttons);
    assert.ok(h.document.querySelector('#headerClock'));
    assert.equal(h.settings.offset, 5);
    h.context.beforeDestroy({ detail: { type: 'video-osd' }, target: h.page });
    h.controls.append(new Element());
    h.tick();
    assert.equal(h.menu(), null);
    assert.ok(Array.from(h.observers).every(observer => observer.targets.size === 0));
});

test('danmaku animation subtree changes do not trigger UI repair', () => {
    const h = setup();
    h.context.onVideoOsdShow({ type: 'video-osd-show', target: h.page });
    const stage = new Element();
    stage.id = 'danmakuWrapper';
    h.page.append(stage);
    h.tick();
    for (let index = 0; index < 100; index++) stage.append(new Element());
    assert.ok(Array.from(h.observers).every(observer => observer.records.length === 0));
});

test('re-entry renders danmaku in the current view instead of a cached page-hidden player', async () => {
    const h = setup();
    const cachedPage = new Element('div', 'view-videoosd-videoosd graphicContentContainer page-hidden');
    h.document.insertBefore(cachedPage, h.page);
    h.context.onVideoOsdShow({ type: 'video-osd-show', target: h.page });
    const pending = h.context.createDanmaku([{ text: 'current player', time: 1 }]);
    h.tick();
    await pending;
    assert.equal(h.context.window.ede.danmaku.options.container.parentNode, h.page);
    assert.equal(cachedPage.querySelector('#danmakuWrapper'), null);
    assert.deepEqual(h.calls.observed, [h.page]);
});

test('danmaku follows the event view when Emby removes the backdrop class', async () => {
    const h = setup();
    h.page.className = 'view-videoosd-videoosd';
    h.context.onVideoOsdShow({ type: 'video-osd-show', target: h.page });
    const pending = h.context.createDanmaku([{ text: 'no backdrop class', time: 1 }]);
    h.tick();
    await pending;
    assert.equal(h.context.window.ede.danmaku.options.container.parentNode, h.page);
});

test('danmaku waits for the current view to become visible and ignores cached players', async () => {
    const h = setup();
    const cachedPage = new Element('div', 'graphicContentContainer page-hidden');
    h.document.insertBefore(cachedPage, h.page);
    h.page.className = 'view-videoosd-videoosd page-hidden';
    h.context.onVideoOsdShow({ type: 'video-osd-show', target: h.page });
    const pending = h.context.createDanmaku([{ text: 'wait for current player', time: 1 }]);
    h.tick();
    assert.equal(h.calls.created.length, 0);
    h.page.className = 'view-videoosd-videoosd';
    h.tick();
    await pending;
    assert.equal(h.context.window.ede.danmaku.options.container.parentNode, h.page);
    h.leave();
    assert.equal(h.intervals.size, 0);
    assert.equal(h.timeouts.size, 0);
});

async function sourceRenderScene() {
    const h = setup();
    const names = ['getExtCommentVersion', 'addExtComments', 'removeExtComment', 'commentIdentity', 'mergeCommentSources'];
    vm.runInContext('let commentCacheGeneration = 0;\n' + names.map(name =>
        source.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`, 'm'))[0]).join('\n'), h.context);
    const main = [{ cid: 'main' }], a = [{ cid: 'A' }], b = [{ cid: 'B' }];
    const ede = h.context.window.ede;
    Object.assign(ede, {
        itemId: 'item', episode_info: { episodeId: 111 }, danmuCache: { 111: main },
        extCommentCache: { item: { 'https://A': a, 'https://B': b } },
    });
    h.context.console.warn = () => {};
    h.context.getMatchContext = () => ({});
    h.context.isMatchContextCurrent = () => true;
    h.context.buildExtUrlsDiv = () => {};
    h.calls.toasts = [];
    h.context.embyToast = ({ text }) => h.calls.toasts.push(text);
    const initial = h.context.createDanmaku([...main, ...a, ...b]);
    h.tick();
    await initial;
    return { ...h, ede };
}

test('real rendering keeps main and B when A is removed and its immediate re-add fails', async () => {
    for (const failureFirst of [true, false]) {
        const h = await sourceRenderScene();
        const oldEngine = h.ede.danmaku;
        const oldWrapper = h.document.querySelector('#danmakuWrapper');
        let fail;
        h.context.fetchExtcommentActual = () => new Promise((resolve, reject) => { fail = reject; });
        const removing = h.context.removeExtComment('https://A');
        const adding = h.context.addExtComments('https://A');
        assert.equal(h.ede.danmaku, oldEngine, 'keep the existing engine while the removal waits for its container');
        assert.equal(oldWrapper.isConnected, true);
        assert.equal(h.calls.destroyed, 0);
        if (failureFirst) {
            fail(new Error('HTTP 429'));
            await adding;
        }
        h.tick();
        await removing;
        assert.deepEqual(Array.from(h.ede.danmaku.options.comments, c => c.cid), ['main', 'B']);
        if (!failureFirst) {
            fail(new Error('HTTP 429'));
            await adding;
        }
        assert.deepEqual(Array.from(h.ede.danmaku.options.comments, c => c.cid), ['main', 'B']);
        assert.equal(h.ede.extCommentCache.item['https://A'], undefined);
        assert.equal(h.calls.destroyed, 1);
        assert.equal(h.calls.disconnected, 1);
        assert.equal(h.document.querySelectorAll('#danmakuWrapper').length, 1);
        assert.match(h.calls.toasts.at(-1), /保留当前弹幕/);
    }
});

test('a successful re-add replaces the pending removal only when its real render is ready', async () => {
    const h = await sourceRenderScene();
    const oldEngine = h.ede.danmaku;
    const removing = h.context.removeExtComment('https://A');
    const adding = h.context.addExtComments('https://A', [{ cid: 'new-A' }]);
    assert.equal(h.ede.danmaku, oldEngine);
    h.tick();
    await Promise.all([removing, adding]);
    assert.deepEqual(Array.from(h.ede.danmaku.options.comments, c => c.cid), ['main', 'B', 'new-A']);
    assert.equal(h.calls.created.length, 2);
    assert.equal(h.calls.destroyed, 1);
    assert.equal(h.document.querySelectorAll('#danmakuWrapper').length, 1);
});

test('a cancelled real render preserves the previous engine, wrapper, observer and displayed metadata', async () => {
    const h = await sourceRenderScene();
    const previous = { engine: h.ede.danmaku, wrapper: h.document.querySelector('#danmakuWrapper'),
        observer: h.ede.ob, original: h.ede.commentsOriginal, parsed: h.ede.commentsParsed };
    let current = true;
    const pending = h.context.createDanmaku([{ cid: 'obsolete' }], () => current);
    current = false;
    h.tick();
    await pending;
    assert.equal(h.ede.danmaku, previous.engine);
    assert.equal(h.document.querySelector('#danmakuWrapper'), previous.wrapper);
    assert.equal(h.ede.ob, previous.observer);
    assert.equal(h.ede.commentsOriginal, previous.original);
    assert.equal(h.ede.commentsParsed, previous.parsed);
    assert.equal(h.calls.destroyed, 0);
    assert.equal(h.calls.disconnected, 0);
});

test('failed render preparation retains the current display and removes only the unfinished candidate', async () => {
    for (const failure of ['timeout', 'parser', 'engine', 'observer']) {
        const h = await sourceRenderScene();
        const previous = { engine: h.ede.danmaku, wrapper: h.document.querySelector('#danmakuWrapper'),
            observer: h.ede.ob, original: h.ede.commentsOriginal, parsed: h.ede.commentsParsed };
        if (failure === 'parser') h.context.danmakuParser = () => { throw new Error('parser failure'); };
        if (failure === 'engine') h.context.Danmaku = class { constructor() { throw new Error('engine failure'); } };
        if (failure === 'observer') h.context.ResizeObserver = class {
            observe() { throw new Error('observer failure'); }
            disconnect() {}
        };
        let oldDestroyed = false;
        previous.engine.destroy = () => { oldDestroyed = true; };
        const pending = h.context.createDanmaku([{ cid: 'replacement' }]);
        const rejected = assert.rejects(pending, /failure|not found/);
        if (failure === 'timeout') {
            for (const callback of Array.from(h.timeouts.values())) callback();
        } else h.tick();
        await rejected;
        assert.equal(h.ede.danmaku, previous.engine, failure);
        assert.equal(h.document.querySelector('#danmakuWrapper'), previous.wrapper, failure);
        assert.equal(h.ede.ob, previous.observer, failure);
        assert.equal(h.ede.commentsOriginal, previous.original, failure);
        assert.equal(h.ede.commentsParsed, previous.parsed, failure);
        assert.equal(oldDestroyed, false, failure);
        assert.equal(h.calls.disconnected, 0, failure);
        assert.deepEqual(h.page.children, [previous.wrapper, h.controls], failure);
        if (failure === 'observer') assert.equal(h.calls.destroyed, 1, 'destroy only the uncommitted engine');
    }
});
