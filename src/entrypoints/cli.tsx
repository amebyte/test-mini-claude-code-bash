// 真实源码里 `MACRO` 由构建时注入（bun:bundle 内联 MACRO.VERSION），不占任何运行时加载。
// 用 tsx 直跑没有构建注入，这里在文件顶部给 globalThis 补一个等价常量，
// 使 `MACRO.VERSION` 在运行时可解析（类型契约见 globals.d.ts 的 `declare const MACRO`）。
(globalThis as { MACRO?: { VERSION: string } }).MACRO ??= {
  VERSION: '0.4.0',
};

/**
 * 引导入口 —— 在加载完整 CLI 之前，先检查特殊 flag。
 *
 * 对应真实源码 `src/entrypoints/cli.tsx`。真实实现里，所有重模块都用
 * `await import(...)` 动态加载，以最小化 fast-path 的模块求值开销；
 * `--version` 的 fast-path 在 import 任何重模块之前就结束（零动态加载）。
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // fast-path：--version / -v / -V —— 零动态加载。
  // 真实实现还要求 args.length === 1（单独出现才命中，避免误吞其它参数）。
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    // biome-ignore lint/suspicious/noConsole: 有意的控制台输出
    console.log(`${MACRO.VERSION} (Claude Code)`);
    return;
  }

  // 未命中特殊 flag，加载并运行完整 CLI。
  // 真实源码这里是 `await import('../main.js')`（src/main.tsx），T3 简化为 main.ts。
  // 注意：真实 cliMain() 不接收参数——main.ts 内部直接用 process.argv 交给 commander 解析。
  const { main: cliMain } = await import('../main.js');
  await cliMain();
}

// 真实源码用 `void main()` 触发（避免悬空 Promise 的 lint 告警）。
void main();
