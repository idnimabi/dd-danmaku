import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../ede.js', import.meta.url), 'utf8');
const names = [
    'readLocalJson', 'commentStorageKeys', 'removeCommentCache', 'isFreshCommentCache',
    'cleanupCommentCache', 'writeCommentCache', 'fetchCachedComments', 'resetCommentRequests',
    'clearCurrentMatchHistory', 'startCommentCacheCleanup', 'fetchComment', 'fetchExtcommentActual',
    'getEpisodeInfo', 'loadOnlineDanmaku', 'doDanmakuSwitchEpisode', 'searchEpisodes',
    'localStorageKeys', 'readMatchValue', 'writeMatchValue', 'removeMatchValue', 'newMatchRevision',
    'getMatchContext', 'isMatchContextCurrent', 'episodeMatchKey', 'readEpisodeMatch', 'writeEpisodeMatch',
    'onMatchStorageChange', 'clearAllMatchHistory', 'forceRefreshComments', 'commentIdentity',
    'mergeCommentSources', 'getExtCommentVersion', 'addExtComments', 'removeExtComment',
    'runDanmakuLoad', 'isCurrentDanmakuLoad', 'canReuseEpisodeInfo',
];
const functions = names.map(name => {
    const match = source.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`, 'm'));
    assert.ok(match, `Missing function: ${name}`);
    return match[0];
}).join('\n');
const keysSource = source.match(/^    const lsLocalKeys = \{[^]*?^    };/m)[0];
const DAY = 24 * 60 * 60 * 1000;
const PREFIX = '_dandanplay_comments_v1_';
const plain = value => JSON.parse(JSON.stringify(value));
const sample = [{ cid: '1', p: '1,1,16777215,user', m: '弹幕' }];
async function waitUntil(check) {
    for (let i = 0; i < 100; i++) {
        if (check()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Expected asynchronous operation to start');
}

function install(context, names) {
    vm.runInContext(names.map(name => source.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`, 'm'))[0]).join('\n'), context);
}

function storageFixture() {
    const storage = {};
    const control = { maxEntries: Infinity, blocked: false, beforeSet: null };
    Object.defineProperties(storage, {
        getItem: { value(key) {
            if (control.blocked) throw new Error('Storage disabled');
            return Object.hasOwn(storage, key) ? storage[key] : null;
        } },
        setItem: { value(key, value) {
            if (control.beforeSet) control.beforeSet(key, value);
            if (control.blocked) throw new Error('Storage disabled');
            if (!Object.hasOwn(storage, key) && Object.keys(storage).length >= control.maxEntries) {
                const error = new Error('Quota exceeded');
                error.name = 'QuotaExceededError';
                throw error;
            }
            storage[key] = String(value);
        } },
        removeItem: { value(key) {
            if (control.blocked) throw new Error('Storage disabled');
            delete storage[key];
        } },
    });
    return { storage, control };
}

function setup(shared = storageFixture()) {
    let now = Date.UTC(2026, 9, 25);
    let proxy = 'https://proxy/official';
    let response = async () => ({ comments: plain(sample) });
    const calls = { requests: [], rendered: [], loads: [], searches: 0, prompts: 0, toasts: [] };
    const listeners = new Map();
    const timers = new Map();
    let timerId = 0;
    const item = {
        _season_key: '_anime_season_rel_1', _id_key: '_anime_id_rel_1',
        _episode_key: '_episode_id_rel_1_2', episode: 2, seriesOrMovieId: 'show', animeId: -1, itemId: 'item-2',
    };
    const opts = { ...item, episode: 1, animes: [{ animeId: 22, animeTitle: '新选择', imageUrl: 'poster' }] };
    const elements = {
        anime: { selectedIndex: 0 },
        episode: { value: '222', selectedIndex: 2, options: [{}, {}, { text: '第 3 集' }] },
    };
    const ede = {
        commentCacheScope: item._season_key, itemId: 'item-2', chConvert: 1,
        danmuCache: {}, extCommentCache: {}, episode_info: null, loading: true,
        searchDanmakuOpts: opts,
    };
    const context = vm.createContext({
        localStorage: shared.storage,
        window: { ede, localStorage: shared.storage,
            addEventListener: (type, listener) => listeners.set(type, listener),
            removeEventListener: type => listeners.delete(type),
        },
        console: { log() {}, warn() {}, error() {} },
        Date: class extends Date { static now() { return now; } },
        setInterval(callback, ms) { timers.set(++timerId, { callback, ms }); return timerId; },
        clearInterval(id) { timers.delete(id); },
        fetchJson: async url => { calls.requests.push(url); return response(url); },
        dandanplayApi: {
            getApiPrefix: () => proxy,
            getComment: (id, convert, prefix) => `${prefix}/comment/${id}?chConvert=${convert}`,
            getExtcomment: (url, prefix) => `${prefix}/extcomment?url=${url}`,
        },
        getMapByEmbyItemInfo: async () => item,
        appendvideoOsdDanmakuInfo() { calls.prompts++; },
        createDanmaku: async comments => calls.rendered.push(plain(comments)),
        getById: id => elements[id],
        document: { querySelector: () => ({}) },
        mediaQueryStr: 'video',
        eleIds: { danmakuAnimeSelect: 'anime', danmakuEpisodeNumSelect: 'episode' },
        LOAD_TYPE: { INIT: 'init', RELOAD: 'reload', REFRESH: 'refresh', SEARCH: 'search' },
        loadDanmaku: type => calls.loads.push(type),
        closeEmbyDialog() {},
        embyToast: value => calls.toasts.push(value.text),
        buildExtUrlsDiv() {},
        lsSeasonSearchEpisodes: async () => null,
        parseAnimeName: () => ({ season: null }),
        fetchSearchEpisodes: async () => { calls.searches++; return null; },
        autoFailback: async () => null,
    });
    vm.runInContext(`
        ${keysSource}
        const commentCacheTtl = ${DAY};
        const emptyCommentCacheTtl = 5 * 60 * 1000;
        const commentRequests = new Map();
        const matchMemory = new Map();
        let commentCacheGeneration = 0;
        ${functions}
    `, context);
    return {
        context, ede, item, opts, elements, calls, timers, listeners, ...shared,
        matched() { return context.readEpisodeMatch(context.getMatchContext(item._season_key), item._episode_key); },
        now: () => now,
        advance: ms => { now += ms; },
        proxy: value => { proxy = value; },
        respond: fn => { response = fn; },
        cacheKeys: () => Object.keys(shared.storage).filter(key => key.startsWith(PREFIX)),
        seed(key, value) { shared.storage.setItem(key, JSON.stringify(value)); },
        cache(key, overrides = {}) {
            shared.storage.setItem(PREFIX + key, JSON.stringify({
                createdAt: now, scope: item._season_key, kind: 'comment', identity: '111',
                comments: plain(sample), ...overrides,
            }));
        },
    };
}

function bindEpisode(h, info) {
    h.ede.episode_info = info;
    h.ede.episodeMatchContext = h.context.getMatchContext(h.item._season_key);
    h.ede.episodeInfoOwner = {
        itemId: h.item.itemId, episodeKey: h.item._episode_key, episodeId: info.episodeId,
        context: h.ede.episodeMatchContext,
    };
}

function useRealLoader(h, useXml = false) {
    install(h.context, ['loadDanmaku', 'doDanmakuChConverChange']);
    h.ede.loading = false;
    h.context.lsKeys = {
        chConvert: { id: 'convert' }, useFetchPluginXml: { id: 'xml', name: '服务端 XML' },
        osdHeaderClockEnable: { id: 'clock' }, timelineOffset: { id: 'offset', defaultValue: 0 },
    };
    h.context.lsGetItem = id => id === 'xml' && useXml;
    h.context.lsSetItem = () => {};
    return value => h.context.doDanmakuChConverChange({ id: value, name: `convert-${value}` });
}

