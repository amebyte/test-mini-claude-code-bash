# 来，给 Mini Claude Code 装上一只「真手」：从底层理解 Bash 工具的实现原理

### 1. 前言

在[上一篇文章](从单轮对话到 Agent Loop 的实现原理.md)里，我们把 **Agent Loop** 转了起来：模型出「决策」、harness 出「执行」，靠一个 `messages` 数组来回接力，直到模型吐出纯文本为止。

但不知道你有没有发现一个「装样子」的地方——上一篇文章里，我们给 agent 装的那只「手」，其实是**假的**。

看这段代码（上一篇文章的 `FakeTool.ts`）：

```ts
export const fakeBashTool: Tool = {
  name: 'bash',
  description: 'Run a shell command and return its output. ...',
  inputSchema: { /* command: string */ },
  async call(args) {
    const command = typeof args.command === 'string' ? args.command : '(no command)';
    return [
      '[本小节假工具 · bash] 固定返回，未真正执行子进程（真实 Bash 在下一小节里程碑实现）。',
      `收到的 command：${command}`,
    ].join('\n');
  },
};
```

看懂了吗？模型一本正经地输出 `tool_use`：「我要调 `bash`，`command` 是 `ls`」，我们也一本正经地回它一个结果——但这个结果**根本不是我当前目录的内容**，而是一句「固定返回，未真正执行」。

也就是说，上一篇文章里的 agent，是个「**会说话但不会动手**」的 agent：它 `ls` 拿不到文件、`cat` 读不到内容、`npm test` 跑不了测试。它和世界的所有交互，都是我们提前录好的一句「台词」。

这一篇，我们就把这只假手卸掉，装上一只**真手**——一个真正能跑 shell 命令的 `Bash` 工具。那么它是怎么实现的呢？

### 2. 为什么需要真实的 Bash 工具？

先问一个问题：**一个 agent 到底有什么用？**

如果它只会「根据问题生成一段文本」，那它和一个普通的聊天机器人没有区别。它之所以叫 agent（智能体），是因为它能**动手改变世界**：读你项目里的文件、跑测试、装依赖、改代码、执行命令……这些能力，全部都要落在一个底层动作上——**执行 shell 命令**。

上一篇文章的假工具，恰恰卡在了这一步：循环是好的，决策是好的，但「执行」这一环是空的。模型调 `ls`，它拿不到真实目录；模型调 `cat file.txt`，它读不到真实内容。**一个拿不到真实反馈的 agent，等于闭着眼在黑暗中做决策**——它会基于一个假结果，编造出下一个更离谱的回答。

所以真实 Bash 工具要解决的本质问题，其实只有三件事：

1. **真的去跑命令**——用 Node 的子进程把 `command` 真正交给 shell 执行；
2. **把结果带回来**——把 `stdout`、`stderr`、退出码拼成 `tool_result`，回喂给模型；
3. **别把上下文撑爆**——命令输出可能几万行，得截断到合理长度。

这三件事，就对应我们接下来要写的三个文件。但在写代码之前，先用一句话和一张图，把它的本质钉死在脑子里。

### 3. 核心概念：一句话 + 一张图

所谓**真实 Bash 工具**，本质就是一句话：

> **用 Node 的 `child_process` 启动一个子进程，把模型的 `command` 交给 `bash -c` 去执行，再把它的 `stdout` / `stderr` / 退出码拼成一段文本，当作 `tool_result` 回喂给模型。**

伪代码长这样：

```
function bash.call(args):
    command  = args.command          # 模型传的，比如 "ls -la"
    timeout  = 夹紧(args.timeout, 1, 600_000)

    result   = 用 bash -c 跑 command   # 真正的子进程执行
                └─ 超时 → 标记 timedOut
                └─ 退出码非 0 → 追加 "Exit code N"

    text     = stdout + stderr + (超时/退出码提示)
    text     = 去首尾空行 + 截断(30_000 字符)

    return text                       # 交给 query()，回喂模型
```

数据流是这样：

