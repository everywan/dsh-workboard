// 顶栏「保持唤醒」：macOS 用 caffeinate -i 阻止系统空闲休眠。
// 子进程绑定 Host 的 pid（-w），App 退出或被强杀时 caffeinate 会自动结束，不留孤儿进程。
import {platform} from 'node:os';

export function createPower({spawn, os = platform()} = {}) {
  let child = null;
  const alive = () => Boolean(child) && child.exitCode === null && child.signalCode === null;
  const stop = () => {
    const current = child;
    child = null;
    if (!current) return;
    try { current.kill('SIGTERM'); } catch { /* 已经退出 */ }
  };
  const start = () => {
    if (os !== 'darwin') throw new Error('keep-awake is only available on macOS');
    if (alive()) return;
    const proc = spawn('caffeinate', ['-i', '-w', String(process.pid)], {stdio: 'ignore'});
    proc.on('error', () => { if (child === proc) child = null; });
    proc.on('exit', () => { if (child === proc) child = null; });
    child = proc;
  };
  return {
    state: () => alive(),
    set(on) { if (on) start(); else stop(); return alive(); },
    dispose: stop,
  };
}
