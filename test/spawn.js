import { spawn } from 'node:child_process';

// 执行 ls 命令，参数 -lh 和 /usr 作为数组传递
const child = spawn('ls', ['-lh', '/usr']);

// 通过监听 'data' 事件，流式地获取标准输出
child.stdout.on('data', (data) => {
  console.log(`stdout: ${data}`);
});

// 监听 'close' 事件，获取退出码
child.on('close', (code) => {
  console.log(`子进程退出，退出码：${code}`);
});