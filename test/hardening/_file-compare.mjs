// 文件内容比较（**缺陷 165**，第 155 轮）
//
// 背景：本仓库是跨平台开源的。Git 在提交时按 `.gitattributes` 把换行统一成 LF，
// Windows 检出时可能变成 CRLF —— **同一份代码在两种平台上字节数不同**
// （实测 `lib/index.js`：CRLF 48,772 B / LF 47,731 B，差 1,041 B = 行数）。
//
// 原先多处用 `Buffer.equals` / `Buffer.compare` 比较「源码 vs 安装副本」，
// 于是**在 Linux/macOS 上克隆后跑测试必然报「源码与安装副本不一致」** ——
// 这是纯粹的换行差异，不是代码问题（实测：从 GitHub 全新克隆后 4 个套件因此失败）。
//
// 判据：比较**规范化后的文本**（把 CRLF 折成 LF），语义一致即通过。
// 注意：这**不会**放过真实的内容差异 —— 只抹平换行符这一种差异。
export function normalizeEol(buf) {
	const s = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
	return s.replace(/\r\n/g, "\n");
}

/** 两个文件内容是否语义一致（忽略 CRLF/LF 差异）。 */
export function sameContent(a, b) {
	return normalizeEol(a) === normalizeEol(b);
}

/** 便于断言消息：返回字节数（原始），用于诊断输出。 */
export function byteSize(buf) {
	return Buffer.isBuffer(buf) ? buf.length : Buffer.byteLength(String(buf));
}
