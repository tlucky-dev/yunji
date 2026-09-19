import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { downloadSegments } from '../src/hls/downloader.js';
import type { MediaPlaylist } from '../src/hls/playlist.js';

/** 起一个本地 HTTP 服务器，返回 (handler 决定是否响应)；用完必须 close */
async function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ origin: string; close(): void }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makePlaylist(origin: string, count: number): MediaPlaylist {
  return {
    kind: 'media',
    playlistUrl: `${origin}/index.m3u8`,
    targetDuration: 8,
    totalDuration: count * 8,
    segments: Array.from({ length: count }, (_, i) => ({
      uri: `${origin}/seg${i}.ts`,
      duration: 8,
      sequence: i,
      key: null,
      map: null,
    })),
    initSegment: null,
    encryption: 'none',
  };
}

function makePartsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yunji-stall-test-'));
}

describe('分片池停滞看门狗', () => {
  it('服务器接受连接但不响应时，看门狗中止并报「下载停滞」', async () => {
    const server = await listen(() => {
      /* 永不响应，socket 保持打开 */
    });
    try {
      const partsDir = makePartsDir();
      const start = Date.now();
      await assert.rejects(
        downloadSegments({
          playlist: makePlaylist(server.origin, 4),
          partsDir,
          concurrency: 2,
          timeoutMs: 60_000, // 单请求超时故意远大于停滞阈值，确保是看门狗起作用
          retries: 0,
          ua: 'test',
          stallTimeoutMs: 800,
        }),
        /下载停滞/,
      );
      assert.ok(Date.now() - start < 10_000, '应在停滞阈值附近快速失败');
      fs.rmSync(partsDir, { recursive: true, force: true });
    } finally {
      await server.close();
    }
  });

  it('正常服务器不受看门狗影响，全部分片完成', async () => {
    const server = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.end(Buffer.alloc(188, 0x47)); // 一个全同步字节的 MPEG-TS 包
    });
    try {
      const partsDir = makePartsDir();
      const result = await downloadSegments({
        playlist: makePlaylist(server.origin, 6),
        partsDir,
        concurrency: 3,
        timeoutMs: 5_000,
        retries: 0,
        ua: 'test',
        stallTimeoutMs: 2_000,
      });
      assert.equal(result.total, 6);
      assert.equal(result.skipped, 0);
      assert.equal(result.partFiles.length, 6);
      for (const f of result.partFiles) {
        assert.ok(fs.statSync(f).size > 0, `${f} 应非空`);
      }
      fs.rmSync(partsDir, { recursive: true, force: true });
    } finally {
      await server.close();
    }
  });
});
