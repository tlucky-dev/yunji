import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { MultiEpisodeProgressRenderer, type ErrWriter } from '../src/cli/ui.js';

/** 收集渲染输出的假终端 */
function makeWriter(): { chunks: string[]; write: ErrWriter; text(): string; since(n: number): string } {
  const chunks: string[] = [];
  return {
    chunks,
    write: (s: string) => chunks.push(s),
    text: () => chunks.join(''),
    since: (n: number) => chunks.join('').slice(n),
  };
}

describe('分集进度块渲染协议（TTY）', () => {
  it('begin 后整块一次渲染，含全部行', () => {
    const w = makeWriter();
    const r = new MultiEpisodeProgressRenderer({ write: w.write, tty: true });
    r.begin(1, '第01集', 100);
    assert.ok(w.text().includes('第01集'));
    const before = w.text().length;
    r.begin(2, '第02集', 100);
    const added = w.since(before);
    // 第二次渲染是整块重画：两行都在
    assert.ok(added.includes('第01集') && added.includes('第02集'));
  });

  it('remove 只擦不画：整块清到屏幕底、光标落块首，日志行不会被覆盖或留空行', () => {
    const w = makeWriter();
    const r = new MultiEpisodeProgressRenderer({ write: w.write, tty: true });
    r.begin(1, '第01集', 100);
    r.begin(2, '第02集', 100);
    r.update(2, { done: 50, total: 100, bytes: 1024 });
    const before = w.text().length;

    r.remove(1);
    const erased = w.since(before);
    const esc = String.fromCharCode(27);
    assert.ok(erased.includes(esc + '[J'), 'remove 应整块清到屏幕末尾');
    assert.ok(!erased.includes('第02集'), 'remove 不得重画剩余行（v1.3.2 回归）');
    assert.equal(erased.replace(/[^\n]/g, ''), '', '擦除阶段不得夹带换行（否则留下空行）');

    // 模拟 CLI 在擦净位置打印完成日志
    w.write('✓ 第01集 → x.mp4\n');
    const logPos = w.text().length;

    r.draw();
    const redrawn = w.since(logPos);
    assert.ok(redrawn.includes('第02集'), 'draw 应恢复剩余行');
    // draw 时块已清空（#rows=0），不得上移光标——上移就会覆盖刚打的日志行
    const moveUp = new RegExp(esc + String.raw`\[\d+A`);
    assert.ok(!moveUp.test(redrawn), 'draw 不得移动光标覆盖日志行');
  });

  it('update 完成帧立即渲染，未完成按 100ms 节流', () => {
    const w = makeWriter();
    const r = new MultiEpisodeProgressRenderer({ write: w.write, tty: true });
    r.begin(1, '第01集', 100);
    const n = w.text().length;
    r.update(1, { done: 1, total: 100, bytes: 10 });
    assert.equal(w.text().length, n, '未完成且未到节流间隔不应渲染');
    r.update(1, { done: 100, total: 100, bytes: 1000 });
    assert.ok(w.since(n).includes('100/100'), '完成帧应立即渲染');
  });

  it('finish 后不再输出', () => {
    const w = makeWriter();
    const r = new MultiEpisodeProgressRenderer({ write: w.write, tty: true });
    r.begin(1, '第01集', 100);
    r.finish();
    const n = w.text().length;
    r.update(1, { done: 99, total: 100, bytes: 10 });
    r.draw();
    assert.equal(w.text().length, n);
  });

  it('非 TTY 退化为周期性单行日志', () => {
    const w = makeWriter();
    const r = new MultiEpisodeProgressRenderer({ write: w.write, tty: false });
    r.begin(1, '第01集', 100);
    assert.ok(w.text().includes('开始下载'));
    r.update(1, { done: 100, total: 100, bytes: 1000 });
    assert.ok(w.text().includes('100/100'));
  });
});