```
  模型 (tool_use: "调 Bash, command=ls")
        │
        ▼
  ┌─────────────────────┐
  │   bashTool.call()   │   ← 我们这篇的主角
  └──────────┬──────────┘
             │  command = "ls"
             ▼
  ┌─────────────────────────────┐
  │  child_process.execFile(    │
  │    shell, ['-c', 'ls'],     │   ← 真正启动子进程
  │    { timeout, maxBuffer }   │
  │  )                          │
  └──────────┬──────────────────┘
             │  stdout/stderr/code
             ▼
  ┌─────────────────────────────┐
  │  stripEmptyLines + format   │   ← 去空行 + 截断
  └──────────┬──────────────────┘
             │  tool_result 文本
             ▼
        query() 回喂给模型
```

图里最核心的是中间那个 `execFile`——它才是「真手」的关节。上一篇文章里，这个位置是「固定返回一句台词」；这一篇文章里，它换成了「真的拉起一个子进程」。

好，概念说清了，上代码。

### 4. 代码实现

我们按「构建顺序」一步步来：先看目录长什么样，再拆成三个文件——名字常量、两个纯函数、核心工具，最后接回 `main.ts`。

#### 4.1 目录结构：假工具是一个文件，真工具是一个目录

先看变化。上一篇文章里，工具只有一个文件：

```
src/tools/FakeTool.ts          ← 假 bash，一个文件搞定
```

这一篇，我们把 `FakeTool.ts` 删掉，换成 `BashTool/` 目录：

```
src/tools/BashTool/
├── BashTool.ts     ← 核心：真的跑命令
├── toolName.ts     ← 工具名常量（打破循环依赖）
└── utils.ts        ← 两个纯函数：去空行 + 截断
```

为什么要拆成一个目录？因为真实的 Bash 工具比「假工具」重得多：名字要单独放（避免循环依赖）、输出处理要单独放（纯函数可测试）、核心执行单独放。这正好呼应了一个软件工程的直觉——**假的时候糊一个文件就行，真的时候得认真分层**。

#### 4.2 `toolName.ts`：为什么工具名要单独成一个文件？

新建 [tools/BashTool/toolName.ts](tools/BashTool/toolName.ts)：

```ts
// 独立 name 常量，用于打破循环依赖（对应真实源码 `src/tools/BashTool/toolName.ts`）。
// 真实工具名是大写 `Bash`（不是 m2 假工具的 `bash`）。
export const BASH_TOOL_NAME = 'Bash';
```

就这么一行，但藏着两个要点：

1. **工具名变了**：从上一篇文章假工具的 `bash`（小写），变成了真实的 `Bash`（大写）。这不是随便改的——真实 Claude Code 里的 Bash 工具名就是大写 `Bash`，我们一步步在向真实源码靠拢。
2. **单独一个文件是为了「打破循环依赖」**：`BashTool.ts` 要用到这个名字，别的地方（比如权限系统、测试）也要引用同一个名字。如果名字定义在 `BashTool.ts` 里，谁引用它就得先加载整个工具，容易绕成一圈互相 `import`。单独抽出来，大家引用同一个常量，依赖关系就清爽了。

#### 4.3 `utils.ts`：两个纯函数，处理输出的「脏活」

真实命令的输出是脏的：可能开头结尾一堆空行、可能几万行把上下文撑爆。所以先写两个纯函数来「洗输出」。新建 [tools/BashTool/utils.ts](tools/BashTool/utils.ts)：

```ts
// 输出截断上限（对应真实源码 `src/utils/shell/outputLimits.ts` 的 BASH_MAX_OUTPUT_DEFAULT）。
// 真实还支持 `BASH_MAX_OUTPUT_LENGTH` 环境变量在 [default, 150_000] 区间覆盖，T3 先用常量。
export const BASH_MAX_OUTPUT_LENGTH = 30_000;

function countCharInString(s: string, ch: string, fromIndex = 0): number {
  let count = 0;
  for (let i = fromIndex; i < s.length; i++) {
    if (s[i] === ch) count++;
  }
  return count;
}

/**
 * 去掉首尾完全空白/空行（对应真实源码 `BashTool/utils.ts` 的 `stripEmptyLines`）。
 * 与 `trim()` 不同：只移除首尾「整行都是空白」的行，保留内容行内部的空白与换行结构。
 */
export function stripEmptyLines(content: string): string {
  const lines = content.split('\n');

  let start = 0;
  while (start < lines.length && lines[start]?.trim() === '') {
    start++;
  }

  let end = lines.length - 1;
  while (end >= 0 && lines[end]?.trim() === '') {
    end--;
  }

  if (start > end) return '';
  return lines.slice(start, end + 1).join('\n');
}

/**
 * 输出截断（对应真实源码 `BashTool/utils.ts` 的 `formatOutput`）。
 * 超过 `BASH_MAX_OUTPUT_LENGTH` 时保留前 N 字符，追加 `... [N lines truncated] ...`，
 * 避免超长输出撑爆上下文（真实代码就是这么处理的）。
 */
export function formatOutput(content: string): string {
  if (content.length <= BASH_MAX_OUTPUT_LENGTH) {
    return content;
  }

  const truncatedPart = content.slice(0, BASH_MAX_OUTPUT_LENGTH);
  const remainingLines = countCharInString(content, '\n', BASH_MAX_OUTPUT_LENGTH) + 1;
  return `${truncatedPart}\n\n... [${remainingLines} lines truncated] ...`;
}
```

