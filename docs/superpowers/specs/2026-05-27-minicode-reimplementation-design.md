# MiniCode TypeScript 重实现设计文档

**日期：** 2026-05-27  
**目标：** 用 TypeScript 一比一重实现 MiniCode，通过"带注解复刻 + 理解后重写"的方式深入掌握 Agent 原理。  
**参考源码：** `/Users/maolu/Desktop/AI/haha/MiniCode`

---

## 一、项目概述

### 学习目标

- 理解 `模型 → 工具 → 模型` 的 ReAct Agent 主循环原理
- 掌握 LLM Tool Use 协议的完整实现细节
- 理解上下文窗口管理与多种压缩策略
- 了解终端 UI 渲染与 Web UI 渲染的异同
- 通过实现 MCP 协议理解动态工具扩展机制

### 实现方式

**B + C 结合：带注解复刻 + 理解后重写**

- 代码内用 `// [K-XX]` 标注知识点编号
- 每个知识点在 `docs/KNOWLEDGE.md` 中有详细展开
- 理解设计意图后用自己的方式重写，而非机械抄写

---

## 二、技术选型

| 依赖 | 用途 | 对应知识点 |
|------|------|-----------|
| `zod` | 工具输入的运行时类型校验 | `[K-02]` Schema 驱动的类型安全 |
| `diff` | 文件编辑时生成 diff 预览 | 文本 diff 算法 |
| `tsx` | 直接运行 TS 无需预编译 | Node.js TS 执行模式 |
| Node.js 原生模块 | fs / readline / crypto / path / child_process | `[K-04]` `[K-05]` `[K-23]` |

---

## 三、目录结构

```
my-agent/
├── src/
│   ├── types.ts                    # Phase 1 - 核心类型定义
│   ├── tool.ts                     # Phase 1 - 工具注册表
│   ├── config.ts                   # Phase 1 - 运行时配置
│   │
│   ├── anthropic-adapter.ts        # Phase 2 - Anthropic API 适配器
│   ├── mock-model.ts               # Phase 2 - 离线测试适配器
│   │
│   ├── agent-loop.ts               # Phase 3 - Agent 主循环
│   ├── prompt.ts                   # Phase 3 - 系统 Prompt 构建
│   │
│   ├── tools/                      # Phase 4 - 工具实现（12 个）
│   │   ├── index.ts
│   │   ├── read-file.ts
│   │   ├── write-file.ts
│   │   ├── edit-file.ts
│   │   ├── patch-file.ts
│   │   ├── modify-file.ts
│   │   ├── list-files.ts
│   │   ├── grep-files.ts
│   │   ├── run-command.ts
│   │   ├── web-fetch.ts
│   │   ├── web-search.ts
│   │   ├── ask-user.ts
│   │   └── load-skill.ts
│   ├── permissions.ts              # Phase 4 - 权限系统
│   ├── file-review.ts              # Phase 4 - 文件写入 diff review
│   ├── background-tasks.ts         # Phase 4 - 后台 shell 任务注册表
│   │
│   ├── compact/                    # Phase 5 - 上下文压缩
│   │   ├── auto-compact.ts
│   │   ├── compact.ts
│   │   ├── constants.ts
│   │   ├── context-collapse.ts
│   │   ├── manual-compact.ts
│   │   ├── microcompact.ts
│   │   ├── prompt.ts
│   │   └── snipCompact.ts
│   ├── session.ts                  # Phase 5 - 会话持久化
│   ├── memory.ts                   # Phase 5 - 分层指令加载
│   ├── history.ts                  # Phase 5 - 历史记录
│   ├── utils/                      # Phase 5 - 通用工具
│   │   ├── context.ts
│   │   ├── errors.ts
│   │   ├── model-context.ts
│   │   ├── token-estimator.ts
│   │   ├── tool-result-storage.ts
│   │   └── web.ts
│   ├── mcp.ts                      # Phase 5 - MCP 协议集成
│   ├── mcp-status.ts               # Phase 5 - MCP 状态汇总
│   ├── skills.ts                   # Phase 5 - Skills 扫描加载
│   │
│   ├── tui/                        # Phase 6 - 终端 UI 组件
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── chrome.ts
│   │   ├── input.ts
│   │   ├── input-parser.ts
│   │   ├── markdown.ts
│   │   ├── screen.ts
│   │   └── transcript.ts
│   ├── tty-app.ts                  # Phase 6 - TTY 模式入口
│   ├── ui.ts                       # Phase 6 - Banner / 非 TTY 渲染
│   │
│   ├── cli-commands.ts             # 贯穿各阶段 - Slash 命令处理
│   ├── manage-cli.ts               # 贯穿各阶段 - 管理命令
│   ├── init.ts                     # 贯穿各阶段 - 项目初始化
│   ├── install.ts                  # 贯穿各阶段 - 本地安装
│   ├── workspace.ts                # 贯穿各阶段 - 工作目录感知
│   └── index.ts                    # 主入口（所有阶段完成后串联）
│
├── docs/
│   ├── KNOWLEDGE.md                # 知识点总览索引（52 个知识点）
│   └── superpowers/specs/
│       └── 2026-05-27-minicode-reimplementation-design.md  ← 本文件
├── package.json
└── tsconfig.json
```