function showItem(h, id) {
    install(h.context, ['onViewShow']);
    h.context.lsKeys = { ...h.context.lsKeys, quickDebugOn: { id: 'debug' }, consoleLogEnable: { id: 'log' } };
    h.context.lsGetItem = () => false;
    h.context.customeUrl = { init() {} };
    for (const name of ['addEasterEggListener', 'initUI', 'initH5VideoAdapter', 'initListener', 'initCss']) h.context[name] = () => {};
    h.context.onViewShow({ type: 'viewshow', detail: { type: 'video-osd', params: { id } } });
}

test('persists raw comments across page reloads, with a fixed 24-hour expiry', async () => {
    const shared = storageFixture();
    const first = setup(shared);
    const result = await first.context.fetchComment(111);
    result[0].m = '被播放器修改';
    const key = first.cacheKeys()[0];
    const createdAt = JSON.parse(shared.storage[key]).createdAt;
    const second = setup(shared);
    second.advance(DAY - 1);
    assert.deepEqual(plain(await second.context.fetchComment(111)), sample);
    assert.equal(second.calls.requests.length, 0);
    assert.equal(JSON.parse(shared.storage[key]).createdAt, createdAt);
    second.advance(1);
    await second.context.fetchComment(111);
    assert.equal(second.calls.requests.length, 1);
    assert.equal(JSON.parse(shared.storage[key]).createdAt, createdAt + DAY);
});

test('isolates simplification, endpoint and season variants', async () => {
    const h = setup();
    await h.context.fetchComment(111);
    h.ede.chConvert = 2;
    await h.context.fetchComment(111);
    h.proxy('https://another/official');
    await h.context.fetchComment(111);
    h.ede.commentCacheScope = '_anime_season_rel_10';
    await h.context.fetchComment(111);
    assert.equal(h.calls.requests.length, 4);
    assert.equal(h.cacheKeys().length, 4);
});

test('coalesces concurrent requests and gives each consumer its own comments', async () => {
    const h = setup();
    let finish;
    h.respond(() => new Promise(resolve => { finish = resolve; }));
    const first = h.context.fetchComment(111);
    const second = h.context.fetchComment(111);
    assert.equal(h.calls.requests.length, 1);
    finish({ comments: plain(sample) });
    const [a, b] = await Promise.all([first, second]);
    a[0].m = 'changed';
    assert.equal(b[0].m, '弹幕');
    assert.equal(h.cacheKeys().length, 1);
});

test('does not cache errors or malformed responses and releases failed pending requests', async () => {
    const h = setup();
    for (const reply of [null, {}, { success: false, comments: [] }, { comments: 'invalid' }]) {
        h.respond(async () => reply);
        assert.equal(await h.context.fetchComment(111), null);
        assert.equal(h.cacheKeys().length, 0);
    }
    h.respond(async () => { throw new Error('HTTP 429'); });
    assert.equal(await h.context.fetchComment(111), null);
    h.respond(async () => ({ comments: [] }));
    assert.deepEqual(plain(await h.context.fetchComment(111)), []);
    assert.equal(h.calls.requests.length, 6);
    await h.context.fetchComment(111);
    assert.equal(h.calls.requests.length, 6);
});

test('startup and periodic cleanup delete only expired/corrupt comment entries', () => {
    const h = setup();
    h.cache('expired', { createdAt: h.now() - DAY });
    h.cache('future', { createdAt: h.now() + 1 });
    h.cache('no-time', { createdAt: undefined });
    h.cache('invalid-comments', { comments: {} });
    h.storage.setItem(PREFIX + 'broken', '{');
    h.cache('valid');
    h.seed('danmakuBangumiToken', 'keep');
    h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
    h.seed('emby.preferences', { keep: true });
    h.context.startCommentCacheCleanup();
    assert.deepEqual(h.cacheKeys(), [PREFIX + 'valid']);
    h.context.startCommentCacheCleanup();
    assert.equal(h.timers.size, 1);
    h.advance(DAY);
    const timer = [...h.timers.values()][0];
    assert.equal(timer.ms, 60000);
    timer.callback();
    assert.equal(h.cacheKeys().length, 0);
    assert.equal(Object.keys(h.storage).length, 3);
});

test('quota pressure evicts the oldest comment cache without touching preferences', async () => {
    const h = setup();
    h.seed('danmakuFilterKeywords', 'keep');
    h.cache('old', { createdAt: h.now() - 100 });
    h.cache('recent');
    h.control.maxEntries = 3;
    assert.deepEqual(plain(await h.context.fetchComment(111)), sample);
    assert.equal(h.storage.getItem(PREFIX + 'old'), null);
    assert.ok(h.storage.getItem(PREFIX + 'recent'));
    assert.equal(h.storage.getItem('danmakuFilterKeywords'), '"keep"');
    assert.equal(h.cacheKeys().length, 2);
});

test('blocked or full storage does not turn a successful API response into a playback failure', async () => {
    const h = setup();
    h.control.blocked = true;
    assert.deepEqual(plain(await h.context.fetchComment(111)), sample);
    h.control.blocked = false;
    h.control.maxEntries = 0;
    assert.deepEqual(plain(await h.context.fetchComment(111)), sample);
    assert.equal(h.cacheKeys().length, 0);
});

test('bounds persistent comment storage and skips a single oversized response', async () => {
    const h = setup();
    h.seed('danmakuFilterKeywords', 'keep');
    const large = [{ ...sample[0], m: 'x'.repeat(1200000) }];
    h.respond(async () => ({ comments: large }));
    await h.context.fetchComment(111);
    h.advance(1);
    await h.context.fetchComment(112);
    assert.equal(h.cacheKeys().length, 1);
    assert.equal(JSON.parse(h.storage[h.cacheKeys()[0]]).identity, '112');
    const oversized = [{ ...sample[0], m: 'x'.repeat(2200000) }];
    h.respond(async () => ({ comments: oversized }));
    assert.equal((await h.context.fetchComment(113))[0].m.length, 2200000);
    assert.equal(h.cacheKeys().length, 1);
    assert.equal(h.storage.getItem('danmakuFilterKeywords'), '"keep"');
});

test('additional comments cache the full raw response before source tagging and deduplication', async () => {
    const h = setup();
    const extra = { cid: '2', p: '2,1,16777215,user', m: '附加' };
    h.respond(async () => ({ comments: [...plain(sample), { ...extra }] }));
    const result = await h.context.fetchExtcommentActual('https://video/1', sample);
    assert.equal(result.length, 1);
    assert.equal(result[0].fromUrl, 'https://video/1');
    const cached = JSON.parse(h.storage[h.cacheKeys()[0]]).comments;
    assert.equal(cached.length, 2);
    assert.equal(cached[0].fromUrl, undefined);
    const unfiltered = await h.context.fetchExtcommentActual('https://video/1', []);
    assert.equal(unfiltered.length, 2);
    assert.equal(h.calls.requests.length, 1);
});

test('additional comments retry an empty result once, then cache the valid empty response', async () => {
    const h = setup();
    h.respond(async () => ({ comments: [] }));
    await h.context.fetchExtcommentActual('https://video/1');
    await h.context.fetchExtcommentActual('https://video/1');
    assert.equal(h.calls.requests.length, 2);
});

