// 缺陷回归覆盖矩阵
//
// 本项目有 39 个历史缺陷。`defect-regression.mjs` 用 D1–D32 逐个断言，
// 但 R33-R46 新发现的缺陷（D33–D39）属于**交付质量**类，由各自的专门套件覆盖：
//   D33/D34 → install-experience.mjs（脚本编码、备份目录）
//   D35     → deliverable.mjs（LICENSE、安装说明、名称）
//   D36     → doc-executable.mjs（裸 <> 占位符）
//   D37     → ref-verifiable.mjs（引用可核实）
//   D38     → fake-test-audit.mjs（real-samples 有断言）
//   D39     → fake-test-audit.mjs（audit-rewrites 有失败判定）
//
// 本套件把「每个缺陷由谁守护」写成显式矩阵并验证：
//   1. 39 个缺陷每一个都至少有一个守护套件
//   2. 守护套件真的存在
//   3. 守护套件真的包含对应检查
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIR = path.join(ROOT, "test", "hardening");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

// ===========================================================================
// 1. 从 README 抽出全部缺陷
// ===========================================================================
console.log("=== 1. 缺陷清单 ===");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const defects = [];
for (const line of readme.split("\n")) {
	const m = line.match(/^\| (\d+) \| \*\*(.+?)\*\*/);
	if (m) defects.push({ n: Number(m[1]), title: m[2] });
}
console.log(`  README 缺陷表: ${defects.length} 条`);
ck("缺陷表非空", defects.length > 0, "");
ck("缺陷编号连续", defects.every((d, i) => d.n === i + 1), defects.map((d) => d.n).join(","));

// ===========================================================================
// 2. 守护矩阵：每个缺陷由哪个套件守护 + 用什么关键字验证
// ===========================================================================
console.log("\n=== 2. 守护矩阵 ===");

/**
 * 结构：{ defect: number, suite: string, marker: string|RegExp }
 * marker 必须出现在 suite 源码里，证明该套件确实在检查这件事。
 */
