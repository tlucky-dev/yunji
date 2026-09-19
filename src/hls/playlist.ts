/**
 * HLS（m3u8）播放列表解析。
 * 支持：master/媒体两级列表、AES-128 密钥标签、IV（显式与按序号推导）、
 * EXT-X-MAP（fMP4 初始化段）、EXT-X-BYTERANGE（Range 下载）。
 */

export interface HlsKey {
  method: 'NONE' | 'AES-128';
  /** 已解析为绝对地址 */
  uri?: string;
  /** 标签中的显式 IV（十六进制字符串，形如 0x0000...） */
  iv?: string;
}

export interface ByteRange {
  length: number;
  offset: number;
}

export interface HlsMap {
  /** 已解析为绝对地址 */
  uri: string;
  key: HlsKey | null;
  byteRange?: ByteRange;
}

export interface HlsSegment {
  /** 已解析为绝对地址 */
  uri: string;
  duration: number;
  /** 分片的媒体序号（HLS 规范：IV 缺省时由此推导） */
  sequence: number;
  key: HlsKey | null;
  map: HlsMap | null;
  byteRange?: ByteRange;
}

export interface MediaPlaylist {
  kind: 'media';
  /** 实际媒体播放列表 URL（master 场景为 variant 地址） */
  playlistUrl: string;
  targetDuration: number;
  totalDuration: number;
  segments: HlsSegment[];
  initSegment: HlsMap | null;
  encryption: 'none' | 'aes-128' | 'other';
}

export interface VariantPlaylist {
  kind: 'master';
  playlistUrl: string;
  variants: { uri: string; bandwidth: number; resolution?: string }[];
}

export type Playlist = MediaPlaylist | VariantPlaylist;

/** 解析 HLS 属性列表（尊重引号内的逗号） */
function parseAttrs(input: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const key = m[1]!;
    let value = m[2] ?? '';
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    attrs.set(key, value);
  }
  return attrs;
}

function resolveUri(base: string, relative: string): string {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

function parseKey(line: string, playlistUrl: string): HlsKey {
  const attrs = parseAttrs(line.slice('#EXT-X-KEY:'.length));
  const method = (attrs.get('METHOD') ?? 'NONE').toUpperCase();
  if (method === 'NONE') {
    return { method: 'NONE' };
  }
  if (method !== 'AES-128') {
    return { method: 'NONE' };
  }
  const uri = attrs.get('URI');
  if (!uri) {
    throw new Error(`AES-128 密钥缺少 URI：${line}`);
  }
  return { method: 'AES-128', uri: resolveUri(playlistUrl, uri), iv: attrs.get('IV') };
}

/** 判断播放列表类型并解析 */
export function parsePlaylist(text: string, playlistUrl: string): Playlist {
  if (text.includes('#EXT-X-STREAM-INF')) {
    return parseMasterPlaylist(text, playlistUrl);
  }
  return parseMediaPlaylist(text, playlistUrl);
}

export function parseMasterPlaylist(text: string, playlistUrl: string): VariantPlaylist {
  const variants: VariantPlaylist['variants'] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
    // 变体地址是 STREAM-INF 之后的第一个非注释行
    let uri: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j]!.trim();
      if (candidate === '' || candidate.startsWith('#')) continue;
      uri = candidate;
      i = j;
      break;
    }
    if (!uri) continue;
    variants.push({
      uri: resolveUri(playlistUrl, uri),
      bandwidth: Number(attrs.get('BANDWIDTH') ?? 0),
      resolution: attrs.get('RESOLUTION'),
    });
  }
  if (variants.length === 0) {
    throw new Error(`master 播放列表中未找到任何变体：${playlistUrl}`);
  }
  return { kind: 'master', playlistUrl, variants };
}

