import { strict as assert } from 'node:assert';
import * as cheerio from 'cheerio';
import { describe, it } from 'node:test';
import { extractSeriesTitle } from '../src/sites/maccms-stui.js';
import {
  collectJsEpisodeLinks,
  extractM3u8Url,
  jsvarPlayAdapter,
  parseJsPlayUrl,
} from '../src/sites/jsvar-play.js';

const PAGE_URL = 'https://www.mengnijia.com/movie/49546165/106140747.html';

const REAL_PAGE_SNIPPET = `
<html><head><title>传闻中的陈芊芊第01集-传闻中的陈芊芊免费在线观看 - VS影视</title></head><body>
<div class="stui-pannel">
  <a href="https://www.mengnijia.com/movie/49546165/106140747.html">第01集</a>
  <a href="/movie/49546165/106140748.html">第02集</a>
  <a href="/movie/49546165/106140749.html">第03集</a>
</div>
<script>
thisUrl = "https://vip.dytt-play.com/20250122/416_8fe0093b/index.m3u8";
thisTitle = '建议收藏: ' + window.location.host;
document.getElementById('player').innerHTML = '<iframe src="/artplayer/index.php?url='+thisUrl+'">';
</script>
</body></html>
`;

describe('jsvar-play 适配器', () => {
  it('parseJsPlayUrl 解析 /movie/{vodId}/{pageId}.html', () => {
    const info = parseJsPlayUrl(new URL(PAGE_URL));
    assert.deepEqual(info, { prefix: 'movie', vodId: '49546165', pageId: '106140747' });
    assert.equal(parseJsPlayUrl(new URL('https://s.com/movie/49546165.html')), null);
  });

  it('match 仅对已知站点生效', () => {
    assert.equal(jsvarPlayAdapter.match(new URL(PAGE_URL)), true);
    assert.equal(jsvarPlayAdapter.match(new URL('https://other.com/movie/1/2.html')), false);
    assert.equal(jsvarPlayAdapter.match(new URL('https://www.mengnijia.com/detail/1.html')), false);
  });

  it('collectJsEpisodeLinks 同 vod 链接按顺序编号并去重', () => {
    const html = `
      <a href="https://www.mengnijia.com/movie/49546165/106140747.html">第01集</a>
      <a href="/movie/49546165/106140748.html">第02集</a>
      <a href="/movie/49546165/106140748.html">第02集</a>
      <a href="/movie/99999/106140750.html">其它剧集</a>
      <a href="/movie/49546165/106140749.html">花絮</a>`;
    const episodes = collectJsEpisodeLinks(cheerio.load(html), PAGE_URL);
    assert.equal(episodes.length, 3);
    assert.deepEqual(episodes.map((e) => e.nid), [1, 2, 3]); // “花絮”按顺序编号
    assert.equal(episodes[0]!.label, '第01集');
    assert.equal(episodes[2]!.label, '花絮');
  });

  it('collectJsEpisodeLinks 标签集号可靠时按标签编号', () => {
    const html = `
      <a href="/movie/49546165/106140749.html">第03集</a>
      <a href="/movie/49546165/106140747.html">第01集</a>
      <a href="/movie/49546165/106140748.html">第02集</a>`;
    const episodes = collectJsEpisodeLinks(cheerio.load(html), PAGE_URL);
    assert.deepEqual(episodes.map((e) => e.nid), [1, 2, 3]); // 与 DOM 顺序无关
  });

  it('collectJsEpisodeLinks 同一 pageId 多标签时优先「第NN集」样式', () => {
    const html = `
      <a href="/movie/49546165/106140747.html">传闻中的陈芊芊在线播放</a>
      <a href="/movie/49546165/106140748.html">第02集</a>
      <a href="/movie/49546165/106140747.html">第01集</a>`;
    const episodes = collectJsEpisodeLinks(cheerio.load(html), PAGE_URL);
    assert.equal(episodes.length, 2);
    assert.equal(episodes[0]!.label, '第01集'); // 冗长标题被替换
    assert.equal(episodes[1]!.label, '第02集');
  });

  it('extractSeriesTitle 从标题剥离集号与站点后缀', () => {
    const html = '<title>传闻中的陈芊芊第01集-传闻中的陈芊芊免费在线观看 - VS影视</title>';
    assert.equal(extractSeriesTitle(html), '传闻中的陈芊芊');
    assert.equal(extractSeriesTitle('<title>某剧第12话在线播放</title>'), '某剧');
    // 8090hub 形态：书名号 + 「剧集」修饰 + 站点后缀
    assert.equal(
      extractSeriesTitle('<title>《大奉打更人》剧集第01集免费在线播放_8090电影网</title>'),
      '大奉打更人',
    );
    assert.equal(extractSeriesTitle('<html></html>'), '');
  });

  it('extractM3u8Url 支持内嵌 JS 变量与 player_data 两种形态', () => {
    assert.equal(
      extractM3u8Url(REAL_PAGE_SNIPPET, PAGE_URL),
      'https://vip.dytt-play.com/20250122/416_8fe0093b/index.m3u8',
    );
    const withPlayerData = '<script>var player_data={"encrypt":0,"url":"//cdn.com/a/index.m3u8","sid":1,"nid":1};</script>';
    assert.equal(extractM3u8Url(withPlayerData, PAGE_URL), 'https://cdn.com/a/index.m3u8');
    assert.throws(() => extractM3u8Url('<html></html>', PAGE_URL), /未找到 m3u8/);
  });
});