---

## 四、六阶段实现计划

### Phase 1：类型系统 + 工具注册表

**目标：** 项目骨架，纯类型定义 + 纯逻辑，无任何 I/O，完成后可写单元测试。

**可验证里程碑：** `ToolRegistry` 能注册工具、执行工具、返回 `ToolResult`，Zod 校验失败时返回错误而非抛异常。

| 任务 | 文件 | 知识点 |
|------|------|--------|
| 1.1 定义所有核心类型 | `src/types.ts` | `[K-01]` 可辨识联合类型 |
| 1.2 实现工具注册表 | `src/tool.ts` | `[K-02]` Zod 运行时校验 / `[K-03]` 注册表模式 |
| 1.3 运行时配置加载 | `src/config.ts` | `[K-04]` 环境变量 + 配置文件分层 |
| 1.4 工作目录感知 | `src/workspace.ts` | `[K-05]` Node.js 路径处理 |

---

### Phase 2：Anthropic API 适配器

**目标：** 实现真实 API 调用，完成后可在终端验证 LLM 能正常响应。

**可验证里程碑：** 直接调用 `adapter.next([{ role: 'user', content: 'hello' }])` 能得到真实 LLM 回复。

| 任务 | 文件 | 知识点 |
|------|------|--------|
| 2.1 消息格式转换 | `src/anthropic-adapter.ts` | `[K-06]` Anthropic Messages API 协议 |
| 2.2 重试机制 | `src/anthropic-adapter.ts` | `[K-07]` 指数退避 + Jitter |
| 2.3 响应解析（Tool Use + Thinking） | `src/anthropic-adapter.ts` | `[K-08]` 响应块解析 |
| 2.4 离线 Mock 适配器 | `src/mock-model.ts` | `[K-09]` 适配器模式 |

---

### Phase 3：Agent Loop（核心主循环）

**目标：** 整个项目的灵魂，`model → tool → model` 反复循环。

**可验证里程碑：** Agent 能自主完成"读取文件 → 分析内容 → 写入结果"的多步任务，无需人工干预。

| 任务 | 文件 | 知识点 |
|------|------|--------|
| 3.1 主循环骨架 | `src/agent-loop.ts` | `[K-10]` ReAct 框架 |
| 3.2 工具调用顺序执行 | `src/agent-loop.ts` | `[K-11]` 工具执行与错误收集 |
| 3.3 空响应/异常恢复 | `src/agent-loop.ts` | `[K-12]` 韧性设计模式 |
| 3.4 Continuation Prompt | `src/agent-loop.ts` | `[K-13]` 续写提示词工程 |
| 3.5 Thinking Block 跨轮次保留 | `src/agent-loop.ts` | `[K-14]` Extended Thinking 状态管理 |
| 3.6 系统提示词构建 | `src/prompt.ts` | `[K-15]` System Prompt 工程 |

---

### Phase 4：工具层 + 权限系统

**目标：** 实现 12 个工具和完整权限边界，Agent 能真实读写文件、执行命令。

**可验证里程碑：** 在权限提示下，Agent 能完成"读文件 → 修改 → 写回"，危险命令需要用户确认。

