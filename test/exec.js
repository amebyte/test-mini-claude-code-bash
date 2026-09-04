import { exec } from 'node:child_process';

// 直接传入完整的命令字符串
exec('ls -lh /usr', (error, stdout, stderr) => {
  if (error) {
    console.error(`执行出错: ${error}`);
    return;
  }
  // stdout 和 stderr 是包含完整输出的字符串
  console.log(`stdout: ${stdout}`);
  console.error(`stderr: ${stderr}`);
});