test('manual selection replaces only the current season history and clears its in-memory state', () => {
    const h = setup();
    h.seed('_anime_id_rel_1', 11);
    h.seed('_anime_season_rel_1', [{ name: '旧选择', episodeOffset: 0 }]);
    h.seed('_episode_id_rel_1_1', { episodeId: 110 });
    h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
    h.seed('_api_official__episode_id_rel_1_3', { episodeId: 112 });
    h.seed('_bangumi_episode_id_rel_111', { subjectId: 7 });
    const keep = {
        '_anime_season_rel_10': [{ name: '其他季' }],
        '_api_official__episode_id_rel_10_2': { episodeId: 211 },
        '_episode_id_rel_10_2': { episodeId: 211 },
        '_bangumi_episode_id_rel_211': { subjectId: 8 },
        danmakuFilterKeywords: 'keep', danmakuBangumiToken: 'keep', '_bangumi_me': { username: 'keep' },
    };
    Object.entries(keep).forEach(([key, value]) => h.seed(key, value));
    h.cache('old-main');
    h.cache('old-extra', { kind: 'extcomment', identity: 'https://video' });
    h.cache('other-season', { scope: '_anime_season_rel_10' });
    h.ede.episode_info = { episodeId: 111 };
    h.ede.previous_episode_info = { episodeId: 110 };
    h.ede.danmuCache = { 111: plain(sample) };
    h.context.doDanmakuSwitchEpisode();
    assert.equal(h.storage.getItem('_anime_id_rel_1'), null);
    assert.equal(h.storage.getItem('_episode_id_rel_1_1'), null);
    assert.equal(h.storage.getItem('_api_official__episode_id_rel_1_3'), null);
    assert.equal(h.storage.getItem('_bangumi_episode_id_rel_111'), null);
    assert.equal(h.matched().episodeId, '222');
    assert.deepEqual(plain(h.context.getMatchContext(h.item._season_key).state.seasonInfo), [{ name: '新选择', episodeOffset: 1 }]);
    for (const [key, value] of Object.entries(keep)) assert.deepEqual(JSON.parse(h.storage[key]), value);
    assert.deepEqual(h.cacheKeys(), [PREFIX + 'other-season']);
    assert.equal(h.ede.previous_episode_info, null);
    assert.deepEqual(plain(h.ede.danmuCache), {});
    assert.deepEqual(h.calls.loads, ['reload']);
});

test('movie history uses the same scoped cleanup without matching a similarly prefixed movie', () => {
    const h = setup();
    h.seed('_api_official__episode_id_rel_1_movie', { episodeId: 111 });
    h.seed('_api_official__episode_id_rel_10_movie', { episodeId: 222 });
    h.context.clearCurrentMatchHistory(h.opts);
    assert.equal(h.storage.getItem('_api_official__episode_id_rel_1_movie'), null);
    assert.ok(h.storage.getItem('_api_official__episode_id_rel_10_movie'));
});

test('saved manual match is checked before adjacent-episode inference or remote searches', async () => {
    const h = setup();
    h.ede.previous_episode_info = { episodeId: 900, episodeIndex: 0, seriesOrMovieId: 'show' };
    h.seed('_api_official__episode_id_rel_1_2', { episodeId: 222 });
    assert.equal((await h.context.getEpisodeInfo()).episodeId, 222);
    assert.equal(h.calls.requests.length, 0);
    assert.equal(h.calls.searches, 0);
});

test('a saved match still shows the configuration prompt if its proxy is missing', async () => {
    const h = setup();
    h.seed('_api_official__episode_id_rel_1_2', { episodeId: 222 });
    h.proxy('');
    assert.equal(await h.context.getEpisodeInfo(), null);
    assert.equal(h.calls.prompts, 1);
    assert.equal(h.calls.requests.length, 0);
});

test('saved season title is searched before the automatic title', async () => {
    const h = setup();
    h.context.lsSeasonSearchEpisodes = async () => ({ newEpisode: 1, animaInfo: { animes: [{ animeId: 22 }] } });
    const result = await h.context.searchEpisodes(h.item);
    assert.equal(result.animaInfo.animes[0].animeId, 22);
    assert.equal(result.bgmEpisodeIndex, 0);
    assert.equal(h.calls.searches, 0);
});

test('season offsets preserve a zero-based Bangumi first episode', async () => {
    const h = setup();
    h.context.lsSeasonSearchEpisodes = async () => ({
        newEpisode: 1,
        animaInfo: { animes: [{ animeId: 22, episodes: [{ episodeId: 222 }] }] },
    });
    const info = await h.context.getEpisodeInfo();
    assert.equal(info.episodeIndex, 1);
    assert.equal(info.bgmEpisodeIndex, 0);
});

test('reload revalidates TTL and simplification instead of reusing stale playback arrays', async () => {
    const h = setup();
    h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
    await h.context.loadOnlineDanmaku('init');
    await h.context.loadOnlineDanmaku('reload');
    assert.equal(h.calls.requests.length, 1);
    h.ede.chConvert = 2;
    await h.context.loadOnlineDanmaku('reload');
    assert.equal(h.calls.requests.length, 2);
    h.advance(DAY);
    await h.context.loadOnlineDanmaku('reload');
    assert.equal(h.calls.requests.length, 3);
    assert.equal(h.calls.rendered.length, 4);
    assert.equal(h.ede.loading, false);
});

test('a manually replaced match cannot be overwritten by a late comment response', async () => {
    const h = setup();
    let finish;
    h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
    h.respond(() => new Promise(resolve => { finish = resolve; }));
    const loading = h.context.loadOnlineDanmaku('init');
    await waitUntil(() => finish);
    assert.equal(h.ede.loading, true);
    h.context.doDanmakuSwitchEpisode();
    finish({ comments: plain(sample) });
    await loading;
    assert.equal(h.cacheKeys().length, 0);
    assert.equal(h.calls.rendered.length, 0);
    assert.equal(h.matched().episodeId, '222');
});

test('a late automatic search cannot restore cleared matching history', async () => {
    const h = setup();
    let finish;
    h.context.searchEpisodes = () => new Promise(resolve => { finish = resolve; });
    const matching = h.context.getEpisodeInfo();
    await waitUntil(() => finish);
    h.context.doDanmakuSwitchEpisode();
    finish({ directMatch: true, episodeInfo: { episodeId: 999, animeId: 9 } });
    assert.equal(await matching, null);
    assert.equal(h.matched().episodeId, '222');
});

test('leaving the item during a request releases loading without rendering its comments', async () => {
    const h = setup();
    let finish;
    h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
    h.respond(() => new Promise(resolve => { finish = resolve; }));
    const loading = h.context.loadOnlineDanmaku('init');
    await waitUntil(() => finish);
    h.ede.itemId = 'other-item';
    finish({ comments: plain(sample) });
    await loading;
    assert.equal(h.calls.rendered.length, 0);
    assert.equal(h.ede.loading, false);
});

function useRealMetadata(h) {
    install(h.context, ['getMapByEmbyItemInfo']);
    h.context.getEmbyItemInfo = async () => ({
        Id: 'item-2', Type: 'Episode', SeasonId: '1', IndexNumber: 2, ParentIndexNumber: 1,
        SeriesName: 'show', SeriesId: 'show', Path: 'test.mkv',
        MediaSources: [{ Id: 'media', Size: 100, RunTimeTicks: 10000000 }],
    });
    h.context.ApiClient = {
        deviceId: () => 'test', accessToken: () => 'test', serverAddress: () => 'https://example.invalid', appName: () => 'Emby',
    };
}

test('first load resolves blank or stale view IDs using the real metadata path', async () => {
    for (const initialId of ['', 'previous-item']) {
        const h = setup();
        useRealMetadata(h);
        h.ede.itemId = initialId;
        h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
        await h.context.loadOnlineDanmaku('init');
        assert.equal(h.ede.itemId, 'item-2');
        assert.equal(h.calls.requests.length, 1);
        assert.equal(h.calls.rendered.length, 1);
        assert.equal(h.ede.loading, false);
    }
});

