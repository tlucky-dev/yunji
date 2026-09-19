/**
 * 输出文件/目录名处理：Windows 非法字符清洗、集数命名、选集表达式解析。
 */
import * as path from 'node:path';

/** Windows 文件名中禁止的字符与控制字符 */
// eslint-disable-next-line no-control-regex -- 控制字符正是要清洗的对象
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * 清洗为合法的 Windows/跨平台文件（目录）名。
 * 非法字符替换为 “_”，去掉结尾的空白与点，限制长度。
 */
export function sanitizeName(name: string, maxLength = 100): string {
  const cleaned = name
    .replace(ILLEGAL_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!cleaned) return 'unnamed';
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trimEnd() : cleaned;
}

/** 两位补零的集号，如 01、36 */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 计算各集的输出文件名（不含扩展名），保证同一部剧内唯一。
 * 页面集名可能重复（例如站点把两集都标成“第09集”）：
 * 第一遍对重复集名回退为 nid 命名；第二遍对仍冲突的名字改用 nid 命名，
 * 若 nid 命名也被占用则追加序号。
 */
export function assignEpisodeFileTitles(
  seriesTitle: string,
  episodes: { nid: number; label: string }[],
): string[] {
  const sanitizedSeries = sanitizeName(seriesTitle);
  const labelCount = new Map<string, number>();
  for (const ep of episodes) {
    const key = ep.label.trim();
    labelCount.set(key, (labelCount.get(key) ?? 0) + 1);
  }
  const used = new Set<string>();
  const build = (fileTitle: string): string => sanitizeName(`${sanitizedSeries}-${fileTitle}`);

  return episodes.map((ep) => {
    const label = ep.label.trim();
    const duplicated = (labelCount.get(label) ?? 0) > 1;
    let name = duplicated ? build(`第${pad2(ep.nid)}集`) : build(label);
    if (used.has(name)) {
      name = build(`第${pad2(ep.nid)}集`);
      if (used.has(name)) {
        let suffix = 2;
        while (used.has(`${name}(${suffix})`)) suffix++;
        name = `${name}(${suffix})`;
      }
    }
    used.add(name);
    return name;
  });
}

/**
 * 解析选集表达式，如 “1”、“1-8,12,15-”、“3”。
 * 支持开区间 “15-” 表示 15 到最后。返回谓词函数与表达式描述。
 */
export function parseEpisodeSpec(
  spec: string,
): { matches(nid: number): boolean; description: string } {
  const parts = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { matches: () => true, description: '全部' };
  }
  const ranges: { min: number; max: number | null }[] = [];
  for (const part of parts) {
    const m = /^(\d+)(?:\s*-\s*(\d+)?)?$/.exec(part);
    if (!m) {
      throw new Error(`无法理解选集表达式片段：“${part}”（示例：1-8,12）`);
    }
    const min = Number(m[1]);
    const max = m[2] === undefined && part.includes('-') ? null : (m[2] !== undefined ? Number(m[2]) : min);
    ranges.push({ min, max });
  }
  return {
    matches(nid: number) {
      return ranges.some(({ min, max }) => nid >= min && (max === null || nid <= max));
    },
    description: spec,
  };
}

/** 拼接输出路径（输出根目录/剧名/文件名） */
export function episodeOutputPath(seriesDir: string, fileTitle: string, ext: string): string {
  return path.join(seriesDir, `${fileTitle}.${ext}`);
}
