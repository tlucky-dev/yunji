/**
 * 配置：默认值 < yunji.config.json < 命令行参数，三级覆盖。
 * 配置文件在执行命令时的工作目录下查找。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_UA } from './core/http.js';

export interface YunjiConfig {
  /** 输出根目录 */
  outputDir: string;
  /** 单集内分片下载并发数 */
  concurrency: number;
  /** 播放页解析并发数 */
  pageConcurrency: number;
  /** 单次 HTTP 超时（毫秒） */
  timeoutMs: number;
  /** HTTP 重试次数 */
  retries: number;
  /** master playlist 码率选择：最高或第一个 */
  quality: 'highest' | 'first';
  /** 是否用 ffmpeg 转封装为 mp4（false 或 ffmpeg 缺失时输出 ts） */
  remux: boolean;
  /** ffmpeg 可执行文件路径 */
  ffmpegPath: string;
  /** 请求 UA */
  ua: string;
}

export const DEFAULT_CONFIG: YunjiConfig = {
  outputDir: path.join(process.cwd(), 'downloads'),
  concurrency: 8,
  pageConcurrency: 4,
  timeoutMs: 30_000,
  retries: 2,
  quality: 'highest',
  remux: true,
  ffmpegPath: 'ffmpeg',
  ua: DEFAULT_UA,
};

const CONFIG_FILE_NAME = 'yunji.config.json';

/** 读取工作目录下的 yunji.config.json（不存在返回空对象） */
function readConfigFile(cwd: string): Partial<YunjiConfig> {
  const file = path.join(cwd, CONFIG_FILE_NAME);
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // 忽略未知键与错误类型，保证配置文件写错也不至于崩溃
    const known = Object.keys(DEFAULT_CONFIG) as (keyof YunjiConfig)[];
    const result: Record<string, unknown> = {};
    for (const key of known) {
      const value = parsed[key];
      if (value !== undefined && typeof value === typeof DEFAULT_CONFIG[key]) {
        result[key] = value;
      }
    }
    return result as Partial<YunjiConfig>;
  } catch {
    return {};
  }
}

/** 从文件加载配置并与默认值合并 */
export function loadConfig(cwd: string = process.cwd()): YunjiConfig {
  return { ...DEFAULT_CONFIG, ...readConfigFile(cwd) };
}

/** CLI 提供的可覆盖项 */
export interface CliOverrides {
  outputDir?: string;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  quality?: 'highest' | 'first';
  keepTs?: boolean;
  ffmpegPath?: string;
  ua?: string;
}

/** 应用命令行参数覆盖 */
export function applyCliOverrides(config: YunjiConfig, overrides: CliOverrides): YunjiConfig {
  return {
    ...config,
    ...(overrides.outputDir !== undefined && { outputDir: path.resolve(overrides.outputDir) }),
    ...(overrides.concurrency !== undefined && { concurrency: overrides.concurrency }),
    ...(overrides.timeoutMs !== undefined && { timeoutMs: overrides.timeoutMs }),
    ...(overrides.retries !== undefined && { retries: overrides.retries }),
    ...(overrides.quality !== undefined && { quality: overrides.quality }),
    ...(overrides.keepTs !== undefined && { remux: !overrides.keepTs }),
    ...(overrides.ffmpegPath !== undefined && { ffmpegPath: overrides.ffmpegPath }),
    ...(overrides.ua !== undefined && { ua: overrides.ua }),
  };
}
