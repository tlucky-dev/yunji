import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  extractJsObject,
  extractPlayerData,
  parsePlayUrl,
  parseSourceBlocks,
  toAbsoluteUrl,
} from '../src/sites/maccms-stui.js';
import * as cheerio from 'cheerio';

const REAL_PAGE_SNIPPET = `
<html><body>
<script>var player_data={"flag":"play","encrypt":0,"trysee":0,"points":0,
"link":"\\/yun\\/11757-1-1.html","link_next":"\\/yun\\/11757-3-2.html",
"vod_data":{"vod_name":"\\u8d58\\u5a7f","vod_actor":"\\u90ed\\u9e92\\u9e9f"},
"url":"https:\\/\\/hn.bfvvs.com\\/play\\/Yer0BJBb\\/index.m3u8",
"url_next":"https:\\/\\/hn.bfvvs.com\\/play\\/Pdy870zb\\/index.m3u8",
"from":"hnm3u8","server":"no","note":"","id":"11757","sid":3,"nid":1};</script>
<div class="stui-player__side">
  <ul class="tab-top play-tab clearfix"><li><a href="javascript:;">红牛云播</a></li><li><a href="javascript:;">索尼云播</a></li></ul>
  <div class="play-content">
    <div class="play-item cont active"><ul class="stui-play__list clearfix">
      <li class="active"><a href="/yun/11757-3-1.html">第01集</a></li>
      <li><a href="/yun/11757-3-2.html">第02集</a></li>
    </ul></div>
    <div class="play-item cont"><ul class="stui-play__list clearfix">
      <li><a href="/yun/11757-1-1.html">第01集</a></li>
      <li><a href="/yun/11757-1-2.html">第02集</a></li>
    </ul></div>
  </div>
</div>
</body></html>
`;

