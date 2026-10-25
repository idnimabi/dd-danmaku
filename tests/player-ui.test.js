import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../ede.js', import.meta.url), 'utf8');
const functionNames = [
    'initUI', 'stopUIInit', 'toVersionArray', 'compareVersion', 'getById', 'getByClass',
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
        this.tagName = tagName;
        this.className = className;
        this.id = '';
        this.children = [];
        this.parentNode = null;
        this.style = {};
    }

    get isConnected() {
        return this.tagName === '#document' || !!this.parentNode?.isConnected;
    }

    append(child) {
        child.remove();
        this.children.push(child);
        child.parentNode = this;
    }

    appendChild(child) {
        this.append(child);
    }

    prepend(child) {
        child.remove();
        this.children.unshift(child);
        child.parentNode = this;
    }

    insertBefore(child, reference) {
        assert.equal(reference.parentNode, this);
        child.remove();
        this.children.splice(this.children.indexOf(reference), 0, child);
        child.parentNode = this;
    }

    remove() {
        if (this.parentNode) {
            this.parentNode.children = this.parentNode.children.filter(child => child !== this);
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
        context, document, header, page, controls, buttons, media, intervals, timeouts, settings, calls,
        advanceTime(ms) { time += ms; },
        tick() {
            for (const [id, callback] of Array.from(intervals)) {
                if (intervals.has(id)) callback();
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
    h.context.onPlaybackStop({ type: 'playbackstop' }, {});
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