test('a new playback event cancels metadata resolution from the previous playback', async () => {
    const h = setup();
    install(h.context, ['onPlaybackStart']);
    let finish;
    h.context.getMapByEmbyItemInfo = () => new Promise(resolve => { finish = resolve; });
    const old = h.context.loadOnlineDanmaku('init');
    h.context.onPlaybackStart({ type: 'playbackstart' }, {});
    finish(h.item);
    await old;
    assert.equal(h.calls.requests.length, 0);
    assert.equal(h.calls.rendered.length, 0);
});

function usePlaybackEvents(h) {
    install(h.context, ['onPlaybackStart', 'onPlaybackStop']);
    const cleanup = { progress: 0, clock: 0, filters: 0 };
    h.context.onPlaybackStopPct = () => cleanup.progress++;
    h.context.removeHeaderClock = () => cleanup.clock++;
    h.context.danmakuAutoFilterCancel = () => cleanup.filters++;
    const getSetting = h.context.lsGetItem;
    h.context.lsGetItem = id => id === 'clock' || getSetting(id);
    return cleanup;
}

test('late empty stop events preserve the new playback request and its queued settings reload', async () => {
    const h = setup();
    const change = useRealLoader(h);
    const cleanup = usePlaybackEvents(h);
    h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
    const pending = [];
    h.respond(url => new Promise(resolve => pending.push({ url, resolve })));
    h.context.onPlaybackStart({ type: 'playbackstart' }, { NowPlayingItem: { Id: h.item.itemId } });
    const old = h.ede.onlineLoadRequest.promise;
    await waitUntil(() => pending.length === 1);
    h.context.onPlaybackStop({ type: 'playbackstop' }, { NowPlayingItem: { Id: h.item.itemId } });
    Object.assign(h.item, { itemId: 'next-item', _episode_key: '_episode_id_rel_1_3', episode: 3 });
    h.seed('_api_official__episode_id_rel_1_3', { episodeId: 222 });
    h.context.onPlaybackStart({ type: 'playbackstart' }, { NowPlayingItem: { Id: h.item.itemId } });
    const current = h.ede.onlineLoadRequest.promise;
    await waitUntil(() => pending.length === 2);
    change(2);
    const request = h.ede.onlineLoadRequest;
    const queued = h.ede.pendingDanmakuReload;
    const generation = h.ede.playbackGeneration;
    for (const state of [undefined, null, {}, { NowPlayingItem: null }]) {
        assert.doesNotThrow(() => h.context.onPlaybackStop({ type: 'playbackstop' }, state));
        assert.equal(h.ede.onlineLoadRequest, request);
        assert.equal(h.ede.pendingDanmakuReload, queued);
        assert.equal(h.ede.playbackGeneration, generation);
        assert.equal(h.ede.loading, true);
        assert.deepEqual(cleanup, { progress: 1, clock: 1, filters: 1 });
    }
    pending[0].resolve({ comments: [{ ...sample[0], m: 'previous episode' }] });
    await old;
    pending[1].resolve({ comments: [{ ...sample[0], m: 'old conversion' }] });
    await waitUntil(() => pending.length === 3);
    assert.equal(h.calls.rendered.length, 0);
    assert.match(pending[2].url, /\/222\?chConvert=2/);
    pending[2].resolve({ comments: [{ ...sample[0], m: 'current episode' }] });
    await current;
    assert.deepEqual(h.calls.rendered.map(comments => comments[0].m), ['current episode']);
    assert.equal(h.ede.loading, false);
});

test('a previous item stop is ignored before metadata resolves and during online or XML loading', async () => {
    for (const useXml of [false, true]) {
        const h = setup();
        useRealLoader(h, useXml);
        const cleanup = usePlaybackEvents(h);
        h.ede.itemId = 'previous-item';
        h.seed('_api_official__episode_id_rel_1_2', { episodeId: 222 });
        let metadata, comments;
        h.context.getMapByEmbyItemInfo = () => new Promise(resolve => { metadata = resolve; });
        h.respond(() => new Promise(resolve => { comments = result => resolve({ comments: result }); }));
        h.context.getCommentsByPluginApi = () => new Promise(resolve => { comments = resolve; });
        h.context.onPlaybackStart({ type: 'playbackstart' }, { NowPlayingItem: { Id: h.item.itemId } });
        const request = h.ede.onlineLoadRequest;
        const generation = h.ede.playbackGeneration;
        const lateStop = () => {
            h.context.onPlaybackStop({ type: 'playbackstop' }, { NowPlayingItem: { Id: 'previous-item' } });
            assert.equal(h.ede.onlineLoadRequest, request);
            assert.equal(h.ede.playbackGeneration, generation);
            assert.equal(h.ede.loading, true);
            assert.deepEqual(cleanup, { progress: 0, clock: 0, filters: 0 });
        };
        lateStop();
        metadata(h.item);
        await waitUntil(() => comments);
        lateStop();
        comments(sample);
        await request.promise;
        assert.equal(h.calls.rendered.length, 1);
        assert.equal(h.ede.loading, false);
    }
});

test('a current item stop before metadata resolves still cancels loading and performs cleanup', async () => {
    const h = setup();
    useRealLoader(h);
    const cleanup = usePlaybackEvents(h);
    h.ede.itemId = 'previous-item';
    let metadata;
    h.context.getMapByEmbyItemInfo = () => new Promise(resolve => { metadata = resolve; });
    h.context.onPlaybackStart({ type: 'playbackstart' }, { NowPlayingItem: { Id: h.item.itemId } });
    const loading = h.ede.onlineLoadRequest.promise;
    h.context.onPlaybackStop({ type: 'playbackstop' }, { NowPlayingItem: { Id: h.item.itemId } });
    metadata(h.item);
    await loading;
    assert.equal(h.calls.requests.length, 0);
    assert.equal(h.calls.rendered.length, 0);
    assert.equal(h.ede.loading, false);
    assert.equal(h.ede.onlineLoadRequest, null);
    assert.deepEqual(cleanup, { progress: 1, clock: 1, filters: 1 });
});

test('stopping after clearing a match skips Bangumi synchronization but runs both cleanups', () => {
    const h = setup();
    install(h.context, ['onPlaybackStopPct', 'onPlaybackStop']);
    let clock = 0, filters = 0, syncs = 0;
    const values = { percent: 95, token: 'test', enabled: true, clock: true };
    h.context.lsKeys = { bangumiPostPercent: { id: 'percent' }, bangumiToken: { id: 'token' },
        bangumiEnable: { id: 'enabled' }, osdHeaderClockEnable: { id: 'clock' } };
    h.context.lsGetItem = id => values[id];
    h.context.removeHeaderClock = () => clock++;
    h.context.danmakuAutoFilterCancel = () => filters++;
    h.context.putBangumiEpStatus = async () => syncs++;
    h.context.resetCommentRequests();
    const event = { type: 'playbackstop' };
    const state = { NowPlayingItem: { Id: h.item.itemId, RunTimeTicks: 100 }, PlayState: { PositionTicks: 99 } };
    assert.doesNotThrow(() => h.context.onPlaybackStop(event, state));
    assert.deepEqual([clock, filters, syncs], [1, 1, 0]);
    h.context.onPlaybackStopPct = () => { throw new Error('sync failure'); };
    assert.throws(() => h.context.onPlaybackStop(event, state), /sync failure/);
    assert.deepEqual([clock, filters], [2, 2]);
});