大白话解释两个函数：

- `stripEmptyLines` 是「去首尾空行」：它和 `trim()` 不一样。`trim()` 会把所有空白字符都剥掉，破坏内容中间的换行结构；它只把**开头和结尾那些「整行都是空白」的行**去掉，内容行内部的空白和换行原样保留。比如命令输出前后常有多余的空行，这些空行对模型没信息量，去掉能让结果更紧凑。
- `formatOutput` 是「截断」：输出超过 `30_000` 字符时，保留前 `30_000` 字符，数一下后面还剩多少行，追加一句 `... [N lines truncated] ...`。为什么非截不可？因为 `tool_result` 是要塞进下一轮 `messages` 回喂给模型的，一段几万行的 `cat` 输出会**瞬间撑爆上下文窗口**。这是真实 Claude Code 里真实存在的机制，我们如实还原。

#### 4.4 `BashTool.ts`：真正的关节在这里

终于到核心了。新建 [tools/BashTool/BashTool.ts](tools/BashTool/BashTool.ts)，它分三块：选 shell、跑命令、拼结果。

##### 4.4.1 选 shell：`resolveShell()`

先看为什么要「选 shell」：

```ts
import { execFile, type ExecFileException } from 'node:child_process';
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
 * 选择 shell（对应真实源码 `src/utils/Shell.ts` 的 `findSuitableShell`）。
 *
 * 真实规则：优先 `CLAUDE_CODE_SHELL`（必须是 bash/zsh），否则探测系统的 bash/zsh。
 * 关键点：Claude Code 永远用 bash（或 zsh）跑命令，**不是** Windows 的 cmd.exe——
 * cmd.exe 不会像 bash 那样剥引号，`echo "print('hi')" > f` 会连引号一起写进文件。
 *
 * T3 简化为：CLAUDE_CODE_SHELL → $SHELL（若为 bash/zsh）→ 平台兜底（win32 用 git-bash 的 bash）。
 */
function resolveShell(): string {
  const override = process.env.CLAUDE_CODE_SHELL;
  if (override && (override.includes('bash') || override.includes('zsh'))) {
    return override;
  }
  const shellEnv = process.env.SHELL;
  if (shellEnv && (shellEnv.includes('bash') || shellEnv.includes('zsh'))) {
    return shellEnv;
  }
  return process.platform === 'win32' ? 'bash' : '/bin/bash';
}
```

这里有一个**非常底层、非常反直觉**的点，值得单独拎出来讲：

**为什么 Claude Code 在 Windows 上也要用 `bash`，而不是系统自带的 `cmd.exe`？**

因为 `cmd.exe` 不会像 bash 那样**剥引号**。假设模型生成的命令是 `echo "print('hi')" > f.py`，在 bash 里，引号是语法的一部分，写进文件的是 `print('hi')`；但在 `cmd.exe` 里，引号会被当成普通字符**原样写进文件**，你得到的是一个带着双引号的、语法错误的 Python 文件。

所以真实 Claude Code 的做法是：**永远用 bash（或 zsh）跑命令**。`resolveShell()` 的优先级是：

1. 先看环境变量 `CLAUDE_CODE_SHELL`（用户显式指定，且必须是 bash/zsh）；
2. 再看 `$SHELL`（系统默认 shell，同样必须是 bash/zsh）；
3. 最后平台兜底——Windows 上就用 git-bash 自带的 `bash`，其他平台用 `/bin/bash`。

##### 4.4.2 跑命令：`runCommand()`

