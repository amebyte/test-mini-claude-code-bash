import { execFile } from 'node:child_process';

execFile('bash', ['--version'], (err, stdout) => {
  console.log(stdout);
});