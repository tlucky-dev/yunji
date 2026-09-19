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

  it('toAbsoluteUrl 处理协议相对与相对路径', () => {
    const base = 'https://s.com/yun/1-1-1.html';
    assert.equal(toAbsoluteUrl('//cdn.com/a.m3u8', base), 'https://cdn.com/a.m3u8');
    assert.equal(toAbsoluteUrl('/play/x/index.m3u8', base), 'https://s.com/play/x/index.m3u8');
    assert.equal(toAbsoluteUrl('https://k.com/a.m3u8', base), 'https://k.com/a.m3u8');
  });
});