test('full or blocked storage cannot stop the complete automatic matching and playback flow', async () => {
    for (const blocked of [false, true]) {
        for (const directMatch of [false, true]) {
            const h = setup();
            useRealMetadata(h);
            h.control.blocked = blocked;
            h.control.maxEntries = 0;
            const episodeInfo = { episodeId: 111, animeId: 11, animeTitle: 'show', episodeTitle: 'ep2' };
            h.context.searchEpisodes = async () => directMatch ? { directMatch, episodeInfo }
                : { animaInfo: { animes: [{ ...episodeInfo, episodes: [episodeInfo] }] } };
            await h.context.loadOnlineDanmaku('init');
            assert.equal(h.calls.requests.length, 1);
            assert.equal(h.calls.rendered.length, 1);
            assert.equal(h.matched().episodeId, 111);
            assert.equal(h.ede.loading, false);
        }
    }
});

test('manual matching and season offsets survive storage failure for the current page', async () => {
    const h = setup();
    h.control.maxEntries = 0;
    h.context.doDanmakuSwitchEpisode();
    await h.context.loadOnlineDanmaku('reload');
    assert.equal(h.ede.episode_info.episodeId, '222');
    assert.equal(h.calls.searches, 0);
    assert.equal(h.calls.rendered.length, 1);
    assert.equal(h.context.getMatchContext(h.item._season_key).state.seasonInfo[0].episodeOffset, 1);
    assert.equal(Object.keys(h.storage).length, 0);
});

test('adding and removing sources preserves other sources and their overlapping comments', async () => {
    const h = setup();
    h.ede.episode_info = { episodeId: 111 };
    h.ede.danmuCache = { 111: plain(sample) };
    const sharedComment = { cid: 'shared', p: '2,1,16777215,u', m: 'shared' };
    const a = { cid: 'A', p: '3,1,16777215,u', m: 'A' };
    const b = { cid: 'B', p: '4,1,16777215,u', m: 'B' };
    h.respond(async url => ({ comments: [sharedComment, url.includes('source-A') ? a : b] }));
    await h.context.addExtComments('https://source-A');
    await h.context.addExtComments('https://source-B');
    assert.deepEqual(h.calls.rendered.at(-1).map(c => c.cid), ['1', 'shared', 'A', 'B']);
    assert.equal(h.ede.extCommentCache[h.ede.itemId]['https://source-B'].length, 2);
    await h.context.removeExtComment('https://source-A');
    assert.deepEqual(h.calls.rendered.at(-1).map(c => c.cid), ['1', 'shared', 'B']);
    await h.context.removeExtComment('https://source-B');
    assert.deepEqual(h.calls.rendered.at(-1).map(c => c.cid), ['1']);
});

test('concurrent source additions merge against the latest source set', async () => {
    const h = setup();
    h.ede.episode_info = { episodeId: 111 };
    h.ede.danmuCache = { 111: sample };
    const pending = [];
    h.respond(() => new Promise(resolve => pending.push(resolve)));
    const a = h.context.addExtComments('https://A');
    const b = h.context.addExtComments('https://B');
    pending[1]({ comments: [{ ...sample[0], cid: 'B' }] });
    await b;
    pending[0]({ comments: [{ ...sample[0], cid: 'A' }] });
    await a;
    assert.deepEqual(h.calls.rendered.at(-1).map(c => c.cid).sort(), ['1', 'A', 'B']);
});

test('removing a source invalidates pending additions and direct fetches without cancelling other sources', async () => {
    for (const alreadyAdded of [false, true]) {
        for (const directFetch of [false, true]) {
            const h = setup();
            h.ede.episode_info = { episodeId: 111 };
            h.ede.danmuCache = { 111: sample };
            if (alreadyAdded) await h.context.addExtComments('https://A', [{ ...sample[0], cid: 'A' }]);
            const pending = [];
            h.respond(() => new Promise(resolve => pending.push(resolve)));
            const a = directFetch ? h.context.fetchExtcommentActual('https://A') : h.context.addExtComments('https://A');
            const b = h.context.addExtComments('https://B');
            await h.context.removeExtComment('https://A');
            const renders = h.calls.rendered.length;
            const toasts = h.calls.toasts.length;
            pending[0]({ comments: [{ ...sample[0], cid: 'late-A' }] });
            const result = await a;
            if (directFetch) assert.equal(result, null);
            assert.equal(h.calls.rendered.length, renders);
            assert.equal(h.calls.toasts.length, toasts);
            assert.equal(h.ede.extCommentCache[h.item.itemId]?.['https://A'], undefined);
            pending[1]({ comments: [{ ...sample[0], cid: 'B' }] });
            await b;
            assert.deepEqual(h.calls.rendered.at(-1).map(c => c.cid), ['1', 'B']);
        }
    }
});

test('an explicit re-add wins over an older addition after the same source was removed', async () => {
    const h = setup();
    h.ede.episode_info = { episodeId: 111 };
    h.ede.danmuCache = { 111: sample };
    await h.context.addExtComments('https://A', [{ ...sample[0], cid: 'initial-A' }]);
    let finish;
    h.respond(() => new Promise(resolve => { finish = resolve; }));
    const old = h.context.addExtComments('https://A');
    await h.context.removeExtComment('https://A');
    await h.context.addExtComments('https://A', [{ ...sample[0], cid: 'new-A' }]);
    const renders = h.calls.rendered.length;
    finish({ comments: [{ ...sample[0], cid: 'late-A' }] });
    await old;
    assert.equal(h.calls.rendered.length, renders);
    assert.deepEqual(h.calls.rendered.at(-1).map(c => c.cid), ['1', 'new-A']);
    assert.equal(h.ede.extCommentCache[h.item.itemId]['https://A'][0].cid, 'new-A');
});

test('a network re-add after removal may share the pending fetch but only the latest intent renders', async () => {
    const h = setup();
    h.ede.episode_info = { episodeId: 111 };
    h.ede.danmuCache = { 111: sample };
    let finish;
    h.respond(() => new Promise(resolve => { finish = resolve; }));
    const old = h.context.addExtComments('https://A');
    await h.context.removeExtComment('https://A');
    const latest = h.context.addExtComments('https://A');
    const renders = h.calls.rendered.length;
    finish({ comments: [{ ...sample[0], cid: 'A' }] });
    await Promise.all([old, latest]);
    assert.equal(h.calls.requests.length, 1);
    assert.equal(h.calls.rendered.length, renders + 1);
    assert.equal(h.calls.toasts.length, 1);
    assert.deepEqual(h.calls.rendered.at(-1).map(c => c.cid), ['1', 'A']);
});

test('bulk refresh cannot overwrite a removed and re-added source, even after its fetch already finished', async () => {
    for (const updateAfterAFinishes of [false, true]) {
        const h = setup();
        bindEpisode(h, { episodeId: 111 });
        h.ede.danmuCache = { 111: sample };
        await h.context.addExtComments('https://A', [{ ...sample[0], cid: 'initial-A' }]);
        await h.context.addExtComments('https://B', [{ ...sample[0], cid: 'initial-B' }]);
        const pending = [];
        h.respond(url => url.includes('/comment/') ? Promise.resolve({ comments: [{ ...sample[0], cid: 'new-main' }] })
            : new Promise(resolve => pending.push({ url, resolve })));
        const refresh = h.context.forceRefreshComments();
        await waitUntil(() => pending.length === 1);
        if (updateAfterAFinishes) {
            pending[0].resolve({ comments: [{ ...sample[0], cid: 'late-A' }] });
            await waitUntil(() => pending.length === 2);
        }
        await h.context.removeExtComment('https://A');
        await h.context.addExtComments('https://A', [{ ...sample[0], cid: 'new-A' }]);
        if (!updateAfterAFinishes) {
            pending[0].resolve({ comments: [{ ...sample[0], cid: 'late-A' }] });
            await waitUntil(() => pending.length === 2);
        }
        pending[1].resolve({ comments: [{ ...sample[0], cid: 'new-B' }] });
        await refresh;
        assert.deepEqual(h.calls.rendered.at(-1).map(c => c.cid).sort(), ['new-A', 'new-B', 'new-main']);
        assert.equal(h.ede.extCommentCache[h.item.itemId]['https://A'][0].cid, 'new-A');
        assert.equal(h.ede.loading, false);
    }
});

