/**
 * HLS 分片解密：AES-128-CBC。
 * 密钥按 URI 缓存；IV 优先取标签显式值，缺省按 HLS 规范用分片媒体序号推导。
 */
import { createDecipheriv } from 'node:crypto';
import type { HlsKey, HlsMap } from './playlist.js';

export type FetchBuffer = (url: string) => Promise<Buffer>;

/** 密钥获取器：同一密钥地址只请求一次 */
export class KeyFetcher {
  readonly #cache = new Map<string, Buffer>();
  readonly #fetch: FetchBuffer;

  constructor(fetchBuffer: FetchBuffer) {
    this.#fetch = fetchBuffer;
  }

  async getKey(uri: string): Promise<Buffer> {
    const cached = this.#cache.get(uri);
    if (cached) return cached;
    const key = await this.#fetch(uri);
    if (key.length !== 16) {
      throw new Error(`AES-128 密钥长度异常（${key.length} 字节，应为 16）：${uri}`);
    }
    this.#cache.set(uri, key);
    return key;
  }
}

/** HLS 规范：IV 缺省时取分片媒体序号的 16 字节大端表示 */
export function deriveIvFromSequence(sequence: number): Buffer {
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(sequence), 8);
  return iv;
}

/** 解析标签中的显式 IV（0x 前缀十六进制） */
export function parseExplicitIv(ivHex: string): Buffer {
  const hex = ivHex.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`无法解析 IV：${ivHex}`);
  }
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length !== 16) {
    throw new Error(`IV 长度异常（${bytes.length} 字节，应为 16）：${ivHex}`);
  }
  return bytes;
}

/** 计算某个分片使用的 IV */
export function ivForKey(key: HlsKey, sequence: number): Buffer {
  return key.iv ? parseExplicitIv(key.iv) : deriveIvFromSequence(sequence);
}

/** 去除 PKCS7 填充；填充不合法时原样返回（部分站点的流不符合规范） */
function stripPkcs7(data: Buffer): Buffer {
  if (data.length === 0) return data;
  const pad = data[data.length - 1]!;
  if (pad < 1 || pad > 16 || pad > data.length) return data;
  for (let i = data.length - pad; i < data.length; i++) {
    if (data[i] !== pad) return data;
  }
  return data.subarray(0, data.length - pad);
}

/** 解密单个分片；key 为空（METHOD=NONE）时原样返回 */
export async function decryptSegment(
  data: Buffer,
  key: HlsKey | null,
  sequence: number,
  keyFetcher: KeyFetcher,
): Promise<Buffer> {
  if (!key || key.method === 'NONE') return data;
  if (key.method !== 'AES-128') {
    throw new Error(`不支持的加密方式：${key.method}`);
  }
  const keyBytes = await keyFetcher.getKey(key.uri!);
  const iv = ivForKey(key, sequence);
  try {
    const decipher = createDecipheriv('aes-128-cbc', keyBytes, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    // 填充不合规的流：关闭自动去填充，手动按 PKCS7 尝试
    const decipher = createDecipheriv('aes-128-cbc', keyBytes, iv);
    decipher.setAutoPadding(false);
    const raw = Buffer.concat([decipher.update(data), decipher.final()]);
    return stripPkcs7(raw);
  }
}

/** 解密 EXT-X-MAP 初始化段（无独立序号，IV 用 0 推导序号 0 或显式值） */
export async function decryptInitSegment(
  data: Buffer,
  map: HlsMap,
  keyFetcher: KeyFetcher,
): Promise<Buffer> {
  if (!map.key || map.key.method === 'NONE') return data;
  return decryptSegment(data, map.key, 0, keyFetcher);
}
