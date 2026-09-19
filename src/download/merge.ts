/**
 * 合并与转封装：分片合并为 ts，再用 ffmpeg 无重编码转封装为 mp4。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

let ffmpegProbe: Promise<string | null> | null = null;

/** 探测 ffmpeg 可执行文件：优先用配置路径，其次 PATH；结果缓存 */
export function findFfmpeg(configuredPath: string): Promise<string | null> {
  if (!ffmpegProbe) {
    ffmpegProbe = (async () => {
      const candidates =
        configuredPath && configuredPath !== 'ffmpeg'
          ? [configuredPath]
          : [process.env.FFMPEG_PATH ?? '', 'ffmpeg'].filter(Boolean);
      for (const candidate of candidates) {
        if (await canRun(candidate)) return candidate;
      }
      return null;
    })();
  }
  return ffmpegProbe;
}

async function canRun(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ['-version'], { stdio: 'ignore', shell: false });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/** 用 ffmpeg 将 ts 转封装为 mp4（-c copy，不重新编码）；超时强制终止，防止子进程异常挂起拖死 worker */
export async function remuxToMp4(
  tsPath: string,
  mp4Path: string,
  ffmpegPath: string,
): Promise<void> {
  const args = [
    '-y',
    '-i',
    tsPath,
    '-c',
    'copy',
    '-bsf:a',
    'aac_adtstoasc',
    '-movflags',
    '+faststart',
    mp4Path,
  ];
  const TIMEOUT_MS = 15 * 60_000;
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(ffmpegPath, args, { shell: false });
    let stderr = '';
    let settled = false;
    const finish = (r: { code: number | null; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: -1, stderr: `${stderr}\nffmpeg 超过 15 分钟未完成，已强制终止` });
    }, TIMEOUT_MS);
    child.stderr?.on('data', (chunk: Buffer) => {
      // 只保留尾部，避免超长日志
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', (err) => finish({ code: null, stderr: String(err) }));
    child.on('exit', (code) => finish({ code, stderr }));
  });
  if (result.code !== 0) {
    throw new Error(`ffmpeg 转封装失败（exit=${result.code}）：\n${result.stderr.trim()}`);
  }
}

/** 确保输出 mp4 生成：成功后删除中间 ts */
export async function finalizeOutput(
  tsPath: string,
  mp4Path: string,
  ffmpegPath: string,
): Promise<void> {
  await remuxToMp4(tsPath, mp4Path, ffmpegPath);
  await fs.rm(tsPath, { force: true });
}

/** 删除分片目录 */
export async function cleanupParts(partsDir: string): Promise<void> {
  await fs.rm(partsDir, { recursive: true, force: true });
}

/** 输出文件路径 */
export function outputPath(seriesDir: string, fileTitle: string, ext: string): string {
  return path.join(seriesDir, `${fileTitle}.${ext}`);
}
