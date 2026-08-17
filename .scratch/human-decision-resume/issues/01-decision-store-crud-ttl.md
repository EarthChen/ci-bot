# 01 — DecisionStore CRUD + TTL sweep

**What to build:** 决策状态可持久化存储、查询、TTL 过期自动清扫；bot 重启后 pending 决策仍在。这是所有后续 ticket 的状态基础。

**Blocked by:** None — can start immediately

**Status:** done (commit db437d6)

- [ ] SQLite 独立 db 文件（DATA_ROOT 下），WAL 模式，表结构包含 decision_id/pipeline_id/project_id/event_json/cwd_path/session_path/branch/status/created_at/expires_at/decided_by/decision_value/remark/decided_at
- [ ] CRUD 操作：create / get / update status / list by status / list by project_id
- [ ] TTL sweep：删除 expires_at < now 的 awaiting_decision 记录，返回被清扫的 decision_id 列表
- [ ] 并发写入安全（WAL + 事务）
- [ ] 路径解析函数 resolveDecisionDbPath() 加入 config/paths.ts
- [ ] unit test：内存 SQLite，覆盖 CRUD/TTL/并发