test('another tab cannot overwrite a manual selection with a late automatic search', async () => {
    const shared = storageFixture();
    const a = setup(shared), b = setup(shared);
    let finish;
    b.context.searchEpisodes = () => new Promise(resolve => { finish = resolve; });
    const old = b.context.loadOnlineDanmaku('init');
    await waitUntil(() => finish);
    a.context.doDanmakuSwitchEpisode();
    finish({ directMatch: true, episodeInfo: { episodeId: 999, animeId: 9 } });
    await old;
    assert.equal(b.matched().episodeId, '222');
    assert.equal(b.calls.rendered.length, 0);
    await b.context.loadOnlineDanmaku('reload');
    assert.equal(b.ede.episode_info.episodeId, '222');
    assert.equal(b.calls.rendered.length, 1);
});

test('a write racing after the last revision check remains in an unreachable old namespace', async () => {
    const shared = storageFixture();
    const a = setup(shared), b = setup(shared);
    b.context.searchEpisodes = async () => ({ directMatch: true, episodeInfo: { episodeId: 999, animeId: 9 } });
    shared.control.beforeSet = key => {
        if (key === '_api_official__episode_id_rel_1_2') {
            shared.control.beforeSet = null;
            a.context.doDanmakuSwitchEpisode();
        }
    };
    await b.context.loadOnlineDanmaku('init');
    assert.equal(JSON.parse(shared.storage['_api_official__episode_id_rel_1_2']).episodeId, 999);
    assert.equal(a.matched().episodeId, '222');
    assert.equal(b.matched().episodeId, '222');
    assert.equal(b.calls.rendered.length, 0);
});

test('cross-tab rematching invalidates pending comment responses without waiting for storage events', async () => {
    const shared = storageFixture();
    const a = setup(shared), b = setup(shared);
    let finish;
    b.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
    b.respond(() => new Promise(resolve => { finish = resolve; }));
    const old = b.context.loadOnlineDanmaku('init');
    await waitUntil(() => finish);
    a.context.doDanmakuSwitchEpisode();
    finish({ comments: sample });
    await old;
    assert.equal(b.cacheKeys().length, 0);
    assert.equal(b.calls.rendered.length, 0);
    assert.equal(b.matched().episodeId, '222');
});

test('storage notifications reset only the affected active scope and register once', () => {
    const h = setup();
    h.context.startCommentCacheCleanup();
    h.context.startCommentCacheCleanup();
    assert.equal(h.listeners.size, 1);
    h.ede.episode_info = { episodeId: 111 };
    const notify = h.listeners.get('storage');
    notify({ key: '_dandanplay_match_scope_v1__anime_season_rel_other' });
    assert.equal(h.ede.episode_info.episodeId, 111);
    notify({ key: '_dandanplay_match_scope_v1_' + h.item._season_key });
    assert.equal(h.ede.episode_info, null);
});

test('clearing all history revokes earlier scope versions in every tab', async () => {
    const shared = storageFixture();
    const a = setup(shared), b = setup(shared);
    a.context.doDanmakuSwitchEpisode();
    assert.equal(b.matched().episodeId, '222');
    const oldContext = b.context.getMatchContext(b.item._season_key);
    a.seed('danmakuFilterKeywords', 'keep');
    a.context.clearAllMatchHistory();
    b.context.writeEpisodeMatch(oldContext, b.item._episode_key, { episodeId: 999 });
    assert.equal(b.matched(), null);
    assert.equal(shared.storage.getItem('danmakuFilterKeywords'), '"keep"');
});

test('legacy empty comment entries expire at five minutes, while nonempty results keep one day', async () => {
    const h = setup();
    h.respond(async () => ({ comments: [] }));
    await h.context.fetchComment(111);
    const key = h.cacheKeys()[0];
    const legacy = JSON.parse(h.storage[key]);
    delete legacy.epoch;
    delete legacy.revision;
    h.seed(key, legacy);
    h.respond(async () => ({ comments: sample }));
    h.advance(5 * 60 * 1000 - 1);
    assert.equal((await h.context.fetchComment(111)).length, 0);
    assert.equal(h.calls.requests.length, 1);
    h.advance(1);
    assert.equal((await h.context.fetchComment(111)).length, 1);
    assert.equal(h.calls.requests.length, 2);
    h.advance(5 * 60 * 1000);
    await h.context.fetchComment(111);
    assert.equal(h.calls.requests.length, 2);
});

test('force refresh keeps the current inferred match and coalesces clicks across all active sources', async () => {
    const h = setup();
    bindEpisode(h, { episodeId: 111, animeId: 11 });
    h.ede.danmuCache = { 111: sample };
    h.ede.extCommentCache = { 'item-2': { 'https://A': [], 'https://B': [] } };
    const first = h.context.forceRefreshComments();
    const second = h.context.forceRefreshComments();
    assert.equal(first, second);
    await first;
    assert.equal(h.calls.searches, 0);
    assert.equal(h.calls.requests.length, 3);
    assert.equal(h.ede.episode_info.episodeId, 111);
    assert.deepEqual(Object.keys(h.ede.extCommentCache['item-2']), ['https://A', 'https://B']);
    await h.context.forceRefreshComments();
    assert.equal(h.calls.requests.length, 6);
});

test('force refresh supersedes an ordinary pending request instead of reusing its result', async () => {
    const h = setup();
    h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
    const pending = [];
    h.respond(() => new Promise(resolve => pending.push(resolve)));
    const ordinary = h.context.loadOnlineDanmaku('init');
    await waitUntil(() => pending.length === 1);
    const forced = h.context.forceRefreshComments();
    await waitUntil(() => pending.length === 2);
    pending[1]({ comments: [{ ...sample[0], m: 'new' }] });
    await forced;
    pending[0]({ comments: [{ ...sample[0], m: 'old' }] });
    await ordinary;
    assert.equal(h.calls.rendered.length, 1);
    assert.equal(h.calls.rendered[0][0].m, 'new');
    assert.equal(JSON.parse(h.storage[h.cacheKeys()[0]]).comments[0].m, 'new');
});

test('failed forced main or extra requests preserve the current display and matching', async () => {
    for (const failure of ['comment', 'extcomment']) {
        const h = setup();
        h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
        h.ede.episode_info = { episodeId: 111 };
        h.ede.danmuCache = { 111: plain(sample) };
        h.ede.extCommentCache = { 'item-2': { 'https://A': [{ ...sample[0], cid: 'A' }] } };
        const original = plain(h.ede.extCommentCache);
        h.respond(async url => {
            if ((failure === 'extcomment') === url.includes('/extcomment?')) throw new Error('HTTP 429');
            return { comments: [{ ...sample[0], m: 'new' }] };
        });
        await h.context.forceRefreshComments();
        assert.equal(h.calls.rendered.length, 0);
        assert.deepEqual(plain(h.ede.danmuCache[111]), sample);
        assert.deepEqual(plain(h.ede.extCommentCache), original);
        assert.equal(h.ede.episode_info.episodeId, 111);
        assert.equal(h.ede.loading, false);
        assert.ok(h.calls.toasts.some(message => message.includes('保留当前弹幕')));
    }
});

