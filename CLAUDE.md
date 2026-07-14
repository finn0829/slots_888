# 雀胡 · 麻将 Slots — 开发约定

## 项目速览

麻将主题的消除下落式 slots（虚拟币 demo）：6×5 盘面、全盘计数（同牌 ≥8 即赔）、消除下落连锁、服务端权威判定、可审计。

```
packages/engine   纯 TS 数学引擎（唯一真相源，零 DOM/IO 依赖）
apps/server       Fastify + SQLite，服务端权威结算
apps/web          原生 TS + Canvas 游戏前端
apps/admin        React 管理后台（配置/看板/审计）
docs/contracts    跨端契约 CT-1~4 ← 改接口前必读
docs/BACKLOG.md   需求池（按工作流切分，标注优先级与验收标准）
docs/reports/     数学调参报告、设计审计报告
```

运行：`npm run dev`（8788 API / 8789 游戏 / 8790 后台，管理密码见 `SLOTS_ADMIN_PASSWORD`，默认 `admin888`）或 `docker compose up`。

## 工作流铁律

### 1. 不确定就停下来问

拿不准需求、参数或设计时，**停下来同步疑惑点**，不做静默假设。契约会被多个 agent 消费，错误决定传播成本很高。起草契约/参数时，把"我替你默认了 X"显式列出来交用户确认。

### 2. 实施需求先起 worktree + 需求分支

任何需求实施前先 `EnterWorktree`，并切到以需求编号命名的分支（如 `eng-6b-ante-math`、`web-14-history`）。主 checkout 可能有其他线程的 WIP，直接在上面改会冲突。

### 3. 契约先行

要改跨端接口/数据结构，**先改 `docs/contracts/` 并声明变更，再动代码**。其余工作流以契约文件为准，不以别人的代码为准。

- `CT-1` SpinResult 结构 · `CT-2` HTTP API · `CT-3` DB Schema · `CT-4` 设计 Token
- **engine 是唯一数学真相源**：server/web/admin 不得复制任何判定逻辑；回放一律调 engine 纯函数重放。
- 金额一律**整数（单位：文）**，禁止浮点金额；倍数可为浮点。

### 4. TDD

先写测试、**亲眼看它失败**、再写实现。跳过"看它失败"这一步就等于没测。

### 5. 每一步都要有自己的验证过程

不能只靠 typecheck 和单测就宣称完成——必须**真跑起来观察行为**：

- 前端改动 → Playwright 真开浏览器点一遍（`npm run e2e` / `e2e:features` / `e2e:stats` / `e2e:admin`），截图目检
- 数学改动 → 跑模拟器出数据，报告实测值与误差
- 报告结果要诚实：测试失败就说失败并贴输出，跳过了就说跳过

> 血泪教训：配置发布/回滚曾在 16 个服务端测试全绿的情况下，在浏览器里**完全失效**（Fastify 拒绝"声明了 JSON 但 body 为空"的 POST，而 `inject` 测试不带 content-type 恰好绕过）。只有真开浏览器才暴露得出来。

## 领域特有的坑

### 概率诚实原则（红线）

**禁止隐藏动态 RTP**——连败暗中放水属黑模式，且会被自家审计曲线暴露。连败留存一律用透明机制：Ante Bet、骰子收集保底、经济缓冲、真实近失演出。规则页对玩家公示 RTP，战绩页让玩家能自行验证。

### 数学调参：直测 RTP 的噪声极大

免费旋转贡献 ~66% 的赢奖，但 ~150 局才触发一次，单次价值长尾（封顶 5000×）。**直接蒙特卡洛 2M 次的标准误差有 ±3~4%，比要调的参数效应还大**——同一套配置两次测量能差 3.5 个百分点。

调参必须用 `packages/engine/src/analyze.ts`（方差缩减分析器）：把 RTP 拆成「基础局 RTP + 触发率 × E[单段免费旋转价值]（+保底通道）」，各自用最省样本的方式估计再解析合成，误差可降到 ±1.5% 以内。

**触发概率对骰子权重高度敏感**（需要 4 个骰子同时出现，近似四次方效应）——权重 ×2 会让触发率涨约 **8.8 倍**（1/152 → 1/17）。别凭直觉调；触发率可用 `trigger.ts` 的 `freeSpinTriggerRate()` 精确解析计算（二项分布，无采样误差）。

### 其他

- Docker 容器以 root 写 bind mount 会污染宿主机文件属主；compose 已用命名卷隔离 `node_modules` 与 `data`。
- SSH deploy key 放在 repo 内 `.ssh/`（已 gitignore），git 用仓库级 `core.sshCommand` 指向它，不碰 `~/.ssh/config`。
- 不做线上部署——本地运行 + Playwright 验证。
