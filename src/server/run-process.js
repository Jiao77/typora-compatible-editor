import { spawn } from 'node:child_process';

// 统一的子进程执行封装：收集标准输出、标准错误并实施超时终止保护
export function runProcess(command, args, { input, timeoutMs, timeoutMessage } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;
    let stdinError = null;
    let terminationTimer = null;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminationTimer) clearTimeout(terminationTimer);
      callback();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      terminationTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 2_000);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.stdin.on('error', (error) => {
      stdinError = error;
    });
    child.on('error', (error) => {
      finish(() => reject(new Error(`无法启动命令 ${command}：${error.message}`)));
    });
    child.on('close', (code, signal) => {
      const result = {
        code: code === null ? -1 : code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdinError: stdinError ? stdinError.message : ''
      };
      finish(() => {
        if (timedOut) reject(new Error(`${timeoutMessage}，信号 ${signal || 'SIGTERM'}`));
        else resolve(result);
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
