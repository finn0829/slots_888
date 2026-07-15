# 实施日志 · 后台完善二期（thread-55）

> 目的：每个实施环节对应需求编号，记录过程与决策，供复盘优化实施流程。
> 需求：ADM-5c 玩家交易流水 · SRV-13/ADM-9 对账自检页 · SRV-14/ADM-10 看板告警标记。
> 分支 `adm-5c-9-10-backoffice`（worktree 隔离，基于 main d8c5631）。

## 环节 0 · 盘点与入池（无需求编号）

- 盘点方法：对照 ADM 一期验收标准逐条复查 + 需求池未决问题复盘。发现：ADM-5 验收写了"交易流水"但页面没做（唯一 ✅ 欠账）；审计只有单局手动回放、缺全局对账自检；告警未决问题的前置（看板）已就绪。
- 用户确认范围：①流水 ②自检 ③告警 三项全做，小件（CSV/日期范围/操作者字段）不做，防刷观测继续挂起。
- 事实核查（写需求前先查代码）：transactions 表全类型覆盖（含 bonus_buy 共 8 类）且有 balance_after/ref_spin_id → 对账无需改 schema；game_configs 没存波动率 → 告警 SE 用经验方差现算。
- 入池 + CT-2 v0.3（TxRow/HealthReport/Alert 三类型 + 3 端点），未决问题「实时告警」标记为已兑现。

## 环节 1 · ADM-5c 玩家交易流水

- TDD：3 用例（401/404 · 字段+倒序+余额从流水加得出来 · 分页 25 笔跨两页无重叠）先跑 3 失败再实现。
- 服务端：`GET /api/admin/players/:id/transactions`，一条 SELECT 别名转 camelCase，复用 requireTarget。
- 前端：PlayersPage 行内展开 `TxLedger` 组件（独立分页）；带 ref_spin_id 的行「回放 #N」跳 `#/audit?playerId=&spinId=`——顺手给 AuditPage 加了 spinId 直达（DetailView 本来就按 id 拉取，零成本）。
- 验证：server 93/93 绿；admin tsc 过；Playwright 11/11（含两条对账断言：最新 balanceAfter==当前余额、Σamount==余额−初始额）；截图 adm-m7/players-txledger.png 目检过。
- 踩坑：测试里查余额误用了不存在的 `/api/state`（实际是 `/api/me`）——先 grep 现有路由再写测试能省一轮。

## 环节 2 · SRV-13/ADM-9 对账自检

- TDD：4 用例（401 · 干净数据四项全绿+ops 入账 · 篡改流水金额→不变量+链双抓且定位 txId · 篡改 result_json→抽样回放抓到）先跑 4 失败。
- 实现：把详情端点的回放比对抽成 `replayMatches()` 共用；health-check 逐玩家一次遍历同时算不变量(A)与流水链(B)；抽样(C)=最近 25+随机 25（`WHERE id < cutoff ORDER BY RANDOM()`，总数 ≤50 时自然全量，测试因此确定性）；RTP 对照(D) 纯 SQL JOIN。
- 决策：链校验断点后**以实际值续算**，一处篡改只报一笔而不是淹没后续全部；D 面板只列数字+样本量不下判断（判读交给 SRV-14 的自适应阈值）。
- 前端：HealthPage 四面板红绿徽章；回放不一致的 spin 一键「去回放」（复用环节 1 的 spinId 直达）。
- 验证：server 97/97 绿；Playwright 12/12——含完整篡改闭环：改真库两处 → 三面板全红+定位准确 → 还原 → 复跑恢复全绿；截图 health-allgreen/tampered/jump-mismatch.png 目检过。
- 踩坑：篡改用例要动 dev 库，路径是 `apps/server/data/slots.db` 不是根 `data/`——第一次猜错目录。e2e 里篡改真库必须**带还原步骤**，并复跑自检证明还原成功。

## 环节 3 · SRV-14/ADM-10 看板告警

- TDD：4 用例（少量数据零告警 · 600 局合成 RTP2.0 触发偏差告警 · 单局 1200× 触发大奖告警且不连带其他 · 500 局 RTP1.6 触发玩家告警而 50 局高 RTP 不触发）。合成数据直插 spins 表（告警只读统计口径，不碰 result_json）。
- SE 口径：比值估计量 r̂=ΣW/ΣC 的 delta-method 标准误 `SE²=(Σw²−2r̂Σwc+r̂²Σc²)/(ΣC)²`，一条 SQL 出全部矩；阈值 = 3σ 且 ≥500 局。局与局按独立近似（免费旋转成串会低估 SE），故告警文案明示"运营信号非统计证明"。
- 前端：看板顶告警条（大奖带「回放 spin #N」、玩家带「查其 spin」跳转）；RTP/大奖卡片红标联动；无告警不渲染容器。
- 验证：server 101/101 绿；Playwright 9/9（含"无告警不显示空壳"与清理后消失）；截图 dashboard-alerts.png 目检过。
- 有趣的实测：e2e 合成的 1200× 大奖把 v1 的经验 SE 撑到 ~1.7，3σ 阈值判定偏差不显著、**没有**触发 rtp_deviation——自适应阈值面对长尾诚实地说"样本不够下结论"，行为正确。
- 踩坑：无。

## 环节 4 · 收尾

- 全量验证：engine 65 + server 101 单测绿；两 app tsc 过；仓库九套 e2e **单独跑全部 ALL PASS**。
- 踩坑：九套 e2e 连跑会互相污染（共享 dev 服务与库：配置版本被 e2e:admin 切来切去、自动旋转状态串台），首轮连跑挂了 3 套，单独重跑全过。**复盘点：这批 e2e 脚本设计为独占共享服务，验证时逐套跑，别 for 循环连跑。**
- e2e 副作用清理：e2e-smoke 又把 `undefined/` 下三张误提交截图刷脏、e2e-admin-configs 把主 checkout 的 p0-after 截图刷脏——两处 `git checkout --` 还原（`undefined/` 目录 bug 依旧留给对应线程修）。
- 合并：rebase origin/main 后推送。BACKLOG 三条标 ✅。
