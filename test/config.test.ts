import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig, userConfigDir } from '../src/config.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yunji-config-test-'));
}

describe('配置加载', () => {
  it('优先级：默认值 < 用户级配置 < 工作目录配置', () => {
    const tmp = makeTempDir();
    const userDir = path.join(tmp, 'user');
    const cwd = path.join(tmp, 'proj');
    fs.mkdirSync(userDir);
    fs.mkdirSync(cwd);
    fs.writeFileSync(
      path.join(userDir, 'config.json'),
      JSON.stringify({ episodeConcurrency: 3, concurrency: 12 }),
    );
    fs.writeFileSync(
      path.join(cwd, 'yunji.config.json'),
      JSON.stringify({ concurrency: 16, remux: false }),
    );
    const cfg = loadConfig(cwd, userDir);
    assert.equal(cfg.episodeConcurrency, 3); // 来自用户级
    assert.equal(cfg.concurrency, 16); // 工作目录覆盖用户级
    assert.equal(cfg.remux, false);
    assert.equal(cfg.timeoutMs, 30_000); // 未配置的取默认值
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('配置文件不存在或非法 JSON 时回退默认值', () => {
    const tmp = makeTempDir();
    fs.writeFileSync(path.join(tmp, 'yunji.config.json'), '{oops');
    const cfg = loadConfig(tmp, path.join(tmp, 'not-exist'));
    assert.equal(cfg.concurrency, 8);
    assert.equal(cfg.episodeConcurrency, 1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('未知键与错误类型被忽略', () => {
    const tmp = makeTempDir();
    fs.writeFileSync(
      path.join(tmp, 'yunji.config.json'),
      JSON.stringify({ foo: 1, retries: 'many', timeoutMs: 5000 }),
    );
    const cfg = loadConfig(tmp, path.join(tmp, 'not-exist'));
    assert.equal(cfg.timeoutMs, 5000);
    assert.equal(cfg.retries, 2); // 类型错误，忽略
    assert.ok(!('foo' in cfg));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('userConfigDir 指向 yunji 子目录', () => {
    assert.equal(path.basename(userConfigDir()), 'yunji');
  });
});