const GUARDS = [
	// ---- 插件功能缺陷（D1-D32）：主要由 defect-regression.mjs 逐个守护 ----
	{ defect: 1, suite: "defect-regression.mjs", marker: /D1 / },
	{ defect: 2, suite: "defect-regression.mjs", marker: /D2 / },
	{ defect: 3, suite: "defect-regression.mjs", marker: /D3 / },
	{ defect: 4, suite: "defect-regression.mjs", marker: /D4 / },
	{ defect: 5, suite: "defect-regression.mjs", marker: /D5 / },
	{ defect: 6, suite: "defect-regression.mjs", marker: /D6 / },
	{ defect: 7, suite: "defect-regression.mjs", marker: /D7 / },
	{ defect: 8, suite: "defect-regression.mjs", marker: /D8 / },
	{ defect: 9, suite: "defect-regression.mjs", marker: /D9 / },
	{ defect: 10, suite: "defect-regression.mjs", marker: /D10 / },
	{ defect: 11, suite: "defect-regression.mjs", marker: /D11 / },
	{ defect: 12, suite: "backtick-precision.mjs", marker: /反引号|backtick/i },
	{ defect: 13, suite: "backtick-precision.mjs", marker: /行内|inline/i },
	{ defect: 14, suite: "defect-regression.mjs", marker: /D14 / },
	{ defect: 15, suite: "defect-regression.mjs", marker: /D15 / },
	{ defect: 16, suite: "defect-regression.mjs", marker: /D16 / },
	{ defect: 17, suite: "defect-regression.mjs", marker: /D17 / },
	{ defect: 18, suite: "defect-regression.mjs", marker: /D18 / },
	{ defect: 19, suite: "defect-regression.mjs", marker: /D19 / },
	{ defect: 20, suite: "defect-regression.mjs", marker: /D20 / },
	{ defect: 21, suite: "defect-regression.mjs", marker: /D21 / },
	{ defect: 22, suite: "defect-regression.mjs", marker: /D22 / },
	{ defect: 23, suite: "defect-regression.mjs", marker: /null chunk/ },
	{ defect: 24, suite: "defect-regression.mjs", marker: /D24 / },
	{ defect: 25, suite: "defect-regression.mjs", marker: /D25 / },
	{ defect: 26, suite: "defect-regression.mjs", marker: /D26 / },
	{ defect: 27, suite: "defect-regression.mjs", marker: /D27 / },
	{ defect: 28, suite: "defect-regression.mjs", marker: /D28 / },
	{ defect: 29, suite: "defect-regression.mjs", marker: /D29 / },
	{ defect: 30, suite: "defect-regression.mjs", marker: /D30 / },
	{ defect: 31, suite: "doc-consistency.mjs", marker: /一致性|consisten/i },
	{ defect: 32, suite: "code-quality.mjs", marker: /module|@module/i },

	// ---- 交付质量缺陷（D33-D39）：由各自的专门套件守护 ----
	{ defect: 33, suite: "install-experience.mjs", marker: /UTF-8 BOM/ },
	{ defect: 34, suite: "install-experience.mjs", marker: /安装脚本运行成功/ },
	{ defect: 35, suite: "install-experience.mjs", marker: /存在 LICENSE 文件/ },
	{ defect: 36, suite: "doc-executable.mjs", marker: /barePlaceholder|裸\s*<>/ },
	{ defect: 37, suite: "ref-verifiable.mjs", marker: /invariant\.js|KNOWN_MISSING/ },
	{ defect: 38, suite: "fake-test-audit.mjs", marker: /real-samples/ },
	{ defect: 39, suite: "fake-test-audit.mjs", marker: /audit-rewrites/ },
	{ defect: 40, suite: "doc-structure.mjs", marker: /章节编号|section numbering/i },
	{ defect: 41, suite: "doc-structure.mjs", marker: /诚实标注|UNREPRODUCIBLE/i },
	{ defect: 42, suite: "passthrough-design.mjs", marker: /declared\.size === 0|直通/i },
	{ defect: 43, suite: "code-quality.mjs", marker: /无死代码|dead code/i },
	{ defect: 44, suite: "code-quality.mjs", marker: /测量工具自检|findFunctions 在已知答案/ },
	{ defect: 45, suite: "doc-consistency.mjs", marker: /精确等于套件总数|必须精确相等/ },
	{ defect: 46, suite: "doc-structure.mjs", marker: /缺陷表每行都是 5 列|表格结构完整性/ },
	{ defect: 47, suite: "doc-structure.mjs", marker: /所有 Markdown 表格列数一致|所有表格的列数一致性/ },
	{ defect: 48, suite: "doc-structure.mjs", marker: /中英文缺陷表对等|中英文缺陷数量一致/ },
	{ defect: 49, suite: "doc-consistency.mjs", marker: /历史记录数值自洽|声称 - 实际 = 漂移/ },
	{ defect: 50, suite: "doc-consistency.mjs", marker: /当前声明与实际一致|剔除历史引用/ },
	{ defect: 51, suite: "doc-consistency.mjs", marker: /套件数声明准确|所有「N 个套件」声明/ },
	{ defect: 52, suite: "doc-consistency.mjs", marker: /性能数字与实测同量级|性能基线套件存在/ },
	{ defect: 53, suite: "race-conditions.mjs", marker: /真正的 LRU 语义|区分 LRU 与 FIFO/ },
	{ defect: 54, suite: "uncovered-functions.mjs", marker: /propertiesOf|safeJsonParse/ },
	{ defect: 55, suite: "uncovered-functions.mjs", marker: /合法 JSON|强转/ },
	{ defect: 56, suite: "path-consistency.mjs", marker: /四条路径一致性|所有路径类型一致/ },
	{ defect: 57, suite: "path-consistency.mjs", marker: /ordinal 生效|内容相同/ },
	{ defect: 58, suite: "doc-consistency.mjs", marker: /运行模式表格的套件数|静态计算/ },
	{ defect: 59, suite: "doc-structure.mjs", marker: /换行符一致|所有 Markdown 文件都只用 LF/ },
	{ defect: 60, suite: "doc-consistency.mjs", marker: /PASTE-READY 与主材料同步|逐字一致/ },
	{ defect: 61, suite: "ref-verifiable.mjs", marker: /无法核实的引用|KNOWN_UNVERIFIABLE|材料引用可核实性/ },
	{ defect: 62, suite: "deliverable.mjs", marker: /提醒「装完必须重启」|SUBMIT-GUIDE 可执行性/ },
	{ defect: 63, suite: "deliverable.mjs", marker: /git 可提交性|草稿文件不会被提交/ },
	{ defect: 64, suite: "install-failure-paths.mjs", marker: /安装失败场景|profile 目录不存在/ },
	{ defect: 65, suite: "known-limits-accuracy.mjs", marker: /已知限制真实性|已知限制章节的完整性/ },
	{ defect: 66, suite: "uninstall-flow.mjs", marker: /卸载流程|README 步骤 1/ },
	{ defect: 67, suite: "doc-consistency.mjs", marker: /README 内部数字一致|内部数字检查/ },
	{ defect: 68, suite: "doc-consistency.mjs", marker: /README 内部数字一致|内部数字检查|INTERNAL_DOCS/ },
	{ defect: 69, suite: "doc-structure.mjs", marker: /所有交付物文档的基础结构/ },
	{ defect: 70, suite: "doc-structure.mjs", marker: /表格行之间不得夹空行/ },
	{ defect: 71, suite: "doc-structure.mjs", marker: /Markdown 渲染健康度/ },
	{ defect: 72, suite: "ref-verifiable.mjs", marker: /文档引用的仓库文件路径|仓库文件路径/ },
	{ defect: 73, suite: "meta-health.mjs", marker: /关键套件的变异验证证据|VERIFIED/ },
	{ defect: 74, suite: "recovered-ab-consistency.mjs", marker: /恢复调用的 A\/B 一致性|delta 与 block-end/ },
	{ defect: 75, suite: "known-limits-accuracy.mjs", marker: /写明支持的 3 类标记|只解析 3 类标记/ },
	{ defect: 76, suite: "package-contract.mjs", marker: /package.json 与 npm 打包契约|开源元数据/ },
	{ defect: 77, suite: "package-contract.mjs", marker: /engines 与 README 的 Node 要求一致|engines/ },
	{ defect: 78, suite: "deliverable.mjs", marker: /占位符与填写说明|每个占位符都在 SUBMIT-GUIDE/ },
	{ defect: 79, suite: "claims-audit.mjs", marker: /互斥分类之和等于声明的总数|算术自洽/ },
	{ defect: 80, suite: "doc-consistency.mjs", marker: /运行模式的耗时关系|耗时 quick < offline < full/ },
	{ defect: 81, suite: "doc-consistency.mjs", marker: /会增长的数字必须标明快照|所有会增长的数字都标明了/ },
	{ defect: 82, suite: "fake-test-audit.mjs", marker: /恒真断言|无恒真断言/ },
	{ defect: 83, suite: "meta-health.mjs", marker: /永不失败的套件|永不失败的剖析工具/ },
	{ defect: 84, suite: "doc-structure.mjs", marker: /真实解析规则验证|真实表格/ },
	{ defect: 85, suite: "meta-health.mjs", marker: /本地测试副本与 asar 一致|asar 一致/ },
	{ defect: 86, suite: "invariant-conformance.mjs", marker: /宿主真实校验器符合性|宿主校验器自检|从 invariant\.js 源码提取/ },
	{ defect: 87, suite: "invariant-conformance.mjs", marker: /从 invariant\.js 源码提取|宿主校验器自检|R10/ },
	{ defect: 88, suite: "health-check.mjs", marker: /HOST_VALIDATOR|validateHandWritten|宿主真实校验器/ },
	{ defect: 89, suite: "runtime-process-check.mjs", marker: /运行实例进程级验证|dsh host 进程/ },
	{ defect: 90, suite: "deliverable.mjs", marker: /Top-Down 可达性|30 秒摘要/ },
	{ defect: 91, suite: "deliverable.mjs", marker: /内部锚点链接可达性|所有内部锚点链接都能跳转/ },
	{ defect: 92, suite: "package-contract.mjs", marker: /npm 发布意图明确|private 为 true/ },
	{ defect: 93, suite: "deliverable.mjs", marker: /安装脚本的编码安全|显式指定 UTF-8 读写/ },
	{ defect: 94, suite: "deliverable.mjs", marker: /带 UTF-8 BOM|PowerShell 5.1 能正确解析脚本/ },
	{ defect: 95, suite: "deliverable.mjs", marker: /错误路径与友好提示|可操作的处理建议/ },
	{ defect: 96, suite: "deliverable.mjs", marker: /特殊路径与备份轮转|备份数量受控/ },
	{ defect: 97, suite: "deliverable.mjs", marker: /手动安装路径与脚本等价|手动步骤提到/ },
	{ defect: 98, suite: "env-disable-semantics.mjs", marker: /环境变量禁用语义|只认精确的字符串/ },
	{ defect: 99, suite: "uninstall-flow.mjs", marker: /从备份恢复|备份恢复/ },
	{ defect: 100, suite: "doc-structure.mjs", marker: /每个文档的代码围栏都成对|围栏行总数/ },
	{ defect: 101, suite: "streak-resolution.mjs", marker: /连续空响应计数与状态隔离|缺陷 101 的回归断言/ },
	{ defect: 102, suite: "memory-lifecycle.mjs", marker: /直接数条目|LRU 条目数不超过 64/ },
	{ defect: 103, suite: "threshold-audit.mjs", marker: /阈值宽容量审计|比实测宽 10 倍/ },
	{ defect: 104, suite: "threshold-audit.mjs", marker: /时间类断言必须有可解释性|耗时断言都可解释/ },
	{ defect: 105, suite: "meta-health.mjs", marker: /try.finally 保证还原|try.finally 保护/ },
	{ defect: 106, suite: "meta-health.mjs", marker: /run-all 的判定逻辑不能掩盖失败|catch 分支不设 ok/ },
	{ defect: 107, suite: "doc-consistency.mjs", marker: /三种模式覆盖范围不同|覆盖范围不同/ },
	{ defect: 108, suite: "unicode-fidelity.mjs", marker: /中文与换行保真|CRLF 完整保留/ },
	{ defect: 109, suite: "recovered-vs-native.mjs", marker: /恢复 vs 原生等价性|逐字段深度相等/ },
	{ defect: 110, suite: "mixed-native-recovery.mjs", marker: /原生与恢复共存行为|只执行原生调用/ },
	{ defect: 111, suite: "claims-audit.mjs", marker: /层数|套件数/ },
	{ defect: 112, suite: "claims-audit.mjs", marker: /中文数字写的数量声明|会被漏检/ },
	{ defect: 113, suite: "shape-robustness.mjs", marker: /异常形状鲁棒性|typeof text !== string/ },
	{ defect: 114, suite: "shape-robustness.mjs", marker: /恢复逻辑异常时流不中断|recoveryError/ },
	{ defect: 115, suite: "shape-robustness.mjs", marker: /辅助函数都有防御|patchReplayState —|HELPER_GUARDS/ },
	{ defect: 116, suite: "double-registration.mjs", marker: /重复注册行为|个监听器/ },
	{ defect: 117, suite: "double-finish-kind.mjs", marker: /双层 finish.kind 稳定性|finish.kind = tool-calls/ },
	{ defect: 118, suite: "mutation-test.mjs", marker: /KILLED|变异覆盖率/ },
	{ defect: 119, suite: "mutation-test.mjs", marker: /基线|NEEDS_GC/ },
	{ defect: 120, suite: "branch-coverage.mjs", marker: /未覆盖代码块|BASELINE|suiteFailures/ },
	{ defect: 121, suite: "coverage.mjs", marker: /函数覆盖率|suiteFailures|所有函数均被测试执行过/ },
	{ defect: 122, suite: "meta-health.mjs", marker: /子进程调用的 --expose-gc 必须一致|扫描 .* 个运行器/ },
	{ defect: 123, suite: "code-quality.mjs", marker: /无重复代码块|重复代码/ },
	{ defect: 124, suite: "meta-health.mjs", marker: /NEEDS_GC 列表必须覆盖|僵尸条目/ },
	{ defect: 125, suite: "meta-health.mjs", marker: /从共享模块导入 NEEDS_GC|唯一事实源|不再本地重定义/ },
	{ defect: 126, suite: "fence-eol-matrix.mjs", marker: /围栏 × 行尾矩阵|围栏后跟真实调用/ },
	{ defect: 127, suite: "antml-prefix-symmetry.mjs", marker: /antml 前缀对称性|antml:function/ },
	{ defect: 128, suite: "path-consistency.mjs", marker: /逐键强转路径|四条路径/ },
	{ defect: 129, suite: "markup-only-completeness.mjs", marker: /纯标记判定完整性|纯标记:/ },
	{ defect: 130, suite: "path-consistency.mjs", marker: /逐键强转|四条路径/ },
	{ defect: 131, suite: "call-form-matrix.mjs", marker: /调用形态矩阵|Qwen 裸形态/ },
	{ defect: 132, suite: "known-limit-outcomes.mjs", marker: /已知限制一致性|不含已知标记/ },
	{ defect: 133, suite: "doc-consistency.mjs", marker: /文档数字一致性|各文档层数表述一致/ },
	{ defect: 134, suite: "doc-consistency.mjs", marker: /文档数字一致性|层数/ },
	{ defect: 135, suite: "claims-audit.mjs", marker: /测试矩阵真实性|实跑核查/ },
	{ defect: 136, suite: "meta-health.mjs", marker: /章节编号必须连续|编号连续且无重复/ },
	{ defect: 137, suite: "meta-health.mjs", marker: /头部注释里的「N 项」|头部「N 项」自述/ },
	{ defect: 138, suite: "meta-health.mjs", marker: /child_process 函数必须 import|所有用到的 child_process 函数都已 import/ },
	{ defect: 139, suite: "deliverable.mjs", marker: /非官方项目|Unofficial project/ },
	{ defect: 140, suite: "manual-install-order.mjs", marker: /手动安装流程可执行性|先备份/ },
	{ defect: 141, suite: "uninstall-completeness.mjs", marker: /卸载完整性|两步都要做/ },
	{ defect: 142, suite: "uninstall-completeness.mjs", marker: /卸载完整性|Remove-Item/ },
	{ defect: 143, suite: "doc-consistency.mjs", marker: /层数|文档数字一致性/ },
	{ defect: 144, suite: "doc-structure.mjs", marker: /有序列表的编号必须连续|有序列表编号连续/ },
	{ defect: 145, suite: "deliverable.mjs", marker: /缺陷 145|全新克隆/ },
	{ defect: 146, suite: "coverage.mjs", marker: /缺陷 146|pathToFileURL/ },
	{ defect: 147, suite: "meta-health.mjs", marker: /个人绝对路径|personalPathRe/ },
	{ defect: 148, suite: "meta-health.mjs", marker: /个人绝对路径|personalPathRe/ },
	{ defect: 148, suite: "deliverable.mjs", marker: /PATH_PLACEHOLDERS|待填占位符/ },
	{ defect: 149, suite: "meta-health.mjs", marker: /TIMEOUT|区分「超时」/ },
	{ defect: 150, suite: "meta-health.mjs", marker: /hasSubstance|无输出/ },
	{ defect: 151, suite: "meta-health.mjs", marker: /SUSPECT|claimsFailure/ },
	{ defect: 152, suite: "meta-health.mjs", marker: /零样本|零样本.*失败/ },
	{ defect: 153, suite: "meta-health.mjs", marker: /样本守卫|上界断言/ },
	{ defect: 154, suite: "meta-health.mjs", marker: /插件行为套件|变异测试的套件清单/ },
	{ defect: 155, suite: "meta-health.mjs", marker: /asar 可解析|pickle/ },
	{ defect: 156, suite: "meta-health.mjs", marker: /maxBuffer|64 \* 1024/ },
	{ defect: 157, suite: "meta-health.mjs", marker: /结构化|JSON.parse/ },
	{ defect: 158, suite: "meta-health.mjs", marker: /lib-lock|持锁/ },
	{ defect: 159, suite: "meta-health.mjs", marker: /崩溃自愈|ORIG_BACKUP/ },
	{ defect: 160, suite: "meta-health.mjs", marker: /DSH_LOG_MAX_MB|体积守卫|超大会话/ },
	{ defect: 161, suite: "meta-health.mjs", marker: /max-old-space-size|堆上限/ },
	{ defect: 162, suite: "meta-health.mjs", marker: /重试|retry/ },
	{ defect: 163, suite: "deliverable.mjs", marker: /合成样本|synthetic/ },
	{ defect: 164, suite: "package-contract.mjs", marker: /zhaozehao10|scope/ },
	{ defect: 165, suite: "deploy-verify.mjs", marker: /sameContent|normalizeEol/ },
	{ defect: 166, suite: "deliverable.mjs", marker: /不占用任何官方 scope|official scope/ },
	{ defect: 167, suite: "meta-health.mjs", marker: /pickle 变体|\+4 或 \+5|两种合法/ },
];

