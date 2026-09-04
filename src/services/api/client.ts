import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

/**
 * 构造 Anthropic 客户端（对应真实源码 `src/services/api/client.ts` 的
 * `getAnthropicClient`）。
 *
 * 真实 Claude Code 直连 Anthropic 官方端点；本仓库为了能在本地真实跑通，
 * 把 `baseURL` 指向 DeepSeek 的 **Anthropic 兼容端点**（https://api.deepseek.com/anthropic），
 * 读 `DEEPSEEK_API_KEY`。SDK 仍是 `@anthropic-ai/sdk`（Anthropic Messages 协议不变），
 * 只是换了后端。参考 mini-claude-code/nodejs/m1。
 *
 * 真实实现里这里还处理多 provider（Bedrock / Vertex / Foundry）、OAuth、
 * 自定义 header、代理等——那些属于「暂不实现」清单。
 */
export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('缺少 DEEPSEEK_API_KEY，请在 .env 中配置（参考 .env.example）');
  }
  return new Anthropic({
    apiKey,
    // DeepSeek 的 Anthropic 兼容端点；换回官方 Anthropic 时删除此行、改用 ANTHROPIC_API_KEY 即可。
    baseURL: 'https://api.deepseek.com/anthropic',
  });
}
