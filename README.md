# my-agent

用 TypeScript 一比一重实现 [MiniCode](../MiniCode)，通过"带注解复刻 + 理解后重写"的方式深入掌握 Agent 原理。

## 学习路径

按六个阶段逐层实现，每阶段完成后都有可验证的里程碑：

| 阶段 | 内容 | 核心知识点 |
|------|------|-----------|
| Phase 1 | 类型系统 + 工具注册表 | K-01 ~ K-05 |
| Phase 2 | Anthropic API 适配器 | K-06 ~ K-09 |
| Phase 3 | Agent Loop（核心主循环）| K-10 ~ K-15 |
| Phase 4 | 12 个工具 + 权限系统 | K-16 ~ K-31 |
| Phase 5 | 上下文压缩 + 会话持久化 | K-32 ~ K-42 |
| Phase 6 | TUI 全屏界面 | K-43 ~ K-52 |

## 文档

- **设计文档：** `docs/superpowers/specs/2026-05-27-minicode-reimplementation-design.md`
- **知识库：** `docs/KNOWLEDGE.md`（52 个知识点，随实现逐步填写）

## 知识点标注约定

代码中用 `// [K-XX]` 标注知识点编号，在 `docs/KNOWLEDGE.md` 中有详细说明。

```ts
const parsed = schema.safeParse(input) // [K-02] Zod 运行时校验
```
