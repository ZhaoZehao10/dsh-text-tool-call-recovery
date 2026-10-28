// 套件的「运行需求」元数据 —— **唯一事实源**
//
// **缺陷 125**（第 124 轮）：`NEEDS_GC` 曾在**四个文件里各自定义一份**：
//
//   run-all.mjs              5 项（第 123 轮补全）
//   coverage.mjs             2 项（漏）
//   branch-coverage.mjs      2 项（漏）
//   mutation-test.mjs        2 项（漏）
//
// 后果：`perf-baseline` / `perf-profile` / `timeout-backpressure` 这三个
// 需要 `--expose-gc` 的套件，**只在 run-all 里被正确对待**；
// 在覆盖率工具和变异测试里它们**必然失败**（测的是未回收的垃圾），
// 而失败要么被 `catch {}` 吞掉，要么被算成「基线失败」。
//
// **根因是复制粘贴导致的分叉**：同一份知识被抄了 4 份，改一处不会同步其余。
// 修法不是「记得同步」，而是**只留一份**。
//
// 本模块只做数据定义，没有副作用，可以被 run-all 与所有元套件安全导入。

/**
 * 需要 `--expose-gc` 才能正确测量堆增长的套件。
 *
 * 判据：源码里**真的**调用 `global.gc?.()` / `globalThis.gc` / `gc()`。
 * `meta-health` 第 14 节会**反向枚举**所有 hardening 套件来验证这份列表
 * 既不缺项（有调用但没列）也没有僵尸（列了但没调用）。
 */
export const NEEDS_GC = new Set([
	"memory-lifecycle.mjs",
	"soak-test.mjs",
	"perf-baseline.mjs",
	"perf-profile.mjs",
	"timeout-backpressure.mjs",
]);

/** 需要真实会话日志（`~/.dsh/sessions` 快照）才能运行的套件。 */
export const NEEDS_LOGS = new Set([
	"replay-real-streams.mjs",
	"audit-rewrites.mjs",
	"mine-unrecovered.mjs",
	"false-positive-audit.mjs",
	"per-model-replay.mjs",
	"health-check.mjs",
	"synth-provenance.mjs",
	"effect-quantify.mjs",
	"lcr-replay.mjs",
]);

/** 慢速套件：`--quick` 模式下跳过（但 `--offline` 仍会跑）。 */
export const SLOW = new Set([
	"mutation-test.mjs",
	"coverage.mjs",
	"branch-coverage.mjs",
	"fuzz-random-streams.mjs",
	"fuzz-multi-turn.mjs",
]);

/** 元套件：会运行其他套件，因此任何「枚举全部套件」的检查都应排除它们。 */
export const META_SUITES = new Set([
	"mutation-test.mjs",
	"coverage.mjs",
	"branch-coverage.mjs",
]);

/**
 * 拼装子进程参数：需要 GC 的套件自动加 `--expose-gc`。
 * @param {string} suitePath 套件绝对路径
 * @returns {string[]} 传给 node 的参数（含脚本路径本身）
 */
export function nodeArgsFor(suitePath) {
	const base = suitePath.replace(/\\/g, "/").split("/").pop() ?? "";
	return NEEDS_GC.has(base) ? ["--expose-gc", suitePath] : [suitePath];
}