| 任务 | 文件 | 知识点 |
|------|------|--------|
| 4.1 文件读取 | `tools/read-file.ts` | `[K-16]` Node.js fs/promises |
| 4.2 文件写入 | `tools/write-file.ts` | `[K-17]` 原子写入（temp → rename）|
| 4.3 文件编辑 | `tools/edit-file.ts` | `[K-18]` 字符串精确替换策略 |
| 4.4 Patch 应用 | `tools/patch-file.ts` | `[K-19]` Unified Diff 格式解析 |
| 4.5 多块编辑 | `tools/modify-file.ts` | `[K-20]` 多块编辑合并策略 |
| 4.6 目录列举 | `tools/list-files.ts` | `[K-21]` 递归遍历 + gitignore 过滤 |
| 4.7 文件搜索 | `tools/grep-files.ts` | `[K-22]` 正则搜索 + 结果截断 |
| 4.8 命令执行 | `tools/run-command.ts` | `[K-23]` child_process spawn + 超时 |
| 4.9 网页抓取 | `tools/web-fetch.ts` | `[K-24]` fetch + HTML → 纯文本 |
| 4.10 网页搜索 | `tools/web-search.ts` | `[K-25]` 搜索 API 封装 |
| 4.11 用户提问 | `tools/ask-user.ts` | `[K-26]` awaitUser 信号机制 |
| 4.12 Skill 加载 | `tools/load-skill.ts` | `[K-27]` 动态指令注入 |
| 4.13 工具注册入口 | `tools/index.ts` | `[K-28]` 工具注册表组装 |
| 4.14 路径/命令/编辑权限 | `permissions.ts` | `[K-29]` 多维度权限模型 |
| 4.15 文件 diff review | `file-review.ts` | `[K-30]` diff 库可视化 diff |
| 4.16 后台任务注册表 | `background-tasks.ts` | `[K-31]` 后台进程生命周期 |

---

### Phase 5：上下文压缩 + 会话持久化

**目标：** 长对话不崩溃，会话能跨进程恢复。

**可验证里程碑：** 超长对话触发自动压缩后仍能继续；重启进程后 `--resume` 能恢复上次会话。

| 任务 | 文件 | 知识点 |
|------|------|--------|
| 5.1 Token 估算器 | `utils/token-estimator.ts` | `[K-32]` Token 计数与上下文窗口管理 |
| 5.2 大工具输出落盘 | `utils/tool-result-storage.ts` | `[K-33]` 超大输出替换策略 |
| 5.3 微压缩 | `compact/microcompact.ts` | `[K-34]` 确定性裁剪（删 progress 消息）|
| 5.4 Snip 压缩 | `compact/snipCompact.ts` | `[K-35]` 安全中段历史移除 |
| 5.5 上下文折叠 | `compact/context-collapse.ts` | `[K-36]` LLM 驱动片段摘要 |
| 5.6 Auto Compact | `compact/auto-compact.ts` | `[K-37]` 临界压缩触发策略 |
| 5.7 Manual Compact | `compact/manual-compact.ts` | `[K-38]` 用户主动触发压缩 |
| 5.8 会话持久化 | `session.ts` | `[K-39]` JSONL 追加写入 + parentUuid 树 |
| 5.9 分层 Memory 加载 | `memory.ts` | `[K-40]` 目录递归向上查找指令文件 |
| 5.10 MCP 协议集成 | `mcp.ts` | `[K-41]` stdio JSON-RPC + 动态工具注册 |
| 5.11 Skills 扫描 | `skills.ts` | `[K-42]` 本地 skill 文件发现与加载 |

---

### Phase 6：TUI 全屏界面

**目标：** 把 Agent 包进全屏终端应用，前端开发者视角：渲染目标从 DOM 变成了终端字符网格。

**可验证里程碑：** 全屏 TUI 启动，输入框能响应键盘、Transcript 区域能滚动，Agent 运行时有状态指示。

| 任务 | 文件 | 知识点 |
|------|------|--------|
| 6.1 TUI 核心类型 | `tui/types.ts` | `[K-43]` 终端 UI 状态模型 |
| 6.2 屏幕渲染引擎 | `tui/screen.ts` | `[K-44]` ANSI 转义码 + 双缓冲渲染 |
| 6.3 Markdown 渲染 | `tui/markdown.ts` | `[K-45]` 终端 Markdown → ANSI 字符串 |
| 6.4 Transcript 组件 | `tui/transcript.ts` | `[K-46]` 虚拟滚动 + CJK 字符宽度计算 |
| 6.5 输入字节解析器 | `tui/input-parser.ts` | `[K-47]` 终端原始字节序列解析 |
| 6.6 输入组件 | `tui/input.ts` | `[K-48]` 光标移动 + 行编辑状态机 |
| 6.7 Chrome 状态栏 | `tui/chrome.ts` | `[K-49]` 状态栏 + 上下文用量 Badge |
| 6.8 TUI 组装 | `tui/index.ts` | `[K-50]` 组件组合 + 事件驱动渲染 |
| 6.9 TTY App 入口 | `tty-app.ts` | `[K-51]` raw mode + resize 事件 |
| 6.10 Banner / 非 TTY 渲染 | `ui.ts` | `[K-52]` 非交互模式降级 |