describe('maccms-stui 适配器', () => {
  it('parsePlayUrl 解析 /yun/{id}-{sid}-{nid}.html', () => {
    const info = parsePlayUrl(new URL('https://www.maliys.com/yun/11757-3-1.html'));
    assert.deepEqual(info, { prefix: 'yun', vodId: '11757', sid: 3, nid: 1 });
    assert.equal(parsePlayUrl(new URL('https://www.maliys.com/html/11757.html')), null);
  });

  it('extractJsObject 能处理字符串中的花括号', () => {
    const html = `var x=1; var player_data={"url":"https://a.com/}weird.m3u8","n":2}; var y=3;`;
    const obj = extractJsObject(html, 'player_data') as { url: string; n: number };
    assert.equal(obj.url, 'https://a.com/}weird.m3u8');
    assert.equal(obj.n, 2);
  });

  it('extractPlayerData 解析真实页面片段（含 unicode 与转义斜杠）', () => {
    const pageUrl = 'https://www.maliys.com/yun/11757-3-1.html';
    const data = extractPlayerData(REAL_PAGE_SNIPPET, pageUrl);
    assert.equal(data.url, 'https://hn.bfvvs.com/play/Yer0BJBb/index.m3u8');
    assert.equal(data.url_next, 'https://hn.bfvvs.com/play/Pdy870zb/index.m3u8');
    assert.equal(data.vod_data?.vod_name, '赘婿');
    assert.equal(data.sid, 3);
    assert.equal(data.nid, 1);
    assert.equal(data.id, '11757');
  });

  it('decrypt：encrypt=1（unescape）与 encrypt=2（base64+unescape）', () => {
    const html1 = `<script>var player_data={"encrypt":1,"url":"https%3A%2F%2Fa.com%2Fx.m3u8","sid":1,"nid":1};</script>`;
    assert.equal(extractPlayerData(html1, 'https://s.com/p/1-1-1.html').url, 'https://a.com/x.m3u8');
    const raw2 = Buffer.from('https://b.com/y.m3u8', 'utf-8').toString('base64');
    const html2 = `<script>var player_data={"encrypt":2,"url":"${raw2}","sid":1,"nid":1};</script>`;
    assert.equal(extractPlayerData(html2, 'https://s.com/p/1-1-1.html').url, 'https://b.com/y.m3u8');
  });

  it('parseSourceBlocks 按源分块解析选集并匹配源名', () => {
    const $ = cheerio.load(REAL_PAGE_SNIPPET);
    const blocks = parseSourceBlocks($, 'https://www.maliys.com/yun/11757-3-1.html');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.sid, 3);
    assert.equal(blocks[0]!.label, '红牛云播');
    assert.equal(blocks[0]!.episodes.length, 2);
    assert.equal(blocks[0]!.episodes[0]!.playUrl, 'https://www.maliys.com/yun/11757-3-1.html');
    assert.equal(blocks[1]!.sid, 1);
    assert.equal(blocks[1]!.label, '索尼云播');
  });

  it('parseSourceBlocks 通用兜底：空 href 的 UI 链接（如“清空”）不冒充选集', () => {
    const html = `
<div id="ewave-playlist-13" class="ewave-playlist-content">
  <a class="historyclean text-muted pull-right" href="">清空</a>
  <a href="/play/16787-3-1.html">第01集</a>
  <a href="/play/16787-3-2.html">第02集</a>
</div>`;
    const $ = cheerio.load(html);
    const blocks = parseSourceBlocks($, 'https://www.8090hub.cc/play/16787-3-1.html');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.episodes.length, 2);
    assert.equal(blocks[0]!.episodes[0]!.label, '第01集'); // 未被「清空」抢占
    assert.ok(!blocks[0]!.episodes.some((e) => e.label === '清空'));
  });

  it('toAbsoluteUrl 处理协议相对与相对路径', () => {
    const base = 'https://s.com/yun/1-1-1.html';
    assert.equal(toAbsoluteUrl('//cdn.com/a.m3u8', base), 'https://cdn.com/a.m3u8');
    assert.equal(toAbsoluteUrl('/play/x/index.m3u8', base), 'https://s.com/play/x/index.m3u8');
    assert.equal(toAbsoluteUrl('https://k.com/a.m3u8', base), 'https://k.com/a.m3u8');
  });

  it('extractPlayerData 回退解析 player_aaaa（原生/ewave 模板）', () => {
    const html = `<script>var player_aaaa={"flag":"play","encrypt":0,
"link":"/py/67184-13-1.html","link_next":"/py/67184-13-2.html",
"vod_data":{"vod_name":"传闻中的陈芊芊"},
"url":"https://svip.xgplay5.com/2025/index.m3u8","from":"xiguam3u8",
"id":"67184","sid":13,"nid":1};</script>`;
    const pageUrl = 'https://www.pdy7.com/py/67184-13-1.html';
    const data = extractPlayerData(html, pageUrl);
    assert.equal(data.url, 'https://svip.xgplay5.com/2025/index.m3u8');
    assert.equal(data.vod_data?.vod_name, '传闻中的陈芊芊');
    assert.equal(data.sid, 13);
    assert.equal(data.nid, 1);
  });

  it('player_data 优先于 player_aaaa', () => {
    const html = `<script>var player_data={"encrypt":0,"url":"https://a.com/data.m3u8","sid":1,"nid":1};</script>
<script>var player_aaaa={"encrypt":0,"url":"https://b.com/aaaa.m3u8","sid":1,"nid":1};</script>`;
    assert.equal(
      extractPlayerData(html, 'https://s.com/p/1-1-1.html').url,
      'https://a.com/data.m3u8',
    );
  });

  it('parseSourceBlocks 通用兜底：同 vod 链接按 sid 分组，ewave 源名取自 data-target', () => {
    const html = `
<div class="playlist-tab"><ul class="swiper-wrapper">
  <li class="swiper-slide ewave-tab" data-target="#ewave-playlist-13">西瓜<span class="badge">2</span><em></em></li>
  <li class="swiper-slide ewave-tab" data-target="#ewave-playlist-9">天堂<span class="badge">2</span><em></em></li>
</ul></div>
<div id="ewave-playlist-13" class="ewave-playlist-content">
  <a class="ewave-playlist-item" href="/py/67184-13-2.html">第02集</a>
  <a class="ewave-playlist-item" href="/py/67184-13-1.html">第01集</a>
  <a class="ewave-playlist-item" href="/py/67184-13-1.html">第01集</a>
</div>
<div id="ewave-playlist-9" class="ewave-playlist-content">
  <a class="ewave-playlist-item" href="/py/67184-9-1.html">第01集</a>
  <a class="ewave-playlist-item" href="/py/67184-9-2.html">第02集</a>
</div>
<a href="/py/99999-13-1.html">其它剧集的推荐位</a>`;
    const $ = cheerio.load(html);
    const blocks = parseSourceBlocks($, 'https://www.pdy7.com/py/67184-13-1.html');
    assert.equal(blocks.length, 2);
    const bySid = new Map(blocks.map((b) => [b.sid, b]));
    const watermelon = bySid.get(13)!;
    assert.equal(watermelon.label, '西瓜'); // badge 数字被去掉
    assert.equal(watermelon.episodes.length, 2); // 重复 nid 去重
    assert.deepEqual(watermelon.episodes.map((e) => e.nid), [1, 2]); // 不受 DOM 顺序影响
    assert.equal(bySid.get(9)!.label, '天堂');
    assert.equal(bySid.get(9)!.episodes[0]!.playUrl, 'https://www.pdy7.com/py/67184-9-1.html');
  });
});
