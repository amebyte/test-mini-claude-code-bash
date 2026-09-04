/**
 * 完整 CLI 入口（对应真实源码 `src/main.tsx`，真实文件含 ink 渲染与 JSX，
 * T3 无 JSX 先简化为 `main.ts`）。
 *
 * 真实实现用 commander 组织完整的参数解析、交互式 REPL 与会话管理。
 * T3 在 T2（Agent Loop）的基础上，把假工具 `fakeBashTool` 换成真实 `bashTool`：
 * Agent Loop（`query()`）一行没改，只换了工具实现——这就是「循环属于 agent，
 * 机制属于 harness」的体现。对应计划文档 v5.0 的「T3 · 第一个真实工具：Bash」。
 */

import { Command } from 'commander';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { query } from './query.js';
import { bashTool } from './tools/BashTool/BashTool.js';

// 真实 Claude Code 有一个庞大、随版本变化的 system prompt（角色 + 工具说明 + 环境信息）。
// T3 先放一条最小提示：告诉模型它有一个能执行真实命令的 Bash 工具。
const SYSTEM_PROMPT = [
  '你是 Claude Code 的最小还原实现（T3 · 真实 Bash 工具）。',
  '你有一个 `Bash` 工具，可以执行真实的 shell 命令。',
  '当任务需要执行命令、查看文件、获取系统信息时，调用 `Bash` 工具；拿到结果后继续作答，直到给出最终回答。',
].join(' ');

export async function main(): Promise<void> {
  const program = new Command();

  program
    .name('claude')
    .description('Claude Code 源码最小还原实现（T3 真实 Bash 工具）')
    .argument('[prompt]', '给 agent 的提示词', String)
    .version(`${MACRO.VERSION} (Claude Code)`, '-v, --version', 'Output the version number')
    .helpOption('-h, --help', 'Display help for command')
    .action(async (prompt: string | undefined) => {
      // 裸启动（无 prompt）：交互式 REPL 属于 T5，本里程碑仍未实现。
      if (prompt === undefined) {
        console.error('[未实现] 交互式 REPL 尚未实现（T5）');
        process.exitCode = 1;
        return;
      }

      try {
        // 初始 messages 只有一条 user 消息；system prompt 单独作为 system 参数传入。
        const messages: MessageParam[] = [{ role: 'user', content: prompt }];

        // 驱动 Agent Loop：文本由 claude.ts 流式打印，这里只渲染工具事件。
        for await (const event of query({
          messages,
          tools: [bashTool],
          system: SYSTEM_PROMPT,
        })) {
          switch (event.type) {
            case 'tool_use':
              console.log(`\n[工具调用] ${event.name} ${JSON.stringify(event.input)}`);
              break;
            case 'tool_result':
              console.log(`[工具结果] ${event.content}\n`);
              break;
          }
        }
        // 结尾补一个换行，让最终回复独立成行。
        console.log('');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[错误] ${message}`);
        process.exitCode = 1;
      }
    });

  await program.parseAsync(process.argv);
}
