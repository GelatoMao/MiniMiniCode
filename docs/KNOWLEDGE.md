# Agent 原理知识库

> 本文档是 MiniCode TypeScript 重实现过程中积累的知识点详细说明。
> 代码中用 `// [K-XX]` 标注知识点编号，在此对应展开。

---

## 使用方法

- 看代码时遇到 `// [K-XX]`，来这里查阅对应知识点的详细解释
- 知识点按实现阶段分层，可按需跳转

---

## 第一层：类型系统基础

### [K-01] 可辨识联合类型（Discriminated Union）

> 待实现 Phase 1 时填写

### [K-02] Zod 运行时校验

> 待实现 Phase 1 时填写

### [K-03] 注册表模式（Registry Pattern）

> 待实现 Phase 1 时填写

### [K-04] 配置分层加载

> 待实现 Phase 1 时填写

### [K-05] Node.js 路径处理

> 待实现 Phase 1 时填写

---

## 第二层：模型接入

### [K-06] Anthropic Messages API 协议

> 待实现 Phase 2 时填写

### [K-07] 指数退避 + Jitter

> 待实现 Phase 2 时填写

### [K-08] Tool Use 响应解析

> 待实现 Phase 2 时填写

### [K-09] 适配器模式（Adapter Pattern）

> 待实现 Phase 2 时填写

---

## 第三层：Agent 核心

### [K-10] ReAct 框架

> 待实现 Phase 3 时填写

### [K-11] 工具执行与错误收集

> 待实现 Phase 3 时填写

### [K-12] 韧性设计模式（Resilience Patterns）

> 待实现 Phase 3 时填写

### [K-13] Continuation Prompt 工程

> 待实现 Phase 3 时填写

### [K-14] Extended Thinking 跨轮次状态管理

> 待实现 Phase 3 时填写

### [K-15] System Prompt 工程

> 待实现 Phase 3 时填写

---

## 第四层：工具与权限

### [K-16] Node.js fs/promises

> 待实现 Phase 4 时填写

### [K-17] 原子写入（Atomic Write）

> 待实现 Phase 4 时填写

### [K-18] 字符串精确替换策略

> 待实现 Phase 4 时填写

### [K-19] Unified Diff 格式解析与应用

> 待实现 Phase 4 时填写

### [K-20] 多块编辑合并策略

> 待实现 Phase 4 时填写

### [K-21] 递归目录遍历 + gitignore 过滤

> 待实现 Phase 4 时填写

### [K-22] 正则搜索 + 结果截断

> 待实现 Phase 4 时填写

### [K-23] child_process spawn + 超时控制

> 待实现 Phase 4 时填写

### [K-24] fetch + HTML → 纯文本提取

> 待实现 Phase 4 时填写

### [K-25] 搜索 API 封装

> 待实现 Phase 4 时填写

### [K-26] awaitUser 信号机制

> 待实现 Phase 4 时填写

### [K-27] 动态指令注入（Skill 加载）

> 待实现 Phase 4 时填写

### [K-28] 工具注册表组装

> 待实现 Phase 4 时填写

### [K-29] 多维度权限模型

> 待实现 Phase 4 时填写

### [K-30] diff 库可视化 diff

> 待实现 Phase 4 时填写

### [K-31] 后台进程生命周期管理

> 待实现 Phase 4 时填写

---

## 第五层：上下文管理

### [K-32] Token 计数与上下文窗口管理

> 待实现 Phase 5 时填写

### [K-33] 超大输出落盘替换策略

> 待实现 Phase 5 时填写

### [K-34] 四种压缩策略定位

> 待实现 Phase 5 时填写

### [K-35] 安全中段历史移除（Snip Compact）

> 待实现 Phase 5 时填写

### [K-36] LLM 驱动片段摘要（Context Collapse）

> 待实现 Phase 5 时填写

### [K-37] 临界压缩触发策略（Auto Compact）

> 待实现 Phase 5 时填写

### [K-38] 用户主动触发压缩（Manual Compact）

> 待实现 Phase 5 时填写

### [K-39] JSONL 追加写入 + parentUuid 树结构

> 待实现 Phase 5 时填写

### [K-40] 分层指令文件加载（Memory）

> 待实现 Phase 5 时填写

### [K-41] stdio MCP 协议（JSON-RPC + 动态工具注册）

> 待实现 Phase 5 时填写

### [K-42] 本地 Skill 文件发现与加载

> 待实现 Phase 5 时填写

---

## 第六层：终端界面

### [K-43] 终端 UI 状态模型

> 待实现 Phase 6 时填写

### [K-44] ANSI 转义码 + 双缓冲渲染

> 待实现 Phase 6 时填写

### [K-45] 终端 Markdown 渲染

> 待实现 Phase 6 时填写

### [K-46] 虚拟滚动 + CJK 字符宽度计算

> 待实现 Phase 6 时填写

### [K-47] 终端原始字节序列解析

> 待实现 Phase 6 时填写

### [K-48] 光标移动 + 行编辑状态机

> 待实现 Phase 6 时填写

### [K-49] 状态栏 Badge 渲染

> 待实现 Phase 6 时填写

### [K-50] 事件驱动渲染（组件组合）

> 待实现 Phase 6 时填写

### [K-51] raw mode + resize 事件（SIGWINCH）

> 待实现 Phase 6 时填写

### [K-52] 非交互模式降级

> 待实现 Phase 6 时填写
