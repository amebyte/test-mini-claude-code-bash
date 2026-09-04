/**
 * Tool 类型契约（对应真实源码 `src/Tool.ts`，已按 T2 最小化）。
 *
 * 真实的 `Tool` 是一个重型类型：`call()` 返回 `ToolResult<T>`（可带 newMessages /
 * contextModifier）、`description()` 是异步方法、`inputSchema` 是 Zod schema，
 * 还有 isConcurrencySafe / isReadOnly / maxResultSizeChars / validateInput /
 * checkPermissions / backfillObservableInput 等一大堆字段（见真实 `src/Tool.ts` 第 362 行起）。
 *
 * T2 的目标是「验证循环能转起来」，所以先把它压到「够用」的最小契约：
 * 一个工具 = 名字 + 描述 + JSON Schema + call()。
 * 后续里程碑会逐步把字段加回来：T3 加子进程执行、T4 加文件工具集、T6 加权限、
 * T13 加后台化、T7 加 MCP 工具（isMcp）……
 */

export type ToolInputJSONSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export type Tool = {
  /** 工具名（模型在 tool_use block 里引用的名字） */
  readonly name: string;
  /** 一句话描述，写进 tools 数组里交给 API，让模型知道何时调用 */
  readonly description: string;
  /**
   * JSON Schema（真实用 Zod 定义再转 JSON Schema，T2 直接手写 JSON Schema，
   * 交由 @anthropic-ai/sdk 原样传给 API）。
   */
  readonly inputSchema: ToolInputJSONSchema;
  /** 执行工具，返回回传给模型的 tool_result 文本内容 */
  call(args: Record<string, unknown>): Promise<string>;
};

/**
 * 按名字查找工具（对应真实 `findToolByName`，T2 尚未引入 alias 概念）。
 * 真实实现还支持 `aliases` 别名匹配（`toolMatchesName`），留到需要重命名工具时再加。
 */
export function findToolByName(tools: Tool[], name: string): Tool | undefined {
  return tools.find(t => t.name === name);
}