```ts
/**
 * 用 `bash -c` 跑一条命令（对应真实源码 `src/utils/Shell.ts` 的 exec 包装 + shellPrefix 的
 * `<shell> -c <command>` 调用方式，底层是 Node child_process，带 timeout + maxBuffer）。
 *
 * 用 `execFile(shell, ['-c', command])` 而不是 `exec(command)`：`exec` 在 Windows 上默认走
 * cmd.exe（`/c` 语义），`execFile` + 显式 `-c` 才能保证永远按 bash 语义执行。
 */
function runCommand(command: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise(resolve => {
    execFile(
      resolveShell(),
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
```

逐行读一下这里面的「底层细节」：

- **为什么用 `execFile` 而不是 `exec`？** `exec` 在 Windows 上默认走 `cmd.exe`（`/c` 语义），会踩到前面说的「引号被写进文件」的坑。`execFile(resolveShell(), ['-c', command])` 是显式地「用 bash 跑，参数是 `-c` 和命令」，才能保证**永远按 bash 语义执行**。
- **`timeout` + `maxBuffer`**：`timeout` 到期后，`execFile` 会向子进程发 `SIGTERM` 信号把它杀掉；`maxBuffer` 是输出缓冲上限（10MB），超过会被以 maxBuffer 错误杀掉。这两个是「防止命令失控」的保险丝。
- **怎么判断超时**：`execFile` 杀进程后，回调里的 `error` 会带上 `killed === true` 或 `signal === 'SIGTERM'`，据此置 `timedOut`。
- **退出码的类型坑**：`ExecFileException.code` 的类型是 `number | string | null | undefined`——`number` 表示**非零退出码**（比如 `npm test` 失败了），字符串 `'ENOENT'` 表示 **shell 都没找到**，`null` 表示**被信号杀掉**（比如超时）。我们只关心真正的退出码，所以 `typeof error.code === 'number'` 时才保留，否则置 `undefined`。

##### 4.4.3 拼结果：`bashTool`

```ts
/**
 * Bash 工具（对应真实源码 `src/tools/BashTool/BashTool.tsx`）。
 *
 * 真实 BashTool 有沙箱、后台化（run_in_background）、sed 编辑模拟、权限匹配、
 * 语义命令分类（搜索/读/列）、图像输出识别等一大堆机制。T3 只还原「最核心」的三件事：
 *   1. 跑本地命令（`bash -c` 经 child_process.execFile + timeout）；
 *   2. 把 stdout/stderr 拼成 tool_result（非零退出码追加 `Exit code N`）；
 *   3. 输出截断（太长会爆上下文，真实代码就是这么处理的）。
 *
 * 工具名是大写 `Bash`（真实 `BASH_TOOL_NAME`）。T2 的假工具叫 `bash`，T3 换成真实名字。
 * 其余字段（description / run_in_background / dangerouslyDisableSandbox）留到 T6 权限、T13 后台。
 */
export const bashTool: Tool = {
  name: BASH_TOOL_NAME,
  description: 'Run a shell command and return its output.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute' },
      timeout: {
        type: 'number',
        description: `Optional timeout in milliseconds (max ${MAX_TIMEOUT_MS})`,
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
```

这是整个工具的「总装车间」。注意看几个细节：

- **`inputSchema` 多了个 `timeout` 参数**：上一篇文章的假工具只有 `command`，这里加了可选的 `timeout`（毫秒），让模型能控制「这条命令最多跑多久」。注意它在 `call()` 里被 `Math.min(Math.max(requested, 1), MAX_TIMEOUT_MS)` **夹紧在 `[1ms, 600s]` 区间**——模型传 0 或传一个亿，都不会让子进程失控。
- **拼输出的顺序**：`stdout` 在前、`stderr` 在后。接着判断异常情况——如果 `timedOut`，追加一句 `[命令超时] ... 后被终止`；如果退出码非 0，追加 `Exit code N`。这两种情况是**互斥**的（超时了就不再报退出码），用一个 `if / else if` 表达得清清楚楚。
- **最后一道工序**：`stripEmptyLines(raw)` 去首尾空行，`formatOutput(...)` 截断，如果结果全空（比如 `ls` 一个空目录且无输出），返回占位符 `(no output)`，保证模型永远能拿到一个非空字符串。

