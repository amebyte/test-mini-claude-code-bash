import { execFile, execFileSync, type ExecFileException } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { join as pathWin32Join } from 'path/win32';
import type { Tool } from '../../Tool.js';
import { BASH_TOOL_NAME } from './toolName.js';
import { formatOutput, stripEmptyLines } from './utils.js';

// 默认/最大超时（对应真实源码 `src/utils/timeouts.ts` 的常量）：
// DEFAULT_TIMEOUT_MS = 120_000（2 分钟）、MAX_TIMEOUT_MS = 600_000（10 分钟）。
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

// execFile 的 maxBuffer 上限（10MB）。真实用「输出落盘 + 流式读回」处理超大输出（toolResultStorage），
// T3 先用 execFile 的 maxBuffer 占位——超过 10MB 的输出会被以 maxBuffer 错误杀掉。
const MAX_BUFFER = 10 * 1024 * 1024;

type BashInput = {
  command: string;
  timeout?: number;
};

type ExecResult = {
  stdout: string;
  stderr: string;
  /** 退出码；被信号杀掉（如超时 SIGTERM）时为 undefined */
  code: number | undefined;
  timedOut: boolean;
};

/**
 * 判断一个 shell 路径是否可执行（对应真实源码 `src/utils/Shell.ts` 的 `isExecutable`）。
 *
 * 先试 `accessSync(path, X_OK)`（Windows 上 X_OK 基本等价于「文件存在」）；失败再兜底
 * 真跑一次 `<shell> --version`（覆盖 Nix 等 X_OK 检查失效的环境）。
 */
