#!/usr/bin/env node
// 根据真实 GitLab MR 生成 ci-bot 本地 e2e 用的 pipeline-failed webhook 载荷。
//
// 真实运行（CIHEAL_GLAB_MODE=real）时 bot 会按 webhook 里的 project.web_url + sha
// 去拉取该 MR 的代码并跑测试，因此这里用 glab 取真实 project id / 源分支 / head SHA /
// 关联 pipeline，确保 webhook 指向真实可克隆的目标。
//
// 用法：
//   node scripts/gen-webhook.mjs https://git.wemomo.com/ultron/ultron-guild/-/merge_requests/303
//   node scripts/gen-webhook.mjs ultron/ultron-guild!303
//   node scripts/gen-webhook.mjs --repo ultron/ultron-guild --mr 303
//   node scripts/gen-webhook.mjs ultron/ultron-guild!303 --out /tmp/w.json
//   node scripts/gen-webhook.mjs ultron/ultron-guild!303 --send          # 生成并直接 POST 到本地 bot
//
// 可选参数：
//   --hostname git.wemomo.com   目标 GitLab 实例（默认 git.wemomo.com）
//   --pipeline <id>             指定使用哪个 pipeline（默认：优先 failed，否则取最新）
//   --send                      生成后直接 POST 到 http://localhost:$CI_BOT_PORT/webhook
//
// 依赖：本地 glab 已登录目标实例（glab auth login --hostname <host>）。

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
let repo,
	mr,
	hostname = "git.wemomo.com";
let out = "deploy/webhook-example.json",
	send = false,
	pipelineOverride;
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a.startsWith("--repo=")) repo = a.slice(7);
	else if (a === "--repo") repo = args[++i];
	else if (a.startsWith("--mr=")) mr = a.slice(5);
	else if (a === "--mr") mr = args[++i];
	else if (a.startsWith("--hostname=")) hostname = a.slice(11);
	else if (a === "--hostname") hostname = args[++i];
	else if (a.startsWith("--out=")) out = a.slice(6);
	else if (a === "--out") out = args[++i];
	else if (a.startsWith("--pipeline=")) pipelineOverride = a.slice(11);
	else if (a === "--pipeline") pipelineOverride = args[++i];
	else if (a === "--send") send = true;
	else if (/^https?:\/\//.test(a)) {
		const m = a.match(
			/^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/,
		);
		if (!m) {
			console.error("无法解析 GitLab MR URL: " + a);
			process.exit(2);
		}
		hostname = m[1];
		repo = m[2];
		mr = m[3];
	} else if (a.includes("!") && !a.startsWith("-")) [repo, mr] = a.split("!");
}
if (!repo || !mr) {
	console.error(
		"用法:\n" +
			"  node scripts/gen-webhook.mjs https://git.wemomo.com/ultron/ultron-guild/-/merge_requests/303\n" +
			"  node scripts/gen-webhook.mjs <group/project>!303\n" +
			"  node scripts/gen-webhook.mjs --repo <group/project> --mr 303",
	);
	process.exit(2);
}
mr = String(mr).replace(/^!/, "");

function glabApi(path) {
	const raw = execFileSync("glab", ["api", "--hostname", hostname, path], {
		encoding: "utf8",
	});
	return JSON.parse(raw);
}

let project, mrData, pipelines;
try {
	const enc = encodeURIComponent(repo);
	project = glabApi(`projects/${enc}`);
	mrData = glabApi(`projects/${enc}/merge_requests/${mr}`);
	pipelines = glabApi(
		`projects/${enc}/merge_requests/${mr}/pipelines?per_page=10`,
	);
} catch (e) {
	const msg = (e.stderr?.toString() ?? e.message ?? "").slice(0, 600);
	console.error(
		`glab 调用失败（项目=${repo} 或 MR !${mr} 不可达 / 未登录 ${hostname}）:\n${msg}`,
	);
	process.exit(1);
}

let chosen;
if (pipelineOverride) {
	chosen = (Array.isArray(pipelines) ? pipelines : []).find(
		(p) => String(p.id) === String(pipelineOverride),
	);
	if (!chosen) {
		console.error(`未找到 pipeline #${pipelineOverride}`);
		process.exit(1);
	}
} else if (Array.isArray(pipelines) && pipelines.length > 0) {
	chosen = pipelines.find((p) => p.status === "failed") ?? pipelines[0];
} else {
	console.error(
		`MR !${mr} 没有关联 pipeline；真实运行需拉取代码，请选择有 pipeline 的 MR，或用 --pipeline 指定。`,
	);
	process.exit(1);
}
const isFailed = chosen.status === "failed";

const payload = {
	object_kind: "pipeline",
	object_attributes: {
		id: chosen.id,
		iid: Number(mrData.iid),
		ref: chosen.ref ?? mrData.source_branch,
		tag: false,
		sha: chosen.sha ?? mrData.sha,
		before_sha: "0000000000000000000000000000000000000000",
		status: "failed",
		stages: ["build", "test"],
		source: "merge_request_event",
	},
	project: {
		id: project.id,
		name: project.name,
		path_with_namespace: project.path_with_namespace,
		web_url: project.web_url,
		git_http_url: project.http_url_to_repo,
		namespace: project.namespace?.path ?? repo.split("/")[0],
	},
	user: {
		id: mrData.author?.id ?? 0,
		name: mrData.author?.name ?? "unknown",
		username: mrData.author?.username ?? "unknown",
	},
	commit: {
		id: chosen.sha ?? mrData.sha,
		message: mrData.title ?? "",
		title: mrData.title ?? "",
	},
	builds: [
		{
			id: 1,
			stage: "test",
			name: "unit-test",
			status: "failed",
			allow_failure: false,
		},
	],
};

const json = JSON.stringify(payload, null, 2) + "\n";
writeFileSync(resolve(out), json);
console.error(`已生成 webhook -> ${out}`);
console.error(`  project : ${project.path_with_namespace} (id=${project.id})`);
console.error(
	`  MR !${mrData.iid} [${mrData.state}]  源分支=${mrData.source_branch}  head=${(mrData.sha ?? "").slice(0, 12)}`,
);
console.error(
	`  pipeline: #${chosen.id} status=${chosen.status}${isFailed ? "" : "  ⚠ 非 failed，已按 failed 模拟"}`,
);
console.error(
	`  发送    : GITLAB_WEBHOOK_SECRET=$GITLAB_WEBHOOK_SECRET bash scripts/send-webhook.sh ${out}`,
);

if (send) {
	const secret = process.env.GITLAB_WEBHOOK_SECRET ?? "testsecret";
	const port = process.env.CI_BOT_PORT ?? "8080";
	const res = await fetch(`http://localhost:${port}/webhook`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Gitlab-Token": secret },
		body: json,
	});
	const text = await res.text();
	console.error(`POST /webhook -> ${res.status} ${text}`);
} else {
	process.stdout.write(json);
}
