import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  chooseVariant,
  parseMediaPlaylist,
  parsePlaylist,
  resolveMediaPlaylist,
} from '../src/hls/playlist.js';

const FLAT_AES = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x00000000000000000000000000000000
#EXTINF:5.166667,
https://cdn.example.com/hls/766/plist0.ts
#EXTINF:10.416667,
plist1.ts
#EXT-X-ENDLIST
`;

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=128,RESOLUTION=1280x720
2000k_1080/hls/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=512,RESOLUTION=1920x1080
4000k/hls/index.m3u8
`;

const WITH_MAP_AND_RANGE = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k1"
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000@2000
seg0.mp4
#EXTINF:4.0,
#EXT-X-BYTERANGE:1500
seg1.mp4
`;

describe('playlist 解析', () => {
  it('解析平铺 AES-128 媒体播放列表（红牛源形态）', () => {
    const url = 'https://hn.example.com/play/AbCdEf/index.m3u8';
    const parsed = parsePlaylist(FLAT_AES, url);
    assert.equal(parsed.kind, 'media');
    if (parsed.kind !== 'media') return;
    assert.equal(parsed.encryption, 'aes-128');
    assert.equal(parsed.segments.length, 2);
    const [s0, s1] = parsed.segments;
    assert.equal(s0!.sequence, 0);
    assert.equal(s0!.key?.method, 'AES-128');
    // 相对密钥地址按播放列表地址解析
    assert.equal(s0!.key?.uri, 'https://hn.example.com/play/AbCdEf/enc.key');
    // 显式 IV 原样保留
    assert.equal(s0!.key?.iv, '0x00000000000000000000000000000000');
    // 绝对地址分片保持不变
    assert.equal(s0!.uri, 'https://cdn.example.com/hls/766/plist0.ts');
    // 相对地址分片解析
    assert.equal(s1!.uri, 'https://hn.example.com/play/AbCdEf/plist1.ts');
    assert.ok(Math.abs(parsed.totalDuration - 15.583334) < 1e-3);
  });

  it('解析 master 播放列表并按最高码率选变体', () => {
    const url = 'https://v4.example.com/202308/26/x/video/index.m3u8';
    const parsed = parsePlaylist(MASTER, url);
    assert.equal(parsed.kind, 'master');
    if (parsed.kind !== 'master') return;
    assert.equal(parsed.variants.length, 2);
    assert.equal(chooseVariant(parsed, 'highest'), 'https://v4.example.com/202308/26/x/video/4000k/hls/index.m3u8');
    assert.equal(chooseVariant(parsed, 'first'), 'https://v4.example.com/202308/26/x/video/2000k_1080/hls/index.m3u8');
  });

  it('解析 EXT-X-MAP 与 BYTERANGE（fMP4 形态）', () => {
    const url = 'https://cdn.example.com/video/index.m3u8';
    const parsed = parseMediaPlaylist(WITH_MAP_AND_RANGE, url);
    assert.equal(parsed.initSegment?.uri, 'https://cdn.example.com/video/init.mp4');
    const [s0, s1] = parsed.segments;
    assert.equal(s0!.sequence, 5);
    assert.equal(s0!.byteRange?.length, 1000);
    assert.equal(s0!.byteRange?.offset, 2000);
    // 省略 @offset 时延续上一段的末尾
    assert.equal(s1!.byteRange?.offset, 3000);
    assert.equal(s1!.byteRange?.length, 1500);
    // 无显式 IV 的密钥：序号推导（在 decrypt 测试中验证推导值）
    assert.equal(s0!.key?.method, 'AES-128');
    assert.equal(s0!.key?.iv, undefined);
  });

  it('resolveMediaPlaylist 自动下钻 master → media', async () => {
    const masterUrl = 'https://v.example.com/master.m3u8';
    const mediaUrl = 'https://v.example.com/4000k/hls/index.m3u8';
    const mediaText = `#EXTM3U\n#EXTINF:2.0,\nseg0.ts\n`;
    const getText = async (url: string) => {
      assert.ok(url === masterUrl || url === mediaUrl);
      return url === masterUrl ? MASTER : mediaText;
    };
    const media = await resolveMediaPlaylist(getText, masterUrl, 'highest');
    assert.equal(media.kind, 'media');
    assert.equal(media.playlistUrl, mediaUrl);
    assert.equal(media.segments[0]!.uri, 'https://v.example.com/4000k/hls/seg0.ts');
  });
});
