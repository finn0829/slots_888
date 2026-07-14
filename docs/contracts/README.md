# 跨端契约（Contracts）

三端（游戏前端 / 管理后台 / 后端）+ 引擎并行开发的**唯一真相源**。任何 agent 开工前必读所属契约。

| 文件 | 契约 | 生产者 → 消费者 |
|---|---|---|
| `CT-1-spin-result.md` | SpinResult 数据结构 | engine → server / web / admin(回放) |
| `CT-2-api.md` | HTTP API | server → web / admin |
| `CT-3-db-schema.md` | 数据库 Schema | server 内部（admin 只经 API 访问） |
| `CT-4-design-tokens.md` | 设计 Token 与视觉规格 | design → web / admin |

## 变更纪律

1. **先改契约，再改实现**：任何 agent 需要变更接口/结构，必须先修改本目录对应文件（并在文件头的变更记录里加一行），再动代码。
2. 其余 agent 以契约文件为准，不以别的 agent 的代码为准。
3. **engine 是唯一数学真相源**：server/web/admin 不得复制任何判定逻辑；回放一律调 engine 纯函数重放。
4. 金额一律为**整数（单位：文）**，禁止浮点金额；倍数可为浮点。

## 当前状态

全部为 **v0.1 草案**——ENG-1 数学调参可能微调字段（如免费旋转再触发规则），届时按上述纪律更新。