// 验证：每个缺陷恰好有一个守护
const guarded = new Set(GUARDS.map((g) => g.defect));
const unguarded = defects.filter((d) => !guarded.has(d.n));
console.log(`  守护条目: ${GUARDS.length} 个`);
console.log(`  未守护的缺陷: ${unguarded.length === 0 ? "无 ✅" : unguarded.map((d) => `D${d.n}`).join(", ")}`);
ck("每个缺陷都有守护套件", unguarded.length === 0, unguarded.map((d) => `D${d.n} ${d.title}`).join("; "));

// 验证：没有多余条目（指向不存在的缺陷）
const defectNums = new Set(defects.map((d) => d.n));
const extra = GUARDS.filter((g) => !defectNums.has(g.defect));
ck("守护矩阵没有指向不存在的缺陷", extra.length === 0, extra.map((g) => `D${g.defect}`).join(", "));

// ===========================================================================
// 3. 每个守护套件真的存在且包含标记
// ===========================================================================
console.log("\n=== 3. 守护套件验证 ===");
const suiteCache = new Map();
let missingSuite = 0;
let missingMarker = 0;
for (const g of GUARDS) {
	if (!suiteCache.has(g.suite)) {
		const p = path.join(DIR, g.suite);
		suiteCache.set(g.suite, fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
	}
	const src = suiteCache.get(g.suite);
	if (src === null) {
		missingSuite++;
		console.log(`  ❌ D${g.defect}: 套件 ${g.suite} 不存在`);
		continue;
	}
	const ok = g.marker instanceof RegExp ? g.marker.test(src) : src.includes(g.marker);
	if (!ok) {
		missingMarker++;
		console.log(`  ❌ D${g.defect}: ${g.suite} 里找不到标记 ${g.marker}`);
	}
}
ck("所有守护套件都存在", missingSuite === 0, `${missingSuite} 个缺失`);
ck("所有守护套件都含对应标记", missingMarker === 0, `${missingMarker} 个缺标记`);
console.log(`  ${GUARDS.length - missingSuite - missingMarker}/${GUARDS.length} 个守护有效`);

// ===========================================================================
// 4. 汇总：按套件统计守护了多少缺陷
// ===========================================================================
console.log("\n=== 4. 按套件统计 ===");
const bySuite = new Map();
for (const g of GUARDS) {
	if (!bySuite.has(g.suite)) bySuite.set(g.suite, []);
	bySuite.get(g.suite).push(g.defect);
}
const rows = [...bySuite.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [suite, ds] of rows) {
	console.log(`  ${suite.padEnd(30)} ${String(ds.length).padStart(2)} 个缺陷: D${ds.join(", D")}`);
}

// ===========================================================================
// 5. 关键：插件代码类缺陷（D1-D32）必须由自动化断言守护
// ===========================================================================
console.log("\n=== 5. 插件代码缺陷的守护强度 ===");
{
	// **D1-D30 是插件行为缺陷**，必须有运行时断言（喂输入、看输出）。
	// **D31/D32 是静态属性**（文档数字、模块说明位置），由静态检查守护是**正确**的。
	const BEHAVIOR_DEFECTS = Array.from({ length: 30 }, (_, i) => i + 1);
	const STATIC_DEFECTS = [31, 32];

	const behaviorGuards = GUARDS.filter((g) => BEHAVIOR_DEFECTS.includes(g.defect));
	const runtimeGuarded = behaviorGuards.filter(
		(g) => g.suite === "defect-regression.mjs" || g.suite === "backtick-precision.mjs",
	);
	const staticGuards = GUARDS.filter((g) => STATIC_DEFECTS.includes(g.defect));

	console.log(`  D1-D30（插件行为）共 ${BEHAVIOR_DEFECTS.length} 个`);
	console.log(`    有运行时断言守护: ${runtimeGuarded.length} 个`);
	console.log(`  D31-D32（静态属性）共 ${STATIC_DEFECTS.length} 个`);
	console.log(`    由静态检查守护: ${staticGuards.length} 个（合理）`);

	ck("D1-D30 全部有运行时断言守护", runtimeGuarded.length === BEHAVIOR_DEFECTS.length,
		`只有 ${runtimeGuarded.length}/${BEHAVIOR_DEFECTS.length}`);
	ck("D31-D32 由静态检查守护", staticGuards.length === STATIC_DEFECTS.length,
		`${staticGuards.length}/${STATIC_DEFECTS.length}`);
}

console.log(`\n===== 缺陷回归覆盖矩阵: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