test('additional sources survive ordinary reload without losing earlier sources or making new requests', async () => {
    const h = setup();
    h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
    h.respond(async url => ({ comments: url.includes('/comment/') ? sample
        : [{ ...sample[0], cid: url.includes('https://A') ? 'A' : 'B' }] }));
    await h.context.loadOnlineDanmaku('init');
    await h.context.addExtComments('https://A');
    await h.context.addExtComments('https://B');
    await h.context.loadOnlineDanmaku('reload');
    assert.equal(h.calls.requests.length, 3);
    assert.deepEqual(h.calls.rendered.at(-1).map(c => c.cid), ['1', 'A', 'B']);
});

test('a source removed during force refresh is not restored by its late result', async () => {
    const h = setup();
    bindEpisode(h, { episodeId: 111 });
    h.ede.danmuCache = { 111: sample };
    h.ede.extCommentCache = { 'item-2': { 'https://A': [{ ...sample[0], cid: 'A' }] } };
    let finish;
    h.respond(async url => url.includes('/comment/') ? { comments: sample }
        : new Promise(resolve => { finish = resolve; }));
    const refresh = h.context.forceRefreshComments();
    await waitUntil(() => finish);
    await h.context.removeExtComment('https://A');
    finish({ comments: [{ ...sample[0], cid: 'A' }] });
    await refresh;
    assert.deepEqual(Object.keys(h.ede.extCommentCache['item-2']), []);
    assert.deepEqual(h.calls.rendered.at(-1).map(c => c.cid), ['1']);
});

test('an additional source finishing after playback stops cannot render or attach to the old item', async () => {
    const h = setup();
    install(h.context, ['onPlaybackStop']);
    h.context.onPlaybackStopPct = () => {};
    h.context.lsKeys = { osdHeaderClockEnable: { id: 'clock' } };
    h.context.lsGetItem = () => false;
    h.context.danmakuAutoFilterCancel = () => {};
    h.ede.episode_info = { episodeId: 111 };
    let finish;
    h.respond(() => new Promise(resolve => { finish = resolve; }));
    const adding = h.context.addExtComments('https://A');
    h.context.onPlaybackStop({ type: 'playbackstop' }, { NowPlayingItem: { Id: h.item.itemId } });
    finish({ comments: sample });
    await adding;
    assert.equal(h.calls.rendered.length, 0);
    assert.deepEqual(plain(h.ede.extCommentCache), {});
});

test('the real season lookup reads both legacy offsets and newly published manual offsets', async () => {
    const h = setup();
    install(h.context, ['lsSeasonSearchEpisodes']);
    const searches = [];
    h.context.fetchSearchEpisodes = async (title, episode) => {
        searches.push([title, episode]);
        return { animes: [{ animeId: 22, episodes: [{ episodeId: 222 }] }] };
    };
    h.seed(h.item._season_key, [{ name: 'legacy-title', episodeOffset: -1 }]);
    await h.context.lsSeasonSearchEpisodes(h.item._season_key, 2);
    h.context.doDanmakuSwitchEpisode();
    await h.context.lsSeasonSearchEpisodes(h.item._season_key, 2);
    assert.deepEqual(searches, [['legacy-title', 1], ['新选择', 3]]);
});

test('two manual revisions keep the last published choice after reload and ignore stale writes', () => {
    const shared = storageFixture();
    const a = setup(shared), b = setup(shared);
    a.context.doDanmakuSwitchEpisode();
    const oldContext = a.context.getMatchContext(a.item._season_key);
    b.elements.episode.value = '333';
    b.context.doDanmakuSwitchEpisode();
    a.context.writeEpisodeMatch(oldContext, a.item._episode_key, { episodeId: 999 });
    const reopened = setup(shared);
    assert.equal(a.matched().episodeId, '333');
    assert.equal(reopened.matched().episodeId, '333');
    assert.notEqual(oldContext.revision, reopened.context.getMatchContext(a.item._season_key).revision);
});

test('immediate force refresh after same-season, cross-season or episode-key changes loads the current episode', async () => {
    for (const next of [
        { itemId: 'next-item', _season_key: '_anime_season_rel_1', _episode_key: '_episode_id_rel_1_3' },
        { itemId: 'next-item', _season_key: '_anime_season_rel_2', _episode_key: '_episode_id_rel_2_1' },
        { itemId: 'item-2', _season_key: '_anime_season_rel_1', _episode_key: '_episode_id_rel_1_3' },
    ]) {
        const h = setup();
        useRealLoader(h);
        h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
        h.respond(async url => ({ comments: [{ ...sample[0], m: url.includes('/222?') ? 'current' : 'previous' }] }));
        await h.context.loadDanmaku('init');
        Object.assign(h.item, next);
        h.seed('_api_official_' + next._episode_key, { episodeId: 222 });
        showItem(h, next.itemId);
        await h.context.forceRefreshComments();
        assert.match(h.calls.requests.at(-1), /\/222\?/);
        assert.equal(h.calls.rendered.at(-1)[0].m, 'current');
        assert.equal(h.ede.episodeInfoOwner.episodeKey, next._episode_key);
        assert.equal(h.ede.episode_info.episodeId, 222);
    }
});

test('force refresh rejects unbound episode info and outdated scope ownership', async () => {
    for (const hasWrongOwner of [false, true]) {
        const h = setup();
        h.seed('_api_official__episode_id_rel_1_2', { episodeId: 222 });
        h.ede.episode_info = { episodeId: 111 };
        if (hasWrongOwner) {
            bindEpisode(h, { episodeId: 111 });
            h.ede.episodeInfoOwner.context = h.context.getMatchContext('_anime_season_rel_other');
        }
        await h.context.forceRefreshComments();
        assert.match(h.calls.requests[0], /\/222\?/);
        assert.equal(h.ede.episode_info.episodeId, 222);
    }
});

test('a genuinely loaded inferred match retains ownership and can be force-refreshed without searching', async () => {
    const h = setup();
    useRealLoader(h);
    h.ede.previous_episode_info = { episodeId: 110, episodeIndex: 0, seriesOrMovieId: 'show' };
    await h.context.loadDanmaku('init');
    assert.equal(h.ede.episode_info.episodeId, 111);
    assert.equal(h.matched(), null);
    h.ede.previous_episode_info = null;
    await h.context.forceRefreshComments();
    assert.equal(h.calls.searches, 0);
    assert.equal(h.calls.requests.length, 2);
    assert.equal(h.ede.episode_info.episodeId, 111);
});

test('a settings callback during loading queues the latest conversion and never renders the old response', async () => {
    const h = setup();
    const change = useRealLoader(h);
    h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
    const pending = [];
    h.respond(url => new Promise(resolve => pending.push({ url, resolve })));
    const loading = h.context.loadDanmaku('init');
    await waitUntil(() => pending.length === 1);
    change(2);
    assert.equal(pending.length, 1);
    pending[0].resolve({ comments: [{ ...sample[0], m: 'old-conversion' }] });
    await waitUntil(() => pending.length === 2);
    assert.equal(h.calls.rendered.length, 0);
    assert.equal(h.ede.episode_info, null);
    assert.match(pending[1].url, /chConvert=2/);
    assert.equal(JSON.parse(h.storage[h.cacheKeys()[0]]).comments[0].m, 'old-conversion');
    pending[1].resolve({ comments: [{ ...sample[0], m: 'latest-conversion' }] });
    await loading;
    assert.deepEqual(h.calls.rendered.map(comments => comments[0].m), ['latest-conversion']);
    assert.equal(h.ede.loading, false);
    assert.equal(h.ede.pendingDanmakuReload, null);
});

test('multiple settings changes collapse to one latest reload, including returning to the original conversion', async () => {
    for (const finalConversion of [0, 1]) {
        const h = setup();
        const change = useRealLoader(h);
        h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
        let finish;
        h.respond(() => new Promise(resolve => { finish = resolve; }));
        const loading = h.context.loadDanmaku('init');
        await waitUntil(() => finish);
        change(2);
        change(1);
        change(finalConversion);
        h.respond(async () => ({ comments: [{ ...sample[0], m: `conversion-${finalConversion}` }] }));
        finish({ comments: [{ ...sample[0], m: 'conversion-1' }] });
        await loading;
        assert.equal(h.calls.requests.length, finalConversion === 1 ? 1 : 2);
        assert.deepEqual(h.calls.rendered.map(comments => comments[0].m), [`conversion-${finalConversion}`]);
    }
});

test('a failed old request still drains the settings queue and a failed latest request does not loop', async () => {
    for (const latestFails of [false, true]) {
        const h = setup();
        const change = useRealLoader(h);
        h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
        let rejectOld;
        h.respond(() => new Promise((resolve, reject) => { rejectOld = reject; }));
        const loading = h.context.loadDanmaku('init');
        await waitUntil(() => rejectOld);
        change(2);
        h.respond(async () => {
            if (latestFails) throw new Error('HTTP 429 latest');
            return { comments: sample };
        });
        rejectOld(new Error('HTTP 429 old'));
        await loading;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.calls.requests.length, 2);
        assert.equal(h.calls.rendered.length, latestFails ? 0 : 1);
        assert.equal(h.ede.loading, false);
        assert.equal(h.ede.pendingDanmakuReload, null);
    }
});

test('conversion changes before metadata resolution do not send an obsolete comment request', async () => {
    const h = setup();
    const change = useRealLoader(h);
    h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
    let finish;
    h.context.getMapByEmbyItemInfo = () => new Promise(resolve => { finish = resolve; });
    const loading = h.context.loadDanmaku('init');
    change(2);
    h.context.getMapByEmbyItemInfo = async () => h.item;
    finish(h.item);
    await loading;
    assert.equal(h.calls.requests.length, 1);
    assert.match(h.calls.requests[0], /chConvert=2/);
    assert.equal(h.calls.rendered.length, 1);
});

test('force refresh keeps its intent and shared promise until the newest settings finish', async () => {
    const h = setup();
    const change = useRealLoader(h, true);
    bindEpisode(h, { episodeId: 111 });
    let xmlCalls = 0;
    h.context.getCommentsByPluginApi = async () => { xmlCalls++; return sample; };
    const pending = [];
    h.respond(url => new Promise(resolve => pending.push({ url, resolve })));
    const forced = h.context.forceRefreshComments();
    let settled = false;
    forced.then(() => { settled = true; });
    await waitUntil(() => pending.length === 1);
    change(2);
    assert.equal(h.context.forceRefreshComments(), forced);
    pending[0].resolve({ comments: [{ ...sample[0], m: 'old' }] });
    await waitUntil(() => pending.length === 2);
    assert.equal(settled, false);
    assert.equal(h.calls.rendered.length, 0);
    assert.equal(h.ede.onlineLoadRequest.force, true);
    assert.equal(h.context.forceRefreshComments(), forced);
    assert.match(pending[1].url, /chConvert=2/);
    pending[1].resolve({ comments: [{ ...sample[0], m: 'new' }] });
    await forced;
    assert.deepEqual(h.calls.rendered.map(comments => comments[0].m), ['new']);
    assert.equal(xmlCalls, 0);
});

test('XML success and XML fallback both drain settings changes through the same finalizer', async () => {
    for (const xmlFails of [false, true]) {
        const h = setup();
        const change = useRealLoader(h, true);
        h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
        const pending = [];
        h.context.getCommentsByPluginApi = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
        const loading = h.context.loadDanmaku('init');
        await waitUntil(() => pending.length === 1);
        change(2);
        if (xmlFails) pending[0].reject(new Error('old XML failed'));
        else pending[0].resolve([{ ...sample[0], m: 'old XML' }]);
        await waitUntil(() => pending.length === 2);
        assert.equal(h.calls.rendered.length, 0);
        assert.equal(h.calls.requests.length, 0);
        if (xmlFails) pending[1].reject(new Error('latest XML failed'));
        else pending[1].resolve([{ ...sample[0], m: 'latest XML' }]);
        await loading;
        assert.equal(h.calls.rendered.length, 1);
        assert.equal(h.calls.requests.length, xmlFails ? 1 : 0);
        if (xmlFails) assert.match(h.calls.requests[0], /chConvert=2/);
        else assert.equal(h.calls.rendered[0][0].m, 'latest XML');
        assert.equal(h.ede.loading, false);
        assert.equal(h.ede.pendingDanmakuReload, null);
    }
});

test('XML empty results and metadata failures release loading without repeated retries', async () => {
    const h = setup();
    useRealLoader(h, true);
    h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
    h.context.getCommentsByPluginApi = async () => [];
    await h.context.loadDanmaku('init');
    assert.equal(h.calls.requests.length, 1);
    assert.equal(h.calls.rendered.length, 1);
    assert.equal(h.ede.loading, false);
    h.context.getMapByEmbyItemInfo = async () => { throw new Error('metadata failure'); };
    await h.context.loadDanmaku('refresh');
    assert.equal(h.calls.requests.length, 1);
    assert.equal(h.ede.loading, false);
});

test('switching or stopping playback cancels its queued reload and invalidates episode ownership', async () => {
    for (const event of ['switch', 'stop', 'hide']) {
        const h = setup();
        const change = useRealLoader(h);
        h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
        bindEpisode(h, { episodeId: 111 });
        let finish;
        h.respond(() => new Promise(resolve => { finish = resolve; }));
        const loading = h.context.loadDanmaku('init');
        await waitUntil(() => finish);
        change(2);
        if (event === 'switch') showItem(h, 'next-item');
        if (event === 'stop') {
            install(h.context, ['onPlaybackStop']);
            h.context.onPlaybackStopPct = () => {};
            h.context.danmakuAutoFilterCancel = () => {};
            h.context.onPlaybackStop({ type: 'playbackstop' }, { NowPlayingItem: { Id: h.item.itemId } });
        }
        if (event === 'hide') {
            install(h.context, ['beforeDestroy']);
            h.context.getVideoOsdView = () => null;
            for (const name of ['stopUIInit', 'removeHeaderClock', 'videoTimeUpdateInterval', 'destroyAllInterval']) h.context[name] = () => {};
            h.context.beforeDestroy({ detail: { type: 'video-osd' } });
        }
        finish({ comments: sample });
        await loading;
        assert.equal(h.calls.requests.length, 1);
        assert.equal(h.calls.rendered.length, 0);
        assert.equal(h.ede.pendingDanmakuReload, null);
        assert.equal(h.ede.episodeInfoOwner, null);
    }
});

test('rematching clears an old settings queue without releasing or replaying over the new load', async () => {
    const h = setup();
    const change = useRealLoader(h);
    h.seed('_api_official__episode_id_rel_1_2', { episodeId: 111 });
    const pending = [];
    h.respond(url => new Promise(resolve => pending.push({ url, resolve })));
    const old = h.context.loadDanmaku('init');
    await waitUntil(() => pending.length === 1);
    change(2);
    h.context.doDanmakuSwitchEpisode();
    const current = h.ede.onlineLoadRequest.promise;
    await waitUntil(() => pending.length === 2);
    assert.match(pending[1].url, /\/222\?chConvert=2/);
    pending[0].resolve({ comments: sample });
    await old;
    assert.equal(h.ede.loading, true);
    pending[1].resolve({ comments: [{ ...sample[0], m: 'new match' }] });
    await current;
    assert.equal(h.calls.requests.length, 2);
    assert.deepEqual(h.calls.rendered.map(comments => comments[0].m), ['new match']);
    assert.equal(h.ede.pendingDanmakuReload, null);
});