---

## 五、知识点总览（52 个）

完整知识点详情见 `docs/KNOWLEDGE.md`，本节为索引。

### 第一层：类型系统基础（K-01 ~ K-05）

| 编号 | 知识点 | 一句话摘要 |
|------|--------|-----------|
| K-01 | 可辨识联合类型 | 用 `role` 字段作判别符，TS 自动收窄类型 |
| K-02 | Zod 运行时校验 | 弥合"编译时类型安全"与"运行时未知输入"的断层 |
| K-03 | 注册表模式 | 集中管理对象实例，支持动态查找与扩展 |
| K-04 | 配置分层加载 | 环境变量 > 配置文件 > 默认值，优先级覆盖 |
| K-05 | Node.js 路径处理 | `path.resolve` / `path.relative` 处理跨平台路径 |

### 第二层：模型接入（K-06 ~ K-09）

| 编号 | 知识点 | 一句话摘要 |
|------|--------|-----------|
| K-06 | Anthropic Messages API 协议 | 内部格式 → API 格式的精确映射规则 |
| K-07 | 指数退避 + Jitter | 限流重试时避免"雷群效应"的标准模式 |
| K-08 | Tool Use 响应解析 | 从 content blocks 中提取工具调用和文本 |
| K-09 | 适配器模式 | 用接口隔离 Agent Loop 与具体模型实现 |

### 第三层：Agent 核心（K-10 ~ K-15）

| 编号 | 知识点 | 一句话摘要 |
|------|--------|-----------|
| K-10 | ReAct 框架 | Reason（模型推理）+ Act（工具执行）的反复循环 |
| K-11 | 工具执行与错误收集 | 顺序执行，失败不中断，错误信息反馈给模型 |
| K-12 | 韧性设计模式 | 空响应/pause_turn 自动重试，超限后优雅降级 |
| K-13 | Continuation Prompt | 用精心设计的续写提示驱动模型继续未完成的任务 |
| K-14 | Extended Thinking 状态管理 | Thinking Block 需跨轮次保留才能让模型"接续思考" |
| K-15 | System Prompt 工程 | 动态注入 cwd、权限摘要、工具列表、skills 信息 |

### 第四层：工具与权限（K-16 ~ K-31）

| 编号 | 知识点 | 一句话摘要 |
|------|--------|-----------|
| K-16 | Node.js fs/promises | 异步文件读写，limit/offset 分段读取 |
| K-17 | 原子写入 | temp 文件写入后 rename，防止写入中途崩溃导致文件损坏 |
| K-18 | 字符串精确替换 | old_string → new_string，唯一性校验防止误替换 |
| K-19 | Unified Diff 格式 | `@@` 行号标记 + `+/-` 增删行的标准格式 |
| K-20 | 多块编辑合并 | 多个编辑块按行号从后往前应用，避免偏移量错位 |
| K-21 | 递归遍历 + gitignore | 深度优先遍历，读取 `.gitignore` 规则过滤结果 |
| K-22 | 正则搜索 + 截断 | 跨文件 grep，输出行数超限时截断并提示 |
| K-23 | child_process spawn + 超时 | shell=false 避免注入，SIGTERM 超时控制 |
| K-24 | HTML → 纯文本 | 抓取网页后去除标签，保留结构性文本 |
| K-25 | 搜索 API 封装 | 统一封装不同搜索服务，返回标准化结果 |
| K-26 | awaitUser 信号机制 | 工具返回 `awaitUser: true` 暂停 Agent Loop |
| K-27 | 动态指令注入 | 运行时把 skill 内容注入到 system prompt |
| K-28 | 工具注册表组装 | 合并内置工具 + MCP 工具 + skill 工具 |
| K-29 | 多维度权限模型 | path/command/edit 三维度，四种生命周期 |
| K-30 | diff 可视化 | 用 `diff` 库生成 unified diff 供用户 review |
| K-31 | 后台进程生命周期 | taskId 注册 + 状态追踪 + 进程清理 |

### 第五层：上下文管理（K-32 ~ K-42）

