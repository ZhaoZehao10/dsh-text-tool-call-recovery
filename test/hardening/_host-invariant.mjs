// 共享工具：加载宿主**真实的**流协议校验器
//
// **为什么需要**（缺陷 88，第 93 轮）：
// 多个套件曾经各自手写流协议校验器（health-check L70、replay-real-streams L34），
// 而第 93 轮已证明手写版与宿主实现有偏差（漏 R8/R9、R10 过严）。
//
// 本模块直接从 `dsh-llm/lib/types/invariant.js` 源码提取
// `validateIndex` / `validateDelta` / `validateStream` 三个函数并求值，
// 让所有套件用**同一个、与宿主同步**的校验器。
//
// 用法：
//   import { loadHostValidator } from "./_host-invariant.mjs";
//   const v = loadHostValidator();            // null 表示拿不到
//   const errors = await v.validate(chunks);  // ["错误信息", ...]
import fs from "node:fs";
import path from "node:path";

/**
 * 定位 dsh-llm 的 invariant.js。
 * @returns {string|null}
 */
export function findInvariantPath() {
	const candidates = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "types", "invariant.js") : null,
		path.join(process.cwd(), "node_modules", "@deepseek-ai", "dsh-llm", "lib", "types", "invariant.js"),
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(c)) return c;

	// 从常见位置推断
	const guess = [
		path.resolve(import.meta.dirname, "..", "..", "node_modules", "@deepseek-ai", "dsh-llm", "lib", "types", "invariant.js"),
	];
	for (const g of guess) if (fs.existsSync(g)) return g;
	return null;
}

/**
 * 从 invariant.js 源码提取真实校验器。
 * @returns {{ validateIndex: Function, validateDelta: Function, validateStream: Function, validate: (chunks: any[]) => Promise<string[]> }|null}
 */
export function loadHostValidator() {
	const invPath = findInvariantPath();
	if (!invPath) return null;

	const src = fs.readFileSync(invPath, "utf8");
	const fnStart = src.indexOf("function validateIndex");
	const fnEnd = src.indexOf("/** Install validation around every provider stream. */");
	if (fnStart < 0 || fnEnd <= fnStart) return null;

	const fnCode = src.slice(fnStart, fnEnd);
	let real;
	try {
		// 这三个函数只用 Number / Map 等标准 API，不依赖模块作用域
		const factory = new Function(fnCode + "\nreturn { validateIndex, validateDelta, validateStream };");
		real = factory();
	} catch {
		return null;
	}
	if (typeof real?.validateStream !== "function") return null;

	return {
		...real,
		/**
		 * 用宿主真实校验器校验一条 chunk 数组。
		 * @param {any[]} chunks
		 * @returns {Promise<string[]>} 错误信息数组（空 = 合规）
		 */
		async validate(chunks) {
			const errors = [];
			const fail = (msg) => { errors.push(String(msg)); };
			async function* src2() { for (const c of chunks) yield c; }
			try {
				const stream = real.validateStream(src2(), fail);
				for await (const _ of stream) { /* 消费完 */ }
			} catch (e) {
				errors.push("threw: " + e.message);
			}
			return errors;
		},
	};
}
