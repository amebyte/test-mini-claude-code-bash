import type {
  MessageParam,
  TextBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import { getAnthropicClient } from './client.js';
import type { Tool } from '../../Tool.js';

/**
 * assistant 一回合的 content 块（text 或 tool_use）。
 *
 * 直接用 SDK 的 `TextBlockParam` / `ToolUseBlockParam` 作为内容块类型，
 * 这样累积出来的 `content` 数组可以直接塞回 `messages`（`role: 'assistant'`），
 * 无需再做一次结构转换——与真实 `query.ts` 里 assistantMessages 直接回喂的思路一致。
 */
export type AssistantContent = TextBlockParam | ToolUseBlockParam;

export type AssistantTurn = {
  content: AssistantContent[];
  /**
   * API 返回的 stop_reason。真实源码注释明确指出它「不可靠」（并非总被正确设置），
   * 循环退出应以「是否出现 tool_use 块」为准，stop_reason 只作参考。
   */
  stopReason: string | null;
};

// 真实代码有复杂的 token 预算管理（getCurrentTurnTokenBudget 等），
// T2 先用固定上限占位（tool use + 思考可能超过单轮的 1024）。
const MAX_TOKENS = 4096;

/**
 * 流式调用一次 API，把文本逐 token 打印到 stdout，并返回完整 assistant turn。
 *
 * 对应真实源码 `src/services/api/claude.ts` 的流式调用 + `src/query.ts` 里
 * `deps.callModel` 的原始事件累积。这里复刻 raw streaming 的事件处理：
 * `content_block_start`（开块）/ `content_block_delta`（文本增量 + tool 入参的
 * input_json 增量）/ `content_block_stop`（收块）/ `message_delta`（stop_reason）。
 */
export async function streamAssistantTurn(
  messages: MessageParam[],
  tools: Tool[],
  system?: string,
): Promise<AssistantTurn> {
  const client = getAnthropicClient();
  const model = process.env.MODEL_ID ?? 'deepseek-v4-pro';

  const stream = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages,
    // 把本仓库的 Tool 契约映射成 API 需要的 tools 数组（name/description/input_schema）。
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    })),
    stream: true,
  });

  const content: AssistantContent[] = [];
  let currentBlock: AssistantContent | null = null;
  // tool_use 块的入参是分片（input_json_delta）流式到达的，先拼 JSON 再 parse。
  let inputJsonBuffer = '';
  let stopReason: string | null = null;

  for await (const event of stream) {
    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block;
        if (block.type === 'text') {
          currentBlock = { type: 'text', text: '' };
          content.push(currentBlock);
        } else if (block.type === 'tool_use') {
          currentBlock = { type: 'tool_use', id: block.id, name: block.name, input: {} };
          inputJsonBuffer = '';
          content.push(currentBlock);
        }
        // thinking / redacted_thinking 等块：T2 忽略（真实有专门的思考块规则，留待后续）。
        break;
      }

      case 'content_block_delta': {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          if (currentBlock?.type === 'text') {
            currentBlock.text += delta.text;
          }
          process.stdout.write(delta.text);
        } else if (delta.type === 'input_json_delta') {
          inputJsonBuffer += delta.partial_json;
        }
        break;
      }

      case 'content_block_stop': {
        // tool_use 块结束时，把累积的 input_json 解析成对象。
        if (currentBlock?.type === 'tool_use') {
          try {
            currentBlock.input = inputJsonBuffer.trim() ? JSON.parse(inputJsonBuffer) : {};
          } catch {
            currentBlock.input = {};
          }
        }
        currentBlock = null;
        break;
      }

      case 'message_delta': {
        if (event.delta.stop_reason) {
          stopReason = event.delta.stop_reason;
        }
        break;
      }

      default:
        break;
    }
  }

  return { content, stopReason };
}