| 编号 | 知识点 | 一句话摘要 |
|------|--------|-----------|
| K-32 | Token 计数与上下文窗口 | provider usage 为主，本地估算为 fallback |
| K-33 | 超大输出落盘 | 工具输出超限时写磁盘，上下文只保留预览 + 路径 |
| K-34 | 四种压缩策略定位 | microcompact → snip → collapse → autoCompact，由轻到重 |
| K-35 | 安全中段历史移除 | 保留系统消息、最近 N 轮、编辑/错误轮次 |
| K-36 | LLM 驱动片段摘要 | 识别可摘要片段，调用 LLM 生成摘要替换原文 |
| K-37 | 临界压缩触发策略 | critical/blocked 两个告警级别触发 autoCompact |
| K-38 | 用户主动压缩 | `/compact` 命令触发，摘要写入 context_summary 消息 |
| K-39 | JSONL 追加写入 | 追加写入无需加锁，compact_boundary 标记恢复起点 |
| K-40 | 分层指令文件加载 | MINI.md / CLAUDE.md 向上目录递归，`@path` 包含 |
| K-41 | stdio MCP 协议 | JSON-RPC over stdin/stdout，动态发现和注册工具 |
| K-42 | Skill 文件发现 | 扫描 `.mini-code/skills` 和兼容的 `.claude/skills` |

### 第六层：终端界面（K-43 ~ K-52）

| 编号 | 知识点 | 一句话摘要 |
|------|--------|-----------|
| K-43 | 终端 UI 状态模型 | AppState 驱动渲染，类比 React 的 state → DOM |
| K-44 | ANSI 转义码 + 双缓冲 | `\x1b[31m` 是终端的"CSS"，双缓冲防闪烁 |
| K-45 | 终端 Markdown 渲染 | 解析 Markdown AST，输出带 ANSI 颜色的字符串 |
| K-46 | 虚拟滚动 + CJK 宽度 | 只渲染可见行，CJK 字符占 2 个终端列宽 |
| K-47 | 终端原始字节序列 | raw mode 下方向键等是多字节序列（`\x1b[A`） |
| K-48 | 行编辑状态机 | 光标位置 + 文本内容，响应字节事件更新状态 |
| K-49 | 状态栏 Badge | 固定行渲染，显示 token 用量、session 信息 |
| K-50 | 事件驱动渲染 | 输入事件 / Agent 事件 → 更新 AppState → 重渲染 |
| K-51 | raw mode + resize 事件 | `process.stdin.setRawMode(true)` + `SIGWINCH` |
| K-52 | 非交互模式降级 | 非 TTY 环境用 readline 替代全屏 TUI |

---

## 六、核心设计决策

### 决策 1：`ChatMessage` 用可辨识联合而非可选字段

**原因：** role 字段作判别符后，TypeScript 能在 if/switch 分支自动收窄类型，消除大量 `as` 类型断言。

### 决策 2：`ModelAdapter` 接口只有一个 `next` 方法

**原因：** Agent Loop 完全不感知底层是哪个 LLM 提供商。切换模型只需换适配器，无需修改循环逻辑。

### 决策 3：四种压缩策略由轻到重，按需触发

**原因：** 每种策略有不同的成本（LLM 调用成本、信息损失）。轻量策略高频执行，重量策略仅在临界时触发，最大化信息保留同时控制成本。

### 决策 4：JSONL 追加写入而非 SQLite

**原因：** 追加写入无需锁，崩溃安全，支持流式读取。会话通过 `parentUuid` 形成树结构，`compact_boundary` 标记压缩边界。

### 决策 5：TUI 不依赖 Ink/React

**原因：** 直接操作 ANSI 转义码，零额外依赖，便于理解终端渲染底层原理。

---

## 七、每个阶段的验收标准

| 阶段 | 验收方式 |
|------|---------|
| Phase 1 | 单元测试：`ToolRegistry.execute` 对合法/非法输入均返回正确结果 |
| Phase 2 | 手动测试：`adapter.next()` 能收到真实 LLM 响应，Mock 能返回预设响应 |
| Phase 3 | 集成测试：Agent 自主完成"读文件 → 分析 → 写结果"多步任务 |
| Phase 4 | 手动测试：危险命令触发权限提示，文件编辑前展示 diff |
| Phase 5 | 手动测试：超长对话自动压缩；`--resume` 恢复上次会话 |
| Phase 6 | 手动测试：全屏 TUI 正常启动，键盘输入、滚动、状态栏均正常 |
