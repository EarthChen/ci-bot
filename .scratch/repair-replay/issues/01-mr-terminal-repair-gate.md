# 01 — MR 终局跳过闸门

**What to build:** 源 MR 已 merge/closed 时，同 MR 新 pipeline 的失败 webhook 不再开修：出队执行前（绿灯短路同一位置）查源 MR state，`merged|closed` 则跳过——不 spawn worker、群通知尾注「源 MR 已合并/关闭，跳过自愈」、审计记录。MR open 或查询失败（fail-open）时行为与现状完全一致。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 源 MR merged → 跳过修复：无 worker spawn，审计记录跳过原因，群通知带尾注
- [x] 源 MR closed → 同上
- [x] 源 MR open → 行为不变（不误杀，照常入队修复）
- [x] MR state 查询失败 → fail-open 放行修复（闸门是省钱优化，不是安全边界）
- [x] 单测覆盖上述四路径
