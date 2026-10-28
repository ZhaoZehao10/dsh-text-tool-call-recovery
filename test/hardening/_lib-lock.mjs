// lib/index.js 的「改写锁」——共享工具模块（不是可独立运行的套件，故 _ 前缀）
//
// **缺陷 158**（第 151 轮）：`mutation-test.mjs` 与 `shape-robustness.mjs` 会**临时改写
// `lib/index.js`** 注入变异体，跑完再还原。而本项目同时可能有另一个测试入口在读它 ——
//
// 实测事故（同一台机器、同一次会话）：完整模式跑到 #66（mutation-test，727s+）期间，
// 我并行跑了 `claims-audit`，它 spawn 子套件去核对断言数，于是读到**被变异污染的源码**：
//   · `live-instance` 报「源码 48687B vs 安装 48772B」→ **假失败**
//   · `error-observability` 声明 26 项、实跑只数到 24 → **假不达标**
// 更糟的是 `coverage`：它 spawn 的 100 个子套件读到变异体后内部失败，
// 于是「未执行函数 0 个」却判 ❌（因为 suiteFailures 非空）—— **数据被污染而非代码有 bug**。
// 整体后果：完整模式从 21 分钟恶化到 95 分钟，并产生 3 个假超时/假失败。
//
// 判据：**改写方**在改写期间持有锁；**读取方**发现锁被持有时**明确报错退出**，
// 而不是产出一个看起来像真 bug 的失败。
import fs from "node:fs";
import path from "node:path";

const LOCK = path.join(path.resolve(import.meta.dirname, "..", ".."), ".tmp-lib-write.lock");

/** 锁是否被持有（且持有进程仍存活）。陈旧锁（进程已死）自动清理。 */
export function libWriteLockHolder() {
	let raw;
	try { raw = fs.readFileSync(LOCK, "utf8"); } catch { return null; }
	let info;
	try { info = JSON.parse(raw); } catch { try { fs.rmSync(LOCK, { force: true }); } catch {} return null; }
	try { process.kill(info.pid, 0); return info; } catch {
		// 持有者已退出 → 陈旧锁，清理
		try { fs.rmSync(LOCK, { force: true }); } catch {}
		return null;
	}
}

/** 改写方获取锁；返回 true 表示成功。已有他人持有时返回 false。 */
export function acquireLibWriteLock(owner) {
	const held = libWriteLockHolder();
	if (held && held.owner !== owner) return false;
	try {
		fs.mkdirSync(path.dirname(LOCK), { recursive: true });
		fs.writeFileSync(LOCK, JSON.stringify({ owner, pid: process.pid, at: new Date().toISOString() }), "utf8");
		return true;
	} catch { return false; }
}

/** 改写方释放锁（只释放自己持有的，避免误删他人锁）。 */
export function releaseLibWriteLock(owner) {
	const held = libWriteLockHolder();
	if (held && held.owner === owner) { try { fs.rmSync(LOCK, { force: true }); } catch {} }
}

/**
 * 读取方调用：若锁被他人持有，打印明确原因并退出（不产出假失败）。
 * @param self 自己的名字，用于允许同名重入
 */
export function exitIfLibLocked(self, log) {
	const held = libWriteLockHolder();
	if (!held || held.owner === self) return;
	log(`跳过：检测到 ${held.owner} 正在改写 lib/index.js（PID ${held.pid}，${held.at}）。`);
	log("      并发改读会让本套件读到**变异体**，产出的失败是假的（缺陷 158）。");
	log("      请等它跑完再运行；本套件按「未执行」跳过，不计为失败。");
}

export const LOCK_PATH = LOCK;
