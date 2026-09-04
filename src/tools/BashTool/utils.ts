// 输出截断上限（对应真实源码 `src/utils/shell/outputLimits.ts` 的 BASH_MAX_OUTPUT_DEFAULT）。
// 真实还支持 `BASH_MAX_OUTPUT_LENGTH` 环境变量在 [default, 150_000] 区间覆盖，本小节先用常量。
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
 * 超过 `BASH_MAX_OUTPUT_LENGTH` 时保留前 N 字符，追加 `... [N 行被截断] ...`，
 * 避免超长输出撑爆上下文（真实代码就是这么处理的）。
 */
export function formatOutput(content: string): string {
  if (content.length <= BASH_MAX_OUTPUT_LENGTH) {
    return content;
  }

  const truncatedPart = content.slice(0, BASH_MAX_OUTPUT_LENGTH);
  const remainingLines = countCharInString(content, '\n', BASH_MAX_OUTPUT_LENGTH) + 1;
  return `${truncatedPart}\n\n... [${remainingLines} 行被截断] ...`;
}
