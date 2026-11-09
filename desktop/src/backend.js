'use strict';
/**
 * 后端进程管理：拉起本机 Python 服务，日志落盘，退出时整树清理。
 *
 * 开发态：使用仓库内 .venv 的 python.exe
 * 安装态：使用 resources/python/python.exe（打包进安装包的便携运行时）
 */
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

class Backend extends EventEmitter {
  constructor({ port, projectDir, dataDir, isPackaged }) {
    super();
    this.port = port;
    this.projectDir = projectDir;
    this.dataDir = dataDir;
    this.isPackaged = isPackaged;
    this.proc = null;
    this.exited = false;
    this.lastError = '';
    this.logFile = null;
    this.stopping = false;

    if (isPackaged) {
      const res = process.resourcesPath;
      this.python = path.join(res, 'python', 'python.exe');
      this.server = path.join(res, 'app-python', 'backend', 'server.py');
      this.cwd = path.join(res, 'app-python', 'backend');
      this.webDir = path.join(res, 'renderer');
    } else {
      this.python = path.join(projectDir, '.venv', 'Scripts', 'python.exe');
      this.server = path.join(projectDir, 'backend', 'server.py');
      this.cwd = path.join(projectDir, 'backend');
      this.webDir = path.join(projectDir, 'desktop', 'renderer');
    }
  }

  _write(line) {
    this.emit('log', line);
    if (!this.logFile) return;
    try {
      fs.appendFileSync(this.logFile, line + '\n', 'utf8');
    } catch {
      /* 日志写失败不影响主流程 */
    }
  }

  start() {
    if (!fs.existsSync(this.python)) {
      throw new Error(
        `找不到 Python 运行时：${this.python}\n` +
          (this.isPackaged
            ? '安装包可能不完整，请重新安装。'
            : '请先在项目根目录创建虚拟环境：python -m venv .venv && .venv\\Scripts\\pip install -r requirements.txt')
      );
    }
    if (!fs.existsSync(this.server)) {
      throw new Error(`找不到后端入口：${this.server}`);
    }

    const logsDir = path.join(this.dataDir, 'logs');
    const tmpDir = path.join(this.dataDir, 'tmp');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    this.logFile = path.join(logsDir, 'backend.log');
    this._write(`===== ${new Date().toLocaleString('zh-CN')} 启动后端 port=${this.port} =====`);

    const env = { ...process.env };
    delete env.PYTHONHOME;
    delete env.PYTHONPATH;
    delete env.PYTHONSTARTUP;

    Object.assign(env, {
      JOBMATCH_PORT: String(this.port),
      JOBMATCH_HOST: '127.0.0.1',
      JOBMATCH_DATA_DIR: this.dataDir,
      JOBMATCH_WEB_DIR: this.webDir,
      JOBMATCH_LOG_LEVEL: 'info',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      TMP: tmpDir,
      TEMP: tmpDir,
    });

    this.proc = spawn(this.python, [this.server], {
      cwd: this.cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      String(d).split(/\r?\n/).filter(Boolean).forEach((l) => this._write(l));
    });
    this.proc.stderr.on('data', (d) => {
      String(d).split(/\r?\n/).filter(Boolean).forEach((l) => {
        this.lastError = l;
        this._write(l);
      });
    });

    this.proc.on('error', (err) => {
      this.exited = true;
      this.lastError = err.message;
      this._write(`[spawn error] ${err.message}`);
      this.emit('exit', { code: null, error: err.message });
    });

    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      this._write(`[后端退出] code=${code} signal=${signal}`);
      if (!this.stopping) {
        this.emit('exit', { code, signal });
      }
    });

    return this.proc;
  }

  stop() {
    this.stopping = true;
    if (!this.proc || this.proc.exitCode !== null) return;
    const pid = this.proc.pid;
    try {
      if (process.platform === 'win32') {
        // 带上超时：taskkill 万一卡住会阻塞主线程，连带把退出流程一起卡死，
        // 单实例锁也就释放不掉，用户之后每次双击都没反应。
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 3000 });
      } else {
        this.proc.kill('SIGTERM');
      }
    } catch (e) {
      this._write(`[清理失败] ${e.message}`);
    }
    this.proc = null;
  }
}

module.exports = { Backend };
