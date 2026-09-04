import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { findToolByName, type Tool } from './Tool.js';
import {
  streamAssistantTurn,
  type AssistantContent,
  type AssistantTurn,
} from './services/api/claude.js';

/** 从 AssistantContent 联合里提出的 tool_use 块 */
type ToolUseBlock = Extract<AssistantContent, { type: 'tool_use' }>;

/**
 * query() 产出的进度事件。文本 delta 已由 claude.ts 直接流式打印到 stdout，
 * 所以这里只回传「工具」相关事件，交给调用方（main.ts）渲染。
 * 对应真实 `query()` 的 yield 语义：把事件抛给上层消费者，由消费者决定怎么渲染。
 */
export type QueryEvent =
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; content: string };

export type QueryParams = {
  messages: MessageParam[];
  tools: Tool[];
  system?: string;
  /** 单轮最大迭代次数（防死循环），对应真实 QueryParams.maxTurns */
  maxTurns?: number;
};

/**
 * query() —— Agent Loop 的核心（对应真实源码 `src/query.ts` 的 `query()` + `queryLoop()`）。
 *
 * 格言：One loop & Bash is all you need。Harness 层：**循环**。
 *
 * 真实 `queryLoop` 是一个 `while (true)`，每轮：
 *   1. 调 API 流式拿回复，累积 assistantMessages，出现 tool_use 块就置 needsFollowUp；
 *   2. 无 tool_use（纯文本）→ `return { reason: 'completed' }`；
 *   3. 有 tool_use → runTools 执行工具，收集 toolResults；
 *   4. `state.messages = [...messagesForQuery, ...assistantMessages, ...toolResults]` 继续下一轮。
 *
 * 本实现按同一结构最小还原：维护 `messages` 数组、while 循环、
 * 「有没有 tool_use 块」作为循环退出信号（真实注释明确 stop_reason==='tool_use' 不可靠）。
 */
export async function* query(
  params: QueryParams,
): AsyncGenerator<QueryEvent, void, void> {
  const tools = params.tools;
  const system = params.system;
  const maxTurns = params.maxTurns ?? 10;

  // 循环状态：messages 在每轮之间累积（对应真实 queryLoop 的 state.messages）。
  const messages: MessageParam[] = [...params.messages];
  let turnCount = 0;

  // 对应真实 queryLoop 的 `while (true)`。
  while (true) {
    turnCount += 1;

    // 死循环保护：超过 maxTurns 强制结束（对应真实 `maxTurns` 检查）。
    if (turnCount > maxTurns) {
      yield {
        type: 'tool_result',
        id: '',
        name: '',
        content: `[循环保护] 已达最大轮次 ${maxTurns}，强制结束（对应真实 QueryParams.maxTurns）。`,
      };
      return;
    }

    // 1) 调一次 API：文本流式打印，返回完整 assistant turn（含 tool_use 块与 stop_reason）。
    const turn: AssistantTurn = await streamAssistantTurn(messages, tools, system);

    // 2) assistant 这轮的 content 追加进 messages（对应真实 assistantMessages.push）。
    messages.push({ role: 'assistant', content: turn.content });

    // 3) 提取 tool_use 块（对应真实的 toolUseBlocks / needsFollowUp）。
    const toolUseBlocks: ToolUseBlock[] = turn.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    );

    // 4) 纯文本（无工具调用）→ 循环结束（对应真实 `return { reason: 'completed' }`）。
    if (toolUseBlocks.length === 0) {
      return;
    }

    // 5) 执行每个工具，收集 tool_result（对应真实 runTools + toolResults.push）。
    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
    for (const block of toolUseBlocks) {
      yield { type: 'tool_use', id: block.id, name: block.name, input: block.input as Record<string, unknown> };

      const tool = findToolByName(tools, block.name);
      const content = tool
        ? await tool.call(block.input as Record<string, unknown>)
        : `[错误] 未找到工具 ${block.name}`;

      yield { type: 'tool_result', id: block.id, name: block.name, content };
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
    }

    // 6) tool_result 回喂给模型，继续下一轮。
    //    对应真实 `state.messages = [...messagesForQuery, ...assistantMessages, ...toolResults]`。
    messages.push({ role: 'user', content: toolResults });
  }
}
