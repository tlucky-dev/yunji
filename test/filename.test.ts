import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  assignEpisodeFileTitles,
  parseEpisodeSpec,
  sanitizeName,
} from '../src/util/filename.js';

describe('文件名处理', () => {
  it('sanitizeName 清洗 Windows 非法字符', () => {
    assert.equal(sanitizeName('赘婿: 第01集(上)/高清'), '赘婿_ 第01集(上)_高清');
    assert.equal(sanitizeName('abc?.mp4'), 'abc_.mp4');
    assert.equal(sanitizeName('以点结尾...'), '以点结尾');
    assert.equal(sanitizeName(''), 'unnamed');
    assert.equal(sanitizeName('  '), 'unnamed');
  });

  it('parseEpisodeSpec 解析范围与列表', () => {
    const spec = parseEpisodeSpec('1-3,5,9-');
    assert.ok(spec.matches(1) && spec.matches(3) && spec.matches(5));
    assert.ok(spec.matches(9) && spec.matches(100));
    assert.ok(!spec.matches(4) && !spec.matches(8));
    assert.throws(() => parseEpisodeSpec('abc'), /选集表达式/);
    const all = parseEpisodeSpec('');
    assert.ok(all.matches(1) && all.matches(999));
  });

  it('assignEpisodeFileTitles 对重复集名回退为 nid 命名，且全程唯一', () => {
    // 真实案例：站点源3的 nid 9、10 都标成“第09集”
    const titles = assignEpisodeFileTitles('赘婿', [
      { nid: 9, label: '第09集' },
      { nid: 10, label: '第09集' },
      { nid: 11, label: '第10集' },
    ]);
    // nid9、nid10 因集名重复回退为 nid 命名；
    // nid11 的“第10集”与回退后的 nid10 相撞，再回退为自身 nid 命名
    assert.deepEqual(titles, ['赘婿-第09集', '赘婿-第10集', '赘婿-第11集']);
    assert.equal(new Set(titles).size, titles.length);
  });

  it('assignEpisodeFileTitles 常规命名保持页面集名', () => {
    const titles = assignEpisodeFileTitles('赘婿', [
      { nid: 1, label: '第01集' },
      { nid: 2, label: '第02集' },
    ]);
    assert.deepEqual(titles, ['赘婿-第01集', '赘婿-第02集']);
  });
});
