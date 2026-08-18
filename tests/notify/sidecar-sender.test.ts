import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SidecarGroupSender } from "../../src/notify/sidecar-sender.js";

/**
 * 主进程 fake 模式的钉钉记录 seam。run 6 缺口：fake 模式下主进程用
 * InMemoryDingTalkNotifier，失败播报/转交卡的内容随进程消失，e2e 无法
 * 验证任何通知。SidecarGroupSender 落 jsonl 供审计。
 */
describe("SidecarGroupSender", () => {
	it("sendTo 追加 jsonl 记录（conversationId/title/text/ts）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ciheal-sidecar-"));
		const path = join(dir, "dingtalk-fake.jsonl");
		try {
			const sender = new SidecarGroupSender(path);
			await sender.sendTo("cid-1", { title: "标题", text: "正文" });

			const lines = readFileSync(path, "utf8").trim().split("\n");
			expect(lines).toHaveLength(1);
			const rec = JSON.parse(lines[0]);
			expect(rec.conversationId).toBe("cid-1");
			expect(rec.title).toBe("标题");
			expect(rec.text).toBe("正文");
			expect(typeof rec.ts).toBe("string");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("多次发送追加而非覆盖（一个进程生命周期多张卡片）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ciheal-sidecar-"));
		const path = join(dir, "dingtalk-fake.jsonl");
		try {
			const sender = new SidecarGroupSender(path);
			await sender.sendTo("cid-1", { title: "a", text: "1" });
			await sender.sendTo("cid-2", { title: "b", text: "2" });

			const lines = readFileSync(path, "utf8").trim().split("\n");
			expect(lines).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("父目录不存在时自动创建", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ciheal-sidecar-"));
		const path = join(dir, "nested", "deep", "out.jsonl");
		try {
			const sender = new SidecarGroupSender(path);
			await sender.sendTo("cid-1", { title: "t", text: "x" });
			expect(readFileSync(path, "utf8")).toContain('"cid-1"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
