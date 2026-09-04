/**
 * 全局类型声明。
 *
 * 真实源码里，`MACRO` 是构建时注入的全局常量——`build.ts` 用 `bun:bundle`
 * 把 `MACRO.VERSION` / `MACRO.BUILD_TIME` 直接内联成字符串字面量，源码里
 * 只做类型声明（见真实源码 `src/utils/permissions/filesystem.ts` 的
 * `declare const MACRO: { VERSION: string }`）。
 *
 * 用 `tsx` 直跑没有构建注入，运行时的值由 `entrypoints/cli.tsx` 顶部
 * 提供一个垫片（`globalThis.MACRO ??= ...`）。
 */
declare const MACRO: {
  /** 构建时注入的版本号（真实对应 `MACRO.VERSION`） */
  VERSION: string;
};