export function parseMediaPlaylist(text: string, playlistUrl: string): MediaPlaylist {
  const segments: HlsSegment[] = [];
  const lines = text.split(/\r?\n/);
  let mediaSequence = 0;
  let targetDuration = 0;
  let currentKey: HlsKey | null = null;
  let currentMap: HlsMap | null = null;
  let initSegment: HlsMap | null = null;
  let pendingDuration: number | null = null;
  let pendingByteRange: { length: number; offset?: number } | null = null;
  let lastRangeEnd = 0;
  let sawAes128 = false;
  let sawOtherEncryption = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (!line.startsWith('#')) {
      // 非注释行：URI（配合挂起的 EXTINF / BYTERANGE）
      const uri = resolveUri(playlistUrl, line);
      let byteRange: ByteRange | undefined;
      if (pendingByteRange) {
        const offset = pendingByteRange.offset ?? lastRangeEnd;
        byteRange = { length: pendingByteRange.length, offset };
        lastRangeEnd = offset + pendingByteRange.length;
      }
      segments.push({
        uri,
        duration: pendingDuration ?? 0,
        sequence: mediaSequence + segments.length,
        key: currentKey,
        map: currentMap,
        byteRange,
      });
      pendingDuration = null;
      pendingByteRange = null;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number.parseFloat(line.slice('#EXTINF:'.length).replace(/,.*/, ''));
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number.parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number.parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length)) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const key = parseKey(line, playlistUrl);
      if (key.method === 'AES-128') sawAes128 = true;
      currentKey = key.method === 'NONE' ? null : key;
      continue;
    }
    if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      const key = parseKey(line, playlistUrl);
      if (key.method !== 'NONE') sawOtherEncryption = sawOtherEncryption || key.method !== 'AES-128';
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttrs(line.slice('#EXT-X-MAP:'.length));
      const uri = attrs.get('URI');
      if (!uri) continue;
      const key = attrs.get('KEYFORMAT') || attrs.get('METHOD') ? currentKey : currentKey;
      const map: HlsMap = { uri: resolveUri(playlistUrl, uri), key };
      currentMap = map;
      if (!initSegment) initSegment = map;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const m = /^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/.exec(line);
      if (m) {
        pendingByteRange = { length: Number(m[1]), offset: m[2] !== undefined ? Number(m[2]) : undefined };
      }
      continue;
    }
    // 其它标签（VERSION/PLAYLIST-TYPE/ENDLIST/DISCONTINUITY...）对 VOD 下载无影响
  }

  const encryption = sawAes128 ? 'aes-128' : 'none';
  return {
    kind: 'media',
    playlistUrl,
    targetDuration,
    totalDuration: segments.reduce((acc, s) => acc + (Number.isFinite(s.duration) ? s.duration : 0), 0),
    segments,
    initSegment,
    encryption: sawOtherEncryption && !sawAes128 ? 'other' : encryption,
  };
}

/** 按 quality 偏好挑选 master 中的变体 */
export function chooseVariant(playlist: VariantPlaylist, quality: 'highest' | 'first'): string {
  if (quality === 'first' || playlist.variants.length === 1) {
    return playlist.variants[0]!.uri;
  }
  let best = playlist.variants[0]!;
  for (const v of playlist.variants.slice(1)) {
    if (v.bandwidth > best.bandwidth) best = v;
  }
  return best.uri;
}

/**
 * 把任意 m3u8 地址解析为可直接下载的媒体播放列表。
 * getText 由调用方注入（带 UA/超时/重试的 httpGetText）。
 */
export async function resolveMediaPlaylist(
  getText: (url: string) => Promise<string>,
  m3u8Url: string,
  quality: 'highest' | 'first',
): Promise<MediaPlaylist> {
  const first = parsePlaylist(await getText(m3u8Url), m3u8Url);
  if (first.kind === 'media') return first;
  const variantUri = chooseVariant(first, quality);
  const second = parsePlaylist(await getText(variantUri), variantUri);
  if (second.kind === 'media') return second;
  throw new Error(`master 播放列表嵌套过深（两层仍是 master）：${m3u8Url}`);
}