有没有发现一个很有意思的点？这个 `call()` 的**签名和返回值**，和上一篇文章的假工具**一模一样**——都是 `async call(args): Promise<string>`。这正是上一篇文章埋下的伏笔：「假工具和真工具长得一模一样（都是 `Tool` 契约），所以将来把假工具换成真工具，循环一行都不用改。」

#### 4.5 接线：循环一行没改，只换了一只「手」

最后一步，把假手换成真手。改 [main.ts](main.ts)：

```diff
 import { Command } from 'commander';
 import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
 import { query } from './query.js';
-import { fakeBashTool } from './tools/FakeTool.js';
+import { bashTool } from './tools/BashTool/BashTool.js';

 // 真实 Claude Code 有一个庞大、随版本变化的 system prompt（角色 + 工具说明 + 环境信息）。
-// T2 先放一条最小提示，让模型知道「有个 bash 工具，需要执行命令就调它」。
+// T3 先放一条最小提示：告诉模型它有一个能执行真实命令的 Bash 工具。
 const SYSTEM_PROMPT = [
-  '你是 Claude Code 的最小还原实现（T2 · 核心 Agent Loop）。',
-  '你有一个 `bash` 工具（本里程碑是假实现，固定返回字符串）。',
-  '当任务需要执行命令或获取系统信息时，调用 `bash` 工具；拿到结果后继续作答，直到给出最终回答。',
+  '你是 Claude Code 的最小还原实现（T3 · 真实 Bash 工具）。',
+  '你有一个 `Bash` 工具，可以执行真实的 shell 命令。',
+  '当任务需要执行命令、查看文件、获取系统信息时，调用 `Bash` 工具；拿到结果后继续作答，直到给出最终回答。',
 ].join(' ');
 
 export async function main(): Promise<void> {
   const program = new Command();
 
   program
     .name('claude')
-    .description('Claude Code 源码最小还原实现（T2 核心 Agent Loop）')
+    .description('Claude Code 源码最小还原实现（T3 真实 Bash 工具）')
     .argument('[prompt]', '给 agent 的提示词', String)
     .version(`${MACRO.VERSION} (Claude Code)`, '-v, --version', 'Output the version number')
     .helpOption('-h, --help', 'Display help for command')
     .action(async (prompt: string | undefined) => {
@@
-        // 驱动 Agent Loop：文本由 claude.ts 流式打印，这里只渲染工具事件。
+        // 驱动 Agent Loop：文本由 claude.ts 流式打印，这里只渲染工具事件。
         for await (const event of query({
           messages,
-          tools: [fakeBashTool],
+          tools: [bashTool],
           system: SYSTEM_PROMPT,
         })) {
```

改动的全部内容就四样：`import` 换了、`SYSTEM_PROMPT` 文案换了、`description` 文案换了、`tools: [fakeBashTool]` 换成了 `tools: [bashTool]`。

而 [query.ts](query.ts) 里的那个 `while` 循环、[Tool.ts](Tool.ts) 里的 `Tool` 契约、[services/api/claude.ts](services/api/claude.ts) 里的 `streamAssistantTurn`——**一行核心逻辑都没动**。

这就是上一篇文章反复强调的那句分层思想的最好证明：

> **「循环属于 agent，机制属于 harness」**——循环不知道也不关心 `bash` 是不是真的，它只负责「模型要调工具 → 找到工具 → 调 `call()` → 回喂结果」。把假手换成真手，循环一行不改。

### 5. 测试 / 演示

现在来跑一下，看这只「真手」是不是真的能干活了。我们下一条「会触发真实执行」的指令：

```bash
$ npx tsx src/entrypoints/cli.tsx "查看一下当前目录里有什么文件"
```

模型收到指令后，会调 `Bash` 工具（这次是真的了），拿到真实的 `ls` 输出再组织回答。运行效果大致是：

```diff
[工具调用] Bash {"command":"ls -la"}

[工具结果] total 0
drwxr-xr-x  1 user 197609 0  9月  3 14:22 .
drwxr-xr-x  1 user 197609 0  9月  3 14:22 ..
-rw-r--r--  1 user 197609 0  9月  3 14:22 Tool.ts
-rw-r--r--  1 user 197609 0  9月  3 14:22 main.ts
-rw-r--r--  1 user 197609 0  9月  3 14:22 query.ts
drwxr-xr-x  1 user 197609 0  9月  3 14:22 tools

当前目录下共有这些内容：一个 Tool.ts、main.ts、query.ts 三个源文件，
还有一个 tools 目录。
```