function isExecutable(shellPath: string): boolean {
  try {
    accessSync(shellPath, fsConstants.X_OK);
    return true;
  } catch {
    try {
      execFileSync(shellPath, ['--version'], { timeout: 1000, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 在 PATH 里查找命令的完整路径（对应真实源码 `src/utils/which.ts` 的 `which`）。
 *
 * Windows 用 `where.exe`（返回多行，取第一行），POSIX 用 `which`。真实实现用 execa 的
 * `shell: true` 拼字符串，这里改用 execFile + 参数数组，避免 shell 注入。
 */
function which(command: string): Promise<string | null> {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  return new Promise(resolve => {
    execFile(locator, [command], { encoding: 'utf8' }, (error, stdout) => {
      if (error || !stdout) return resolve(null);
      const first = stdout.trim().split(/\r?\n/)[0];
      resolve(first || null);
    });
  });
}

// ── Windows 下定位 Git Bash（对应真实源码 `src/utils/windowsPaths.ts`）──────────────────
//
// 真实 Claude Code 在 Windows 上「永远用 Git Bash、绝不落到 WSL」的关键不在
// `findSuitableShell`，而在 `windowsPaths.ts` 的 `findGitBashPath` + `setShellIfWindows`：
// 它先找到 Git Bash 的 bash.exe，写进 `process.env.SHELL`，后续 `findSuitableShell`
// 走 `$SHELL` 分支自然命中。裸 `bash` 在原生 PowerShell 里会被 `where.exe` 解析成
// `C:\WINDOWS\system32\bash.exe`（WSL 启动器，走 HCS 建虚拟机，报 0x800705aa），所以
// 必须显式定位 Git Bash 而不是依赖 PATH。

/** 判断路径是否存在（真实用 `dir "…"`，这里用 existsSync 等价替换）。 */
function checkPathExists(p: string): boolean {
  return existsSync(p);
}

/**
 * 找 git 的可执行文件（对应真实 `findExecutable('git')`）。
 * 先查常见安装位置（64 位在前），再兜底 `where.exe git` 取第一个。
 * 真实还会过滤掉「当前目录」里的可疑 git 以防执行恶意文件，T3 先略过这一层。
 */
function findGitExecutable(): string | null {
  const defaultLocations = [
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  ];
  for (const loc of defaultLocations) {
    if (checkPathExists(loc)) return loc;
  }
  try {
    const out = execFileSync('where.exe', ['git'], { encoding: 'utf8' });
    return out.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/**
 * 找 Git Bash 的 bash.exe（对应真实 `findGitBashPath`）。
 * 1) `CLAUDE_CODE_GIT_BASH_PATH` 环境变量；2) 由 git 位置反推 bash
 * （git 在 `<Git>\cmd\git.exe`，bash 在 `<Git>\bin\bash.exe`）；3) 找不到就报错（真实会退出进程）。
 */
function findGitBashPath(): string {
  const override = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (override && checkPathExists(override)) {
    return override;
  }
  const gitPath = findGitExecutable();
  if (gitPath) {
    const bashPath = pathWin32Join(gitPath, '..', '..', 'bin', 'bash.exe');
    if (checkPathExists(bashPath)) {
      return bashPath;
    }
  }
  throw new Error(
    'Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win). ' +
      'If installed but not in PATH, set environment variable pointing to your bash.exe, ' +
      'similar to: CLAUDE_CODE_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe',
  );
}

/**
 * Windows 下把 `$SHELL` 指向 Git Bash（对应真实 `setShellIfWindows`）。
 * 真实在 init.ts 里调一次，让 `findSuitableShell` 走 `$SHELL` 分支；demo 没有 init 阶段，
 * 所以在 `findSuitableShell` 开头调用一次，效果等价。
 */
function setShellIfWindows(): void {
  if (process.platform === 'win32') {
    process.env.SHELL = findGitBashPath();
  }
}

/**
 * 选择 shell（对应真实源码 `src/utils/Shell.ts` 的 `findSuitableShell`，逐行还原）。
 *
 * 优先级：`CLAUDE_CODE_SHELL` 覆盖 → `$SHELL` → `which(zsh)/which(bash)` → 常见安装目录兜底，
 * 每个候选都用 `isExecutable` 校验后才返回；一个都找不到就抛错（文案与真实一致）。
 *
 * 关键点：Claude Code 永远用 bash（或 zsh）跑命令，**不是** Windows 的 cmd.exe——
 * cmd.exe 不会像 bash 那样剥引号，`echo "print('hi')" > f` 会连引号一起写进文件。
 */
async function findSuitableShell(): Promise<string> {
  // Windows 先把 $SHELL 指向 Git Bash（真实在 init.ts 做，demo 没有 init，这里调用一次）。
  setShellIfWindows();

  // 1) 显式覆盖：CLAUDE_CODE_SHELL（必须是 bash/zsh，且真实可执行）。
  const override = process.env.CLAUDE_CODE_SHELL;
  if (override) {
    const supported = override.includes('bash') || override.includes('zsh');
    if (supported && isExecutable(override)) return override;
  }

  // 2) 用户偏好的 shell：$SHELL（仅当是 bash/zsh）。
  const envShell = process.env.SHELL;
  const isEnvSupported =
    envShell && (envShell.includes('bash') || envShell.includes('zsh'));
  const preferBash = envShell?.includes('bash');

  // 3) 用 which 探测系统里的 bash/zsh。
  const [zshPath, bashPath] = await Promise.all([which('zsh'), which('bash')]);

  // 4) 常见安装目录兜底（真实源码就是这四处）。
  const shellPaths = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
  const shellOrder = preferBash ? ['bash', 'zsh'] : ['zsh', 'bash'];
  const supportedShells = shellOrder.flatMap(shell =>
    shellPaths.map(path => `${path}/${shell}`),
  );

  // 把 which 探测到的路径插进列表（用户偏好类型放最前）。
  if (preferBash) {
    if (bashPath) supportedShells.unshift(bashPath);
    if (zshPath) supportedShells.push(zshPath);
  } else {
    if (zshPath) supportedShells.unshift(zshPath);
    if (bashPath) supportedShells.push(bashPath);
  }

  // $SHELL 若是合法 shell，始终最高优先。
  if (isEnvSupported && envShell && isExecutable(envShell)) {
    supportedShells.unshift(envShell);
  }

  const shellPath = supportedShells.find(shell => shell && isExecutable(shell));
  if (!shellPath) {
    throw new Error(
      'No suitable shell found. Claude CLI requires a Posix shell environment. ' +
        'Please ensure you have a valid shell installed and the SHELL environment variable set.',
    );
  }
  return shellPath;
}

/**
 * 用 `bash -c` 跑一条命令（对应真实源码 `src/utils/Shell.ts` 的 exec 包装 + shellPrefix 的
 * `<shell> -c <command>` 调用方式，底层是 Node child_process，带 timeout + maxBuffer）。
 *
 * 用 `execFile(shell, ['-c', command])` 而不是 `exec(command)`：`exec` 在 Windows 上默认走
 * cmd.exe（`/c` 语义），`execFile` + 显式 `-c` 才能保证永远按 bash 语义执行。
 */
async function runCommand(command: string, timeoutMs: number): Promise<ExecResult> {
  const shell = await findSuitableShell();
  return new Promise(resolve => {
    execFile(
      shell,
      ['-c', command],
      // encoding: 'utf8' 让 TS 选中「stdout/stderr 是 string」的重载（否则报 TS2769）。
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error) {
          // 超时：execFile 在 timeout 到期后用 SIGTERM 杀进程，回调 error 带 killed=true / signal='SIGTERM'。
          const timedOut = error.killed === true || error.signal === 'SIGTERM';
          // ExecFileException.code 是 number|string|null|undefined：
          // number = 非零退出码，'ENOENT' = shell 找不到，null = 被信号杀。只保留 number。
          const code = typeof error.code === 'number' ? error.code : undefined;
          resolve({ stdout, stderr, code, timedOut });
        } else {
          resolve({ stdout, stderr, code: 0, timedOut: false });
        }
      },
    );
  });
}

/**
 * Bash 工具（对应真实源码 `src/tools/BashTool/BashTool.tsx`）。
 *
 * 真实 BashTool 有沙箱、后台化（run_in_background）、sed 编辑模拟、权限匹配、
 * 语义命令分类（搜索/读/列）、图像输出识别等一大堆机制。本小节只还原「最核心」的三件事：
 *   1. 跑本地命令（`bash -c` 经 child_process.execFile + timeout）；
 *   2. 把 stdout/stderr 拼成 tool_result（非零退出码追加 `Exit code N`）；
 *   3. 输出截断（太长会爆上下文，真实代码就是这么处理的）。
 *
 * 工具名是大写 `Bash`（真实 `BASH_TOOL_NAME`）。上一小节的假工具叫 `bash`，本小节换成真实名字。
 * 其余字段（description / run_in_background / dangerouslyDisableSandbox）留到后面实现。
 */
export const bashTool: Tool = {
  name: BASH_TOOL_NAME,
  description: '运行一个 shell 命令并返回其输出。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeout: {
        type: 'number',
        description: `可选超时时间，单位为毫秒（最大 ${MAX_TIMEOUT_MS}）`,
      },
    },
    required: ['command'],
  },
  async call(args) {
    const input = args as unknown as BashInput;

    // timeout 参数夹在 [1, MAX_TIMEOUT_MS] 区间内（真实还会用 semanticNumber 解析字符串）。
    const requested = input.timeout ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(requested, 1), MAX_TIMEOUT_MS);

    const result = await runCommand(input.command, timeoutMs);

    // 拼输出：stdout 在前、stderr 在后（真实把两者合并成单一输出流，这里分开拼并保留语义）。
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(result.stderr);
    if (result.timedOut) {
      parts.push(`[命令超时] ${timeoutMs}ms 后被终止`);
    } else if (result.code !== 0) {
      // 真实只在「确实出错」时追加 Exit code N（对应 interpretCommandResult）。
      parts.push(`Exit code ${result.code}`);
    }

    const raw = parts.join('\n');
    // 去首尾空行 + 截断（真实对 stdout 的顺序处理）；全空则给占位符。
    const formatted = formatOutput(stripEmptyLines(raw));
    return formatted || '(no output)';
  },
};
