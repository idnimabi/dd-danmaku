import test from 'node:test';
import assert from 'node:assert/strict';

const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../ede.js', import.meta.url), 'utf8'));

test('uses the configured proxy prefix exclusively for the official API', () => {
    assert.match(source, /const dandanplayOfficialPrefix = 'https:\/\/api\.dandanplay\.net\/api\/v2';/);
    assert.match(source, /getApiPrefix:\s*\(\)\s*=>\s*\{[\s\S]*?const proxyPrefix = normalizeApiPrefix\(lsGetItem\(lsKeys\.customeCorsProxyUrl\.id\)\);[\s\S]*?return proxyPrefix \? `\$\{proxyPrefix\}\/\$\{dandanplayOfficialPrefix\}` : '';/);
});

test('does not expose or read multi-source API configuration', () => {
    assert.doesNotMatch(source, /getApiConfigs|apiPriority|customApiPrefix|useCustomApi|useOfficialApi/);
    assert.doesNotMatch(source, /API选择、自定义API配置/);
});

test('uses a single official prefix for search, comments, metadata, and match requests', () => {
    assert.match(source, /async function fetchSearchEpisodes\(anime, episode\)/);
    assert.match(source, /async function fetchTmdbIdByAnime\(anime\)/);
    assert.match(source, /async function fetchSearchEpisodesByTmdb\(tmdbId, episode\)/);
    assert.match(source, /async function fetchComment\(episodeId\)/);
    assert.match(source, /const prefix = dandanplayApi\.getApiPrefix\(\);/);
    assert.doesNotMatch(source, /apiPrefix|apiName/);
});

test('uses a fixed official cache namespace and does not show API sources', () => {
    assert.match(source, /episodeMatchPrefix:\s*'_api_official_'/);
    assert.match(source, /const unique_episode_key = lsLocalKeys\.episodeMatchPrefix \+ _episode_key;/);
    assert.doesNotMatch(source, /来源：\$\{opt\.apiName\}|来源: \$\{selectedAnime\.apiName\}/);
});

test('does not contain the retired hard-coded proxy endpoint', () => {
    assert.doesNotMatch(source, /ddplay-api\.7o7o\.cc\/cors/);
});

test('forces an OSD proxy-configuration prompt when the proxy is missing', () => {
    assert.match(source, /if \(!dandanplayApi\.getApiPrefix\(\)\) \{\s*appendvideoOsdDanmakuInfo\(\);\s*return null;/);
    assert.match(source, /const isProxyMissing = !dandanplayApi\.getApiPrefix\(\);/);
    assert.match(source, /if \(!isProxyMissing && !lsGetItem\(lsKeys\.osdTitleEnable\.id\)\)/);
    assert.match(source, /text \+= `请先填写\$\{lsKeys\.customeCorsProxyUrl\.name\}`;/);
});