对比上一篇文章的假工具输出——「固定返回，未真正执行子进程」——这一次，模型拿到的**是真的 `ls -la` 结果**，它基于真实文件列表组织出了正确答案。

再验证一个「真手」才有的能力——**命令失败时，模型能感知到错误**。我们让它跑一条不存在的命令：

```bash
$ npx tsx src/entrypoints/cli.tsx "运行命令 foobar-xyz 看看会发生什么"
```

```diff
[工具调用] Bash {"command":"foobar-xyz"}

[工具结果] Exit code 127

命令 foobar-xyz 执行失败了，返回了退出码 127，这通常表示命令不存在
（command not found）。在 bash 里，127 正是「找不到命令」的退出码。
```

看到没有？`runCommand` 里那段「`error.code` 是 `number` 才保留」的逻辑，在这一刻派上了用场——`foobar-xyz` 不存在，shell 返回退出码 `127`，被拼进 `tool_result`，于是模型「看见」了失败，并正确解释了 `127` 的含义。**这是假工具永远做不到的：真实的错误反馈，让模型有了基于事实纠错的能力。**

### 6. 工作原理总结

把「真手」的工作流程压缩成一张有序步骤：

1. 模型输出 `tool_use`：我要调 `Bash`，`command` 是 `ls -la`；
2. `query()` 找到 `bashTool`，调它的 `call()`；
3. `call()` 先把 `timeout` 夹紧在 `[1ms, 600s]`；
4. `resolveShell()` 选定一个 bash（Windows 上用 git-bash 的 `bash`）；
5. `runCommand()` 用 `execFile(shell, ['-c', command], { timeout, maxBuffer })` **真正启动子进程**；
6. 回调里判断：`killed`/`SIGTERM` → 超时；`code` 是 `number` → 保留退出码；否则 `undefined`；
7. 拼输出：`stdout` + `stderr` +（超时提示 或 `Exit code N`）；
8. `stripEmptyLines` 去首尾空行 → `formatOutput` 截断到 30_000 字符；
9. 把这段文本作为 `tool_result` 回喂给模型，进入下一轮循环。

这就是**「真手」的最小闭环**。真实 Claude Code 的 BashTool 在它上面叠了沙箱、后台化（`run_in_background`）、sed 编辑模拟、权限匹配、图像输出识别……但**内核就是这个 `execFile` + 拼输出 + 截断**的三板斧。

### 7. 总结

所谓**真实 Bash 工具**，本质就是一句话：

> **把「模型要执行的命令」通过 `child_process.execFile` 用 `bash -c` 真正交给操作系统去跑，再把它的 `stdout` / `stderr` / 退出码洗一洗、截一截，拼成 `tool_result` 回喂给模型——而承载它的循环，一个字都不用改。**

三个核心，记住它们就够了：

- **真手的关节是 `execFile` 而不是 `exec`**：`execFile(shell, ['-c', command])` 显式指定「用 bash 跑」，绕开了 Windows 上 `cmd.exe` 不剥引号、把 `"` 原样写进文件的坑——这是「从底层理解」最值钱的一处。
- **超时和退出码是「真手」的触觉**：`timeout` 到期发 `SIGTERM` 杀进程、`error.code` 要 `typeof === 'number'` 才保留、`stdout`/`stderr`/`Exit code N` 按语义拼——这些让模型能「感知到」命令是成功、失败还是超时，而不是永远听到一句「成功了」。
- **分层是灵魂，换手不动循环**：`bashTool` 和 `fakeBashTool` 长得一模一样（都是 `Tool` 契约），所以从假手换到真手，`query()` 循环一行没改——这为后续 T4（文件工具集）、T6（权限）、T13（后台化）留好了干净的扩展点。

在此基础上，你可以继续加：给 `Bash` 加**权限校验**（T6，危险的命令要问一句用户）、加**后台化**（T13，`run_in_background` 跑长任务）、把超长输出改成**落盘 + 流式读回**（真实 `toolResultStorage` 的做法）……但无论怎么加，**核心永远是这一个 `execFile`**。

我是 Cobyte，欢迎添加 v: icobyte，学习交流 AI 全栈。
