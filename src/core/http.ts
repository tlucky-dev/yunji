/**
 * 基于 Node 原生 fetch 的 HTTP 封装：统一 UA、超时、重试与字符集解码。
 */
import { TextDecoder } from 'node:util';

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface HttpOptions {
  /** User-Agent（默认模拟 Chrome） */
  ua?: string;
  /** 单次请求超时毫秒数 */
  timeoutMs?: number;
  /** 失败重试次数（不含首次） */
  retries?: number;
  /** 额外请求头 */
  headers?: Record<string, string>;
  /** 外部取消信号（例如 Ctrl+C），触发后立即失败且不重试 */
  signal?: AbortSignal;
}

export interface HttpResult {
  status: number;
  /** 最终 URL（跟随重定向之后） */
  url: string;
  contentType?: string;
  bytes: Buffer;
}

export class HttpError extends Error {
  readonly status?: number;
  readonly url: string;

  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = 'HttpError';
    this.url = url;
    this.status = status;
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 判断某个错误是否值得重试（网络错误或 5xx/429） */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status !== undefined && RETRYABLE_STATUS.has(err.status);
  }
  // fetch 网络层错误（超时、连接中断等）
  return err instanceof Error && err.name !== 'AbortError';
}

/**
 * GET 请求并缓存完整响应体。带重试；非 2xx 抛 HttpError。
 * 注意 AbortError（调用方主动取消）不会被重试，直接抛出。
 */
export async function httpGet(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 2;
  const headers: Record<string, string> = {
    'user-agent': opts.ua ?? DEFAULT_UA,
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
    ...opts.headers,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(500 * attempt, 2000));
    }
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
      const res = await fetch(url, {
        headers,
        redirect: 'follow',
        signal,
      });
      if (!res.ok) {
        // 先读完 body 释放连接，再抛错
        await res.arrayBuffer().catch(() => undefined);
        throw new HttpError(`HTTP ${res.status}`, res.url || url, res.status);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      return {
        status: res.status,
        url: res.url || url,
        contentType: res.headers.get('content-type') ?? undefined,
        bytes,
      };
    } catch (err) {
      lastError = err;
      if (opts.signal?.aborted) {
        throw err; // 调用方主动取消，不重试
      }
      if (err instanceof Error && err.name === 'AbortError' && !(err instanceof HttpError)) {
        throw err; // 超时属于 AbortError；此处到达说明非外部取消场景，按普通错误处理
      }
      if (!isRetryableError(err) || attempt === retries) {
        break;
      }
    }
  }
  if (lastError instanceof HttpError) throw lastError;
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new HttpError(`请求失败：${msg}`, url);
}

/**
 * 按 HTTP 头或 HTML meta 标签推断的字符集解码文本。
 * 很多 MacCMS 站仍是 GBK 编码，仅靠 content-type 不够。
 */
export function decodeHtml(bytes: Buffer, contentType?: string): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (!charset) {
    // 在前 2KB 中嗅探 <meta charset> / content="...charset=..."
    const head = bytes.subarray(0, 2048).toString('latin1');
    charset =
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
      /charset=([\w-]+)/i.exec(head)?.[1];
  }
  const cs = (charset ?? 'utf-8').toLowerCase();
  const label = /^(gb2312|gbk)$/.test(cs) ? 'gb18030' : cs;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** GET 并解码为文本（自动处理字符集） */
export async function httpGetText(url: string, opts: HttpOptions = {}): Promise<string> {
  const res = await httpGet(url, opts);
  return decodeHtml(res.bytes, res.contentType);
}

/** GET 二进制内容（分片、密钥等） */
export async function httpGetBuffer(url: string, opts: HttpOptions = {}): Promise<Buffer> {
  const res = await httpGet(url, opts);
  return res.bytes;
}
