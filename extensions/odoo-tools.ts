/**
 * Odoo Native Tools Extension for Pi Coding Agent
 * 
 * Replaces odoo-timesheet, odoo-admin-demo, and odoo-admin-prod MCP servers.
 * Pure native execution via odoo_runner.py with zero background daemon.
 * 
 * Features:
 * - odoo_preview_timesheet: Validate & preview timesheet without writing
 * - odoo_sync_timesheet: Push timesheet to Odoo (requires user_confirmed: true)
 * - odoo_list_projects: Search Odoo project IDs
 * - odoo_search_read: Query records from demo or prod Odoo
 * - odoo_read: Read specific record IDs from demo or prod Odoo
 * - odoo_search_count: Count records matching domain
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

interface XmlIdMatch {
	xml_id: string;
	raw_id: string;
	module: string;
	record_type: string;
	view_type?: string;
	model?: string;
	name?: string;
	inherit_id?: string;
	file: string;
	line: number;
}

function extractRecordDetails(fullPath: string, lineNo: number): {
	name?: string;
	model?: string;
	inherit_id?: string;
	view_type?: string;
} {
	try {
		const content = readFileSync(fullPath, "utf8");
		const lines = content.split("\n").slice(Math.max(0, lineNo - 1), lineNo + 30).join("\n");

		const nameMatch = lines.match(/<field\s+name=["']name["'][^>]*>(.*?)<\/field>/s);
		const modelMatch = lines.match(/<field\s+name=["']model["'][^>]*>(.*?)<\/field>/s);
		const inheritMatch = lines.match(/<field\s+name=["']inherit_id["']\s+ref=["']([^"']+)["']/);

		let viewType: string | undefined;
		if (lines.includes("<form")) viewType = "form";
		else if (lines.includes("<list")) viewType = "list";
		else if (lines.includes("<tree")) viewType = "list";
		else if (lines.includes("<kanban")) viewType = "kanban";
		else if (lines.includes("<search")) viewType = "search";
		else if (lines.includes("<calendar")) viewType = "calendar";
		else if (lines.includes("<graph")) viewType = "graph";
		else if (lines.includes("<pivot")) viewType = "pivot";

		return {
			name: nameMatch ? nameMatch[1].trim() : undefined,
			model: modelMatch ? modelMatch[1].trim() : undefined,
			inherit_id: inheritMatch ? inheritMatch[1].trim() : undefined,
			view_type: viewType,
		};
	} catch {
		return {};
	}
}

function scoreXmlMatch(m: XmlIdMatch, query: string): number {
	let score = 0;
	const qLower = query.toLowerCase().trim();
	const rawLower = m.raw_id.toLowerCase();
	const xmlIdLower = m.xml_id.toLowerCase();

	if (rawLower === qLower || xmlIdLower === qLower) score += 100;
	else if (rawLower.startsWith(qLower) || rawLower.endsWith(qLower)) score += 50;
	else if (rawLower.includes(qLower)) score += 30;

	// Prefer base view over inherit view if query does not mention inherit
	if (!qLower.includes("inherit") && !rawLower.includes("inherit")) score += 20;

	// Core canonical modules boost
	if (["base", "sale", "account", "crm", "stock", "purchase", "hr", "project"].includes(m.module)) {
		score += 15;
	}

	return score;
}

function searchOdooXmlIds(params: {
	query: string;
	module?: string;
	record_type?: string;
	limit?: number;
}): XmlIdMatch[] {
	const limit = params.limit || 15;
	const recordType = (params.record_type || "all").toLowerCase();

	const candidateRoots = [
		process.env.ODOO_ADDONS_PATH,
		path.join(process.cwd(), "addons"),
		path.join(process.cwd(), "custom_addons"),
		path.join(process.cwd(), "payroll_addons"),
	].filter(Boolean) as string[];

	const uniqueRoots: string[] = [];
	for (const r of candidateRoots) {
		if (existsSync(r) && !uniqueRoots.includes(r)) {
			uniqueRoots.push(r);
		}
	}

	let searchDirs: string[] = [];
	if (params.module) {
		for (const r of uniqueRoots) {
			const modPath = path.join(r, params.module);
			if (existsSync(modPath)) {
				searchDirs.push(modPath);
			}
		}
	}
	if (searchDirs.length === 0) {
		searchDirs = uniqueRoots;
	}

	const words = params.query.trim().toLowerCase().split(/[\s_.]+/).filter(Boolean);
	if (words.length === 0) return [];

	const rgArgs = [
		"-n", "-g", "*.xml", "-i",
		"<record[^>]+id=\"[^\"]+\"|<menuitem[^>]+id=\"[^\"]+\"|<template[^>]+id=\"[^\"]+\"",
		...searchDirs,
	];

	let output = "";
	try {
		output = execFileSync("rg", rgArgs, {
			maxBuffer: 15 * 1024 * 1024,
			timeout: 6000,
			encoding: "utf8",
		});
	} catch (e: any) {
		if (e.stdout) output = e.stdout.toString();
	}

	const lines = output.split("\n");
	const matches: XmlIdMatch[] = [];

	for (const line of lines) {
		const parts = line.split(":");
		if (parts.length < 3) continue;
		const filepath = parts[0];
		const lineno = parseInt(parts[1], 10);
		const text = parts.slice(2).join(":");

		const combined = (filepath + " " + text).toLowerCase();
		if (!words.every((w) => combined.includes(w))) continue;

		const idMatch = text.match(/id="([^"]+)"/);
		if (!idMatch) continue;
		const rawId = idMatch[1];

		let mod = "unknown";
		for (const r of uniqueRoots) {
			if (filepath.startsWith(r)) {
				const rel = path.relative(r, filepath);
				mod = rel.split(path.sep)[0];
				break;
			}
		}

		const fullXmlId = rawId.includes(".") ? rawId : `${mod}.${rawId}`;

		let recType = "record";
		if (text.includes("<menuitem")) recType = "menuitem";
		else if (text.includes("<template")) recType = "template";
		else {
			const m = text.match(/model="([^"]+)"/);
			if (m) recType = m[1];
		}

		if (recordType !== "all") {
			if (recordType === "view" && !recType.includes("view")) continue;
			if (recordType === "action" && !recType.includes("act_window") && !recType.includes("action")) continue;
			if (recordType === "menu" && recType !== "menuitem") continue;
		}

		let relPath = filepath;
		if (filepath.startsWith("/root/projects/odoo18/")) {
			relPath = path.relative("/root/projects/odoo18", filepath);
		}

		matches.push({
			xml_id: fullXmlId,
			raw_id: rawId,
			module: mod,
			record_type: recType,
			file: relPath,
			line: lineno,
		});

		if (matches.length >= 100) break;
	}

	matches.sort((a, b) => scoreXmlMatch(b, params.query) - scoreXmlMatch(a, params.query));

	const topMatches = matches.slice(0, limit);

	for (const m of topMatches) {
		const fullPath = m.file.startsWith("/") ? m.file : path.join("/root/projects/odoo18", m.file);
		const details = extractRecordDetails(fullPath, m.line);
		if (details.name) m.name = details.name;
		if (details.model) m.model = details.model;
		if (details.inherit_id) m.inherit_id = details.inherit_id;
		if (details.view_type) m.view_type = details.view_type;
	}

	return topMatches;
}

function resolveOdooRunnerPath(): string {
	if (process.env.ODOO_RUNNER_PATH && existsSync(process.env.ODOO_RUNNER_PATH)) {
		return process.env.ODOO_RUNNER_PATH;
	}
	const candidates = [
		path.join(__dirname, "../scripts/odoo_runner.py"),
		path.join(__dirname, "scripts/odoo_runner.py"),
		path.join(__dirname, "odoo_runner.py"),
		path.join(process.cwd(), "scripts/odoo_runner.py"),
	];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return path.join(__dirname, "../scripts/odoo_runner.py");
}

function callOdooRunner(action: string, payload: Record<string, any>): Promise<{ success: boolean; data?: any; error?: string }> {
	return new Promise((resolveResult) => {
		const scriptPath = resolveOdooRunnerPath();
		if (!existsSync(scriptPath)) {
			resolveResult({ success: false, error: `Script tidak ditemukan: ${scriptPath}` });
			return;
		}

		// Operasi deployment, CLI upgrade, dan migrasi modul membutuhkan waktu restart container dan health polling (hingga 120 detik)
		const isHeavyOp = ["deploy_module", "cli_upgrade_module", "upgrade_module"].includes(action);
		const timeoutMs = isHeavyOp ? 120000 : 30000;

		execFile(
			"/usr/bin/python3",
			[scriptPath, action, JSON.stringify(payload)],
			{
				timeout: timeoutMs,
				env: process.env,
			},
			(error, stdout, stderr) => {
				if (error) {
					const isTimeout = (error as any).killed || (error as any).signal === "SIGTERM";
					const timeoutMsg = `Operasi '${action}' melebihi batas waktu (${timeoutMs / 1000}s). Server sedang sibuk merestart container.`;
					resolveResult({
						success: false,
						error: isTimeout ? timeoutMsg : (stderr?.trim() || stdout?.trim() || error.message),
					});
					return;
				}

				try {
					const parsed = JSON.parse(stdout.trim());
					resolveResult(parsed);
				} catch (e: any) {
					resolveResult({
						success: false,
						error: `Gagal parsing output: ${stdout.trim()}`,
					});
				}
			}
		);
	});
}

export default function odooToolsExtension(pi: ExtensionAPI) {
	// Custom message renderer for Odoo cards
	pi.registerMessageRenderer("odoo-tools", (message, { outputPad }, theme) => {
		const details = message.details as { action?: string; target?: string; success?: boolean } | undefined;
		const isSuccess = details?.success !== false;
		const headerColor = isSuccess ? "accent" : "error";
		const headerIcon = isSuccess ? "🟣" : "✗";

		const title = `${theme.fg(headerColor, `${headerIcon} Odoo Tools [${details?.action || "ACTION"}]`)}${details?.target ? ` (${details.target.toUpperCase()})` : ""}\n\n`;
		const body = message.content;

		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${title}${body}`, 0, 0));
		return box;
	});

	// Slash Command: /odoo [search|count|projects]
	pi.registerCommand("odoo", {
		description: "Query Odoo secara langsung (/odoo count <model>, /odoo search <model>, /odoo projects)",
		handler: async (args: string, ctx: any) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase() || "projects";

			if (sub === "projects") {
				const filter = parts[1] || "";
				ctx.ui.notify("Mengambil daftar project Odoo...", "info");
				const res = await callOdooRunner("list_projects", { name_filter: filter });
				if (!res.success) {
					pi.sendMessage({
						customType: "odoo-tools",
						content: `❌ Gagal mengambil project: ${res.error}`,
						display: true,
						details: { action: "PROJECTS", success: false },
					});
					return;
				}

				const formatted = (res.data || [])
					.map((p: any) => `- **${p.name}** (ID: \`${p.id}\`)`)
					.join("\n");

				pi.sendMessage({
					customType: "odoo-tools",
					content: `### 📁 Daftar Project Odoo:\n\n${formatted || "Tidak ada project ditemukan."}`,
					display: true,
					details: { action: "PROJECTS", success: true },
				});
				return;
			}

			if (sub === "count") {
				const model = parts[1] || "res.partner";
				const target = parts[2] || "demo";
				ctx.ui.notify(`Menghitung record ${model} di [${target}]...`, "info");
				const res = await callOdooRunner("search_count", { target, model, domain: [] });

				pi.sendMessage({
					customType: "odoo-tools",
					content: res.success ? `📊 Total record pada model **${model}** [${target}]: **${res.data}** baris.` : `❌ Gagal: ${res.error}`,
					display: true,
					details: { action: "COUNT", target, success: res.success },
				});
				return;
			}

			if (sub === "xmlid") {
				const query = parts.slice(1).join(" ");
				if (!query) {
					ctx.ui.notify("Format: /odoo xmlid <kata kunci view atau ID>", "warning");
					return;
				}
				ctx.ui.notify(`Mencari XML ID \x27${query}\x27...`, "info");
				const results = searchOdooXmlIds({ query, limit: 10 });
				if (results.length === 0) {
					pi.sendMessage({
						customType: "odoo-tools",
						content: `❌ Tidak ditemukan XML ID yang cocok dengan "${query}".`,
						display: true,
						details: { action: "XMLID", success: false },
					});
					return;
				}

				const formatted = results.map((r, i) => {
					let info = `${i + 1}. **\`${r.xml_id}\`**\n   • File: \`${r.file}:${r.line}\`\n   • Type: \`${r.record_type}\`${r.view_type ? ` (${r.view_type})` : ""}`;
					if (r.model) info += `\n   • Model: \`${r.model}\``;
					if (r.name) info += `\n   • Name: "${r.name}"`;
					if (r.inherit_id) info += `\n   • Inherits: \`${r.inherit_id}\``;
					return info;
				}).join("\n\n");

				pi.sendMessage({
					customType: "odoo-tools",
					content: `### 🔍 Hasil Pencarian XML ID untuk "${query}":\n\n${formatted}`,
					display: true,
					details: { action: "XMLID", success: true },
				});
				return;
			}

			if (sub === "fields") {
				const model = parts[1] || "sale.order";
				const target = parts[2] || "demo";
				ctx.ui.notify(`Membaca skema field ${model} di [${target}]...`, "info");
				const res = await callOdooRunner("fields_get", {
					target,
					model,
					attributes: ["type", "string", "relation", "required", "readonly", "selection"],
				});

				if (!res.success) {
					pi.sendMessage({
						customType: "odoo-tools",
						content: `❌ Gagal membaca fields ${model}: ${res.error}`,
						display: true,
						details: { action: "FIELDS", target, success: false },
					});
					return;
				}

				const fieldEntries = Object.entries(res.data || {}).slice(0, 30);
				const formatted = fieldEntries.map(([k, v]) => {
					const flags = [];
					if (v.required) flags.push("required");
					if (v.readonly) flags.push("readonly");
					const flagsStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
					const rel = v.relation ? ` -> ${v.relation}` : "";
					return `- **\`${k}\`** (${v.type}${rel}): ${v.string}${flagsStr}`;
				}).join("\n");

				pi.sendMessage({
					customType: "odoo-tools",
					content: `### 📋 Metadata Fields **${model}** [${target}] (Menampilkan ${fieldEntries.length} dari ${Object.keys(res.data || {}).length} field):\n\n${formatted}`,
					display: true,
					details: { action: "FIELDS", target, success: true },
				});
				return;
			}

			if (sub === "cli-upgrade" || sub === "upgrade-cli") {
				const modules = parts[1];
				const target = parts[2] || "demo";
				if (!modules) {
					ctx.ui.notify("Format: /odoo cli-upgrade <module1,module2> [target]", "error");
					return;
				}
				ctx.ui.notify(`Menjalankan CLI upgrade '${modules}' di [${target}]...`, "info");
				const res = await callOdooRunner("cli_upgrade_module", {
					target,
					modules,
					restart: true,
					user_confirmed: target === "demo",
				});
				if (!res.success) {
					pi.sendMessage({
						customType: "odoo-tools",
						content: `❌ Gagal CLI upgrade ${modules}: ${res.error}`,
						display: true,
						details: { action: "CLI_UPGRADE", target, success: false },
					});
					return;
				}
				pi.sendMessage({
					customType: "odoo-tools",
					content: `✅ **Odoo CLI Upgrade Berhasil!**\n• Modul: \`${res.data.modules}\`\n• Target: **${res.data.target}** (${res.data.database})\n• Host: \`${res.data.host}\`\n• Container: ${res.data.restart_summary}\n• Health: **${res.data.health_check}**`,
					display: true,
					details: { action: "CLI_UPGRADE", target, success: true },
				});
				return;
			}

			ctx.ui.notify("Perintah: /odoo xmlid <query>, /odoo fields <model>, /odoo projects, /odoo count <model>, /odoo cli-upgrade <mod>", "warning");
		},
	});

	// =========================================================================
	// LLM AUTONOMOUS TOOLS
	// =========================================================================

	// Tool 1: odoo_preview_timesheet
	pi.registerTool(
		defineTool({
			name: "odoo_preview_timesheet",
			label: "Odoo Preview Timesheet",
			description:
				"PREVIEW ONLY: Memvalidasi alokasi waktu/task timesheet terhadap project Odoo tanpa menulis ke database. WAJIB dijalankan terlebih dahulu sebelum sync_timesheet untuk verifikasi pengguna. Mendukung target 'demo' (default), 'prod', atau 'payroll'.",
			parameters: Type.Object({
				date_str: Type.String({ description: "Tanggal target format YYYY-MM-DD (contoh: '2026-09-04')" }),
				tasks: Type.Array(
					Type.Object({
						project_name: Type.String({ description: "Nama project di Odoo (contoh: 'Project Alpha' atau 'Common Implementation')" }),
						task_name: Type.String({ description: "Judul fungsional task" }),
						description: Type.String({ description: "Deskripsi pekerjaan non-teknis" }),
						hours: Type.Number({ description: "Durasi kerja dalam jam (contoh: 2.0)" }),
						requestor_person: Type.Optional(Type.String({ description: "Nama person pemohon (opsional)" })),
						requestor_department: Type.Optional(Type.String({ description: "Nama departemen pemohon (opsional)" })),
					})
				),
				target: Type.Optional(Type.String({ description: "Target Odoo: 'demo' (default), 'prod', atau 'payroll'" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const res = await callOdooRunner("preview_timesheet", {
					target: params.target || "demo",
					date_str: params.date_str,
					tasks: params.tasks,
				});

				return {
					content: [{ type: "text", text: res.success ? JSON.stringify(res.data, null, 2) : `Error: ${res.error}` }],
					details: { success: res.success, data: res.data },
				};
			},
		})
	);

	// Tool 2: odoo_sync_timesheet
	pi.registerTool(
		defineTool({
			name: "odoo_sync_timesheet",
			label: "Odoo Sync Timesheet",
			description:
				"Menyimpan entri timesheet ke Odoo secara permanen. HANYA BOLEH DIPANGGIL jika user_confirmed=true (setelah pengguna menyetujui tabel preview). Mendukung target 'demo' (default), 'prod', atau 'payroll'.",
			parameters: Type.Object({
				date_str: Type.String({ description: "Tanggal target format YYYY-MM-DD" }),
				tasks: Type.Array(Type.Object({}, { description: "Daftar task yang disetujui" })),
				user_confirmed: Type.Boolean({ description: "Wajib true: bukti persetujuan eksplisit dari pengguna" }),
				target: Type.Optional(Type.String({ description: "Target Odoo: 'demo' (default), 'prod', atau 'payroll'" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				if (!params.user_confirmed) {
					return {
						content: [{ type: "text", text: "DIBATALKAN: user_confirmed harus bernilai true untuk melakukan penyimpanan permanen ke Odoo." }],
						details: { success: false },
					};
				}

				const res = await callOdooRunner("sync_timesheet", {
					target: params.target || "demo",
					date_str: params.date_str,
					tasks: params.tasks,
					user_confirmed: true,
				});

				return {
					content: [{ type: "text", text: res.success ? JSON.stringify(res.data, null, 2) : `Gagal sync: ${res.error}` }],
					details: { success: res.success, data: res.data },
				};
			},
		})
	);

	// Tool 3: odoo_list_projects
	pi.registerTool(
		defineTool({
			name: "odoo_list_projects",
			label: "Odoo List Projects",
			description: "Mencari nama dan ID project Odoo yang tersedia untuk kebutuhan timesheet atau task. Mendukung target 'demo' (default) atau 'prod'.",
			parameters: Type.Object({
				name_filter: Type.Optional(Type.String({ description: "Filter nama project" })),
				target: Type.Optional(Type.String({ description: "Target Odoo: 'demo' (default) atau 'prod'" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const res = await callOdooRunner("list_projects", {
					name_filter: params.name_filter || "",
					target: params.target || "demo",
				});
				return {
					content: [{ type: "text", text: res.success ? JSON.stringify(res.data, null, 2) : `Error: ${res.error}` }],
					details: { success: res.success, count: res.data?.length },
				};
			},
		})
	);

	// Tool 4: odoo_search_read
	pi.registerTool(
		defineTool({
			name: "odoo_search_read",
			label: "Odoo Search Read (Read-Only)",
			description:
				"Membaca data record dari model Odoo (read-only). Mendukung target 'demo' (default), 'prod', atau 'payroll'.",
			parameters: Type.Object({
				model: Type.String({ description: "Nama model Odoo (contoh: 'res.partner', 'sale.order', 'hr.payslip', 'project.project')" }),
				domain: Type.Optional(Type.Array(Type.Any(), { description: "Filter domain Odoo (contoh: [['is_company', '=', true]])" })),
				fields: Type.Optional(Type.Array(Type.String(), { description: "Daftar nama kolom/field yang ingin diambil" })),
				limit: Type.Optional(Type.Number({ description: "Batas jumlah record (default: 20)" })),
				target: Type.Optional(Type.String({ description: "Target Odoo: 'demo' (default), 'prod', atau 'payroll'" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const res = await callOdooRunner("search_read", {
					target: params.target || "demo",
					model: params.model,
					domain: params.domain || [],
					fields: params.fields,
					limit: params.limit || 20,
				});

				return {
					content: [{ type: "text", text: res.success ? JSON.stringify(res.data, null, 2) : `Error: ${res.error}` }],
					details: { success: res.success, count: res.data?.length },
				};
			},
		})
	);

	// Tool 5: odoo_search_count
	pi.registerTool(
		defineTool({
			name: "odoo_search_count",
			label: "Odoo Search Count",
			description: "Menghitung total record pada model Odoo berdasarkan domain tertentu. Mendukung target 'demo' (default), 'prod', atau 'payroll'.",
			parameters: Type.Object({
				model: Type.String({ description: "Nama model Odoo (contoh: 'res.partner', 'hr.payslip')" }),
				domain: Type.Optional(Type.Array(Type.Any(), { description: "Filter domain Odoo (contoh: [])" })),
				target: Type.Optional(Type.String({ description: "Target Odoo: 'demo' (default), 'prod', atau 'payroll'" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const res = await callOdooRunner("search_count", {
					target: params.target || "demo",
					model: params.model,
					domain: params.domain || [],
				});

				return {
					content: [{ type: "text", text: res.success ? `Total record pada ${params.model}: ${res.data}` : `Error: ${res.error}` }],
					details: { success: res.success, count: res.data },
				};
			},
		})
	);

	// Tool 6: odoo_upgrade_module
	pi.registerTool(
		defineTool({
			name: "odoo_upgrade_module",
			label: "Odoo Upgrade Module",
			description:
				"Meng-upgrade modul Odoo secara resmi (button_immediate_upgrade) via API XML-RPC tanpa perlu skrip sementara atau akses browser. Mendukung target 'demo' (default), 'prod', atau 'payroll'.",
			parameters: Type.Object({
				module_name: Type.String({ description: "Nama teknis modul yang ingin di-upgrade (contoh: 'custom_payroll', 'custom_overtime', 'generic_pdf_sign')" }),
				target: Type.Optional(Type.String({ description: "Target Odoo: 'demo' (default), 'prod', atau 'payroll'" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const res = await callOdooRunner("upgrade_module", {
					target: params.target || "demo",
					module_name: params.module_name,
				});

				return {
					content: [{ type: "text", text: res.success ? `✅ Modul '${params.module_name}' berhasil di-upgrade pada target [${res.data?.target}] (Database: ${res.data?.database}, Module ID: ${res.data?.module_id})` : `❌ Gagal upgrade modul '${params.module_name}': ${res.error}` }],
					details: { success: res.success, data: res.data },
				};
			},
		})
	);

	// Tool 7: odoo_deploy_module
	pi.registerTool(
		defineTool({
			name: "odoo_deploy_module",
			label: "Odoo Deploy Module (End-to-End)",
			description:
				"Mendeploy modul Odoo secara menyeluruh dari hulu ke hilir: (1) SSH git pull dengan token resmi di host server, (2) Restart container/Swarm service, (3) Upgrade modul resmi di database via XML-RPC, (4) Verifikasi health check HTTP 200. Mendukung target 'demo' (default), 'payroll', dan 'prod'. Untuk target 'prod', WAJIB menyertakan user_confirmed=true.",
			parameters: Type.Object({
				module_name: Type.String({ description: "Nama teknis modul yang ingin di-deploy (contoh: 'custom_payroll', 'generic_pdf_sign')" }),
				target: Type.Optional(Type.String({ description: "Target Odoo: 'demo' (default), 'payroll', atau 'prod'" })),
				user_confirmed: Type.Optional(Type.Boolean({ description: "Wajib true jika target adalah 'prod' (bukti persetujuan eksplisit terhadap rencana deployment)" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const target = params.target || "demo";
				if (target === "prod" && !params.user_confirmed) {
					return {
						content: [{ type: "text", text: "DIBATALKAN: Deployment ke Production (Docker Swarm) membutuhkan persetujuan eksplisit dari pengguna. Sajikan rencana kerja dan sertakan user_confirmed=true." }],
						details: { success: false },
					};
				}

				const res = await callOdooRunner("deploy_module", {
					target: target,
					module_name: params.module_name,
					user_confirmed: params.user_confirmed || false,
				});

				if (!res.success) {
					return {
						content: [{ type: "text", text: `❌ Gagal deploy modul '${params.module_name}' ke [${target}]: ${res.error}` }],
						details: { success: false, error: res.error },
					};
				}

				const d = res.data;
				const summary = [
					`🚀 **DEPLOYMENT SUCCESSFUL — ${params.module_name.toUpperCase()}**`,
					`• Target: **${d.target.toUpperCase()}** (${d.host})`,
					`• Git Pull: \`${d.git_output}\``,
					`• Container: ${d.restart_summary}`,
					`• Database: ${d.upgrade_method ? `Upgrade via ${d.upgrade_method}` : `Upgrade Module ID ${d.module_id} OK`}`,
					`• Health Check: **${d.health_check}**`,
				].join("\n");

				return {
					content: [{ type: "text", text: summary }],
					details: { success: true, data: d },
				};
			},
		})
	);

	// Tool: odoo_cli_upgrade
	pi.registerTool(
		defineTool({
			name: "odoo_cli_upgrade",
			label: "Odoo CLI Upgrade (Container Rescue & Multi-Module)",
			description:
				"Meng-upgrade modul langsung via Odoo CLI di dalam Docker container (--stop-after-init --no-http). Kebal terhadap error 500 / missing column di database, mendukung multi-modul sekaligus dipisah koma (contoh: 'custom_payroll,custom_overtime'). Mendukung target 'demo' (default), 'payroll', dan 'prod'. Untuk target 'prod', WAJIB menyertakan user_confirmed=true.",
			parameters: Type.Object({
				modules: Type.String({ description: "Nama modul atau daftar modul dipisah koma (contoh: 'hr_expense_advance_clearing,dynamic_approval_engine')" }),
				target: Type.Optional(Type.String({ description: "Target Odoo: 'demo' (default), 'payroll', atau 'prod'" })),
				restart: Type.Optional(Type.Boolean({ description: "Otomatis restart container setelah CLI upgrade (default: true)" })),
				user_confirmed: Type.Optional(Type.Boolean({ description: "Wajib true jika target adalah 'prod' (bukti persetujuan eksplisit terhadap operasi di production)" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const target = params.target || "demo";
				if (target === "prod" && !params.user_confirmed) {
					return {
						content: [{ type: "text", text: "DIBATALKAN: CLI Upgrade ke Production membutuhkan persetujuan eksplisit dari pengguna. Sertakan user_confirmed=true." }],
						details: { success: false },
					};
				}

				const res = await callOdooRunner("cli_upgrade_module", {
					target,
					modules: params.modules,
					restart: params.restart ?? true,
					user_confirmed: params.user_confirmed || false,
				});

				if (!res.success) {
					return {
						content: [{ type: "text", text: `❌ Gagal CLI upgrade modul '${params.modules}' di [${target}]: ${res.error}` }],
						details: { success: false, error: res.error },
					};
				}

				const d = res.data;
				const summary = [
					`✅ **ODOO CLI UPGRADE SUCCESSFUL**`,
					`• Target: **${d.target.toUpperCase()}** (${d.host})`,
					`• Database: \`${d.database}\``,
					`• Modules: \`${d.modules}\``,
					`• Container: ${d.restart_summary}`,
					`• Health Check: **${d.health_check}**`,
				].join("\n");

				return {
					content: [{ type: "text", text: summary }],
					details: { success: true, data: d },
				};
			},
		})
	);
	// Tool 8: odoo_fields
	pi.registerTool(
		defineTool({
			name: "odoo_fields",
			label: "Odoo Model Fields Schema (fields_get)",
			description:
				"Membaca metadata skema ORM lengkap dari model Odoo (tipe data, label string, selection options, relational model, required/readonly, compute/store) via method resmi fields_get. Mendukung target 'demo' (default), 'prod', atau 'payroll'.",
			parameters: Type.Object({
				model: Type.String({ description: "Nama teknis model Odoo (contoh: 'hr.payslip', 'hr.overtime', 'sale.order', 'res.partner')" }),
				fields: Type.Optional(Type.Array(Type.String(), { description: "Daftar nama field spesifik yang ingin diinspeksi (opsional, default: semua field)" })),
				attributes: Type.Optional(Type.Array(Type.String(), { description: "Atribut field yang ingin diambil (default: type, string, relation, selection, required, readonly, store, help)" })),
				target: Type.Optional(Type.String({ description: "Target Odoo: 'demo' (default), 'prod', atau 'payroll'" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const res = await callOdooRunner("fields_get", {
					target: params.target || "demo",
					model: params.model,
					fields: params.fields,
					attributes: params.attributes || ["type", "string", "relation", "selection", "required", "readonly", "store", "help"],
				});

				return {
					content: [{ type: "text", text: res.success ? JSON.stringify(res.data, null, 2) : `Error: ${res.error}` }],
					details: { success: res.success, count: res.data ? Object.keys(res.data).length : 0 },
				};
			},
		})
	);

	// Tool 9: odoo_find_xmlid
	pi.registerTool(
		defineTool({
			name: "odoo_find_xmlid",
			label: "Find Odoo XML ID",
			description:
				"Mencari XML ID bawaan dan kustom Odoo 18 secara instan (menggunakan ripgrep) pada direktori addons lokal (addons/, custom_addons/, payroll_addons/). Mengembalikan XML ID lengkap (module.record_id), target model, tipe view (form, list, kanban, search), file path, dan inherit_id jika ada. Sangat berguna saat membuat view inheritance (<field name=\"inherit_id\" ref=\"...\">), mencari action window ID, atau menuitem ID.",
			parameters: Type.Object({
				query: Type.String({ description: "Kata kunci pencarian XML ID atau view (contoh: \x27view_order_form\x27, \x27sale order form\x27, \x27res.partner kanban\x27, \x27account.move\x27)" }),
				module: Type.Optional(Type.String({ description: "Batasi pencarian ke modul tertentu (contoh: \x27sale\x27, \x27account\x27, \x27crm\x27, \x27salescustom\x27)" })),
				record_type: Type.Optional(Type.String({ description: "Filter tipe record (contoh: \x27view\x27, \x27action\x27, \x27menu\x27, \x27template\x27, atau \x27all\x27). Default: \x27all\x27" })),
				limit: Type.Optional(Type.Number({ description: "Maksimal hasil yang ditampilkan (default: 15)" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const results = searchOdooXmlIds({
					query: params.query,
					module: params.module,
					record_type: params.record_type || "all",
					limit: params.limit || 15,
				});

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: `Tidak ditemukan XML ID yang cocok dengan query "${params.query}"${params.module ? ` di modul \x27${params.module}\x27` : ""}. Coba kata kunci yang lebih luas (misal nama model atau nama action).` }],
						details: { success: true, count: 0 },
					};
				}

				const formatted = results.map((r, i) => {
					const lines = [
						`${i + 1}. **\`${r.xml_id}\`**`,
						`   • File: \`${r.file}:${r.line}\``,
						`   • Type: \`${r.record_type}\`${r.view_type ? ` (${r.view_type})` : ""}`,
					];
					if (r.model) lines.push(`   • Model: \`${r.model}\``);
					if (r.name) lines.push(`   • Name: "${r.name}"`);
					if (r.inherit_id) lines.push(`   • Inherits: \`${r.inherit_id}\``);
					return lines.join("\n");
				}).join("\n\n");

				return {
					content: [{ type: "text", text: `### 🔍 Hasil Pencarian XML ID (${results.length} ditemukan):\n\n${formatted}` }],
					details: { success: true, count: results.length, data: results },
				};
			},
		})
	);

}
