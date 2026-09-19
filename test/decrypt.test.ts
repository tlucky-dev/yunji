import { strict as assert } from 'node:assert';
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  KeyFetcher,
  decryptSegment,
  deriveIvFromSequence,
  ivForKey,
} from '../src/hls/decrypt.js';
import type { HlsKey } from '../src/hls/playlist.js';

/** 用同样规则加密，构造解密测试的输入 */
function encrypt(plain: Buffer, key: Buffer, iv: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

describe('decrypt', () => {
  const keyBytes = randomBytes(16);
  const plain = Buffer.concat([randomBytes(1024), Buffer.from('tail-padding-block-data-16')]);

  it('显式 IV 解密（红牛源 IV=0 形态）', async () => {
    const key: HlsKey = { method: 'AES-128', uri: 'https://a.com/enc.key', iv: '0x' + '00'.repeat(16) };
    const iv = Buffer.alloc(16);
    const data = encrypt(plain, keyBytes, iv);
    const fetcher = new KeyFetcher(async () => keyBytes);
    const decrypted = await decryptSegment(data, key, 3, fetcher);
    assert.ok(decrypted.equals(plain));
  });

  it('无显式 IV 时按媒体序号推导 IV（HLS 规范）', async () => {
    const key: HlsKey = { method: 'AES-128', uri: 'https://a.com/k', };
    const sequence = 7;
    const data = encrypt(plain, keyBytes, deriveIvFromSequence(sequence));
    const fetcher = new KeyFetcher(async () => keyBytes);
    const decrypted = await decryptSegment(data, key, sequence, fetcher);
    assert.ok(decrypted.equals(plain));
    // 推导值应为 16 字节大端：前 8 字节为 0
    const derived = ivForKey(key, sequence);
    assert.equal(derived.length, 16);
    assert.ok(derived.subarray(0, 8).every((b) => b === 0));
    assert.equal(derived.readBigUInt64BE(8), 7n);
  });

  it('密钥按 URI 缓存，只请求一次', async () => {
    let fetchCount = 0;
    const fetcher = new KeyFetcher(async () => {
      fetchCount++;
      return keyBytes;
    });
    const k: HlsKey = { method: 'AES-128', uri: 'u1' };
    const data = encrypt(plain, keyBytes, Buffer.alloc(16));
    await decryptSegment(data, k, 0, fetcher);
    await decryptSegment(data, k, 1, fetcher);
    assert.equal(fetchCount, 1);
  });

  it('METHOD=NONE 原样返回；密钥长度异常时报错', async () => {
    const fetcher = new KeyFetcher(async () => Buffer.alloc(8));
    assert.ok((await decryptSegment(plain, null, 0, fetcher)).equals(plain));
    const bad: HlsKey = { method: 'AES-128', uri: 'u2' };
    await assert.rejects(() => decryptSegment(plain, bad, 0, fetcher), /密钥长度异常/);
  });
});
