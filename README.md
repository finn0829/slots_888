# 雀胡 · 麻将 Slots（slots888）

麻将主题的消除下落式 slots demo：6×5 盘面、全盘计数、服务端权威判定、可审计。
需求池见 `docs/BACKLOG.md`，跨端契约见 `docs/contracts/`（先改契约再改代码）。

## 运行

### 方式一：Docker（推荐，换机器零配置）

```bash
docker compose up
```

### 方式二：本机直跑

```bash
npm install
npm run dev
```

两种方式端口一致：

| 端口 | 服务 |
|---|---|
| 8788 | server API（`/healthz` 探活） |
| 8789 | web 游戏前端 |
| 8790 | admin 管理后台 |

## 常用命令

```bash
npm run test        # 全仓单测
npm run typecheck   # 全仓类型检查
npm run simulate    # 引擎蒙特卡洛模拟器（ENG-1 起可用）
```

## 结构

```
packages/engine   纯 TS 数学引擎（唯一真相源，零 DOM/IO 依赖）
apps/server       Fastify + SQLite，服务端权威结算
apps/web          原生 TS + Canvas 游戏前端
apps/admin        React 管理后台（RTP 配置/看板/审计）
docs/contracts    跨端契约 CT-1~4
docs/design       设计 token 与牌面画廊
```
