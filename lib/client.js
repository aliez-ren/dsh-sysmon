window.__ModuleLoader__.load({
	id: "dsh-sysmon",
	factory: (require) => {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const { useCallback, useEffect, useMemo, useRef, useState } = React;

		/* ------------------------------------------------------------------
		 * locale — one dictionary, picked once when the factory materializes
		 * ------------------------------------------------------------------ */

		function detectChinese() {
			var nav = "";
			var doc = "";
			try {
				if (typeof navigator !== "undefined" && navigator) nav = String(navigator.language || "");
			} catch (error) {
				nav = "";
			}
			try {
				if (typeof document !== "undefined" && document && document.documentElement) doc = String(document.documentElement.lang || "");
			} catch (error) {
				doc = "";
			}
			return /^zh/i.test(nav) || /^zh/i.test(doc);
		}

		function buildText(chinese) {
			if (chinese) return {
				sidebarLabel: "系统",
				pageTitle: "系统监控",
				host: "主机",
				kernel: "内核",
				uptime: "运行",
				load: "负载",
				procs: "进程",
				pause: "暂停",
				resume: "继续",
				refresh: "间隔",
				live: "实时",
				paused: "已暂停",
				offline: "离线 — 重试中",
				collecting: "采集数据中…",
				sampling: "采样中…",
				cpu: "处理器",
				mem: "内存",
				net: "网络",
				disk: "磁盘",
				pressure: "压力",
				cores: "核",
				rx: "下行",
				tx: "上行",
				read: "读",
				write: "写",
				available: "可用",
				buffers: "缓冲",
				cached: "缓存",
				swap: "交换",
				pressureCpu: "CPU",
				pressureIo: "IO",
				pressureMem: "内存",
				search: "筛选 PID / 用户 / 命令",
				processPanel: "进程",
				showing: "显示 {n} / {m}",
				colPid: "PID",
				colUser: "用户",
				colCpu: "CPU%",
				colMem: "内存%",
				colRss: "RSS",
				colThr: "线程",
				colState: "状态",
				colTime: "TIME+",
				colCmd: "命令",
				selectPid: "选择进程",
				selected: "已选",
				killTerm: "SIGTERM",
				killKill: "SIGKILL",
				confirmTerm: "确认 SIGTERM",
				confirmKill: "确认 SIGKILL",
				killFailed: "终止失败：",
				dismiss: "关闭",
				selectHint: "选择一行以发送信号",
				noProcs: "无匹配进程",
				sortBy: "按 {name} 排序",
				updated: "更新于",
			};
			return {
				sidebarLabel: "System",
				pageTitle: "System Monitor",
				host: "host",
				kernel: "kernel",
				uptime: "uptime",
				load: "load",
				procs: "procs",
				pause: "pause",
				resume: "resume",
				refresh: "interval",
				live: "live",
				paused: "paused",
				offline: "offline — retrying",
				collecting: "collecting…",
				sampling: "sampling…",
				cpu: "CPU",
				mem: "Memory",
				net: "Network",
				disk: "Disk",
				pressure: "Pressure",
				cores: "cores",
				rx: "rx",
				tx: "tx",
				read: "read",
				write: "write",
				available: "available",
				buffers: "buffers",
				cached: "cached",
				swap: "swap",
				pressureCpu: "CPU",
				pressureIo: "IO",
				pressureMem: "Mem",
				search: "filter pid / user / command",
				processPanel: "Processes",
				showing: "showing {n} of {m}",
				colPid: "PID",
				colUser: "USER",
				colCpu: "CPU%",
				colMem: "MEM%",
				colRss: "RSS",
				colThr: "THR",
				colState: "STATE",
				colTime: "TIME+",
				colCmd: "COMMAND",
				selectPid: "select process",
				selected: "selected",
				killTerm: "SIGTERM",
				killKill: "SIGKILL",
				confirmTerm: "confirm SIGTERM",
				confirmKill: "confirm SIGKILL",
				killFailed: "kill failed: ",
				dismiss: "Dismiss",
				selectHint: "select a row to signal",
				noProcs: "no matching processes",
				sortBy: "sort by {name}",
				updated: "updated",
			};
		}

		const TEXT = buildText(detectChinese());
		const DASH = "—";
		const MAX_ROWS = 400;
		const ARM_TIMEOUT_MS = 3000;
		const SNAPSHOT_URL = "/api/sysmon.snapshot";
		const KILL_URL = "/api/sysmon.kill";
		const INTERVALS = [1000, 2000, 5000];

		/* ------------------------------------------------------------------
		 * small typed helpers — never throw on a hostile snapshot
		 * ------------------------------------------------------------------ */

		function isNum(value) {
			return typeof value === "number" && isFinite(value);
		}

		function num(value) {
			return typeof value === "number" && isFinite(value) ? value : null;
		}

		function arr(value) {
			return Array.isArray(value) ? value : [];
		}

		function obj(value) {
			return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
		}

		function pickNum(source, key) {
			return num(source ? source[key] : null);
		}

		function clamp(value, low, high) {
			return value < low ? low : value > high ? high : value;
		}

		function noop() {
			return undefined;
		}

		function format(template, values) {
			return String(template).replace(/\{(\w+)\}/g, function (match, key) {
				var value = values ? values[key] : undefined;
				return value === undefined || value === null ? "" : String(value);
			});
		}

		function pad2(value) {
			return value < 10 ? "0" + value : String(value);
		}

		/* ------------------------------------------------------------------
		 * formatting
		 * ------------------------------------------------------------------ */

		const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

		function formatBytes(value) {
			var n = num(value);
			if (n === null) return DASH;
			if (n < 0) n = 0;
			if (n < 1024) return Math.round(n) + " B";
			var unit = 0;
			var scaled = n;
			while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
				scaled /= 1024;
				unit += 1;
			}
			var text = scaled.toFixed(1);
			if (text.slice(-2) === ".0") text = text.slice(0, -2);
			return text + " " + BYTE_UNITS[unit];
		}

		function formatRate(value) {
			if (num(value) === null) return DASH;
			return formatBytes(value) + "/s";
		}

		function formatPercent(value, digits) {
			var n = num(value);
			if (n === null) return DASH;
			return n.toFixed(digits === undefined ? 1 : digits) + "%";
		}

		/* A process may legitimately own more than one core, so drop the decimal
		 * once the number gets wide enough to crowd the CPU% column. */
		function formatProcessCpu(value) {
			var n = num(value);
			if (n === null) return DASH;
			if (n >= 100) return Math.round(n) + "%";
			return n.toFixed(1) + "%";
		}

		function formatCount(value) {
			var n = num(value);
			if (n === null) return DASH;
			return String(Math.round(n));
		}

		function formatLoad(value) {
			var n = num(value);
			if (n === null) return DASH;
			return n.toFixed(2);
		}

		function formatUptime(seconds) {
			var n = num(seconds);
			if (n === null || n < 0) return DASH;
			var whole = Math.floor(n);
			var days = Math.floor(whole / 86400);
			var hours = Math.floor((whole % 86400) / 3600);
			var minutes = Math.floor((whole % 3600) / 60);
			if (days > 0) return days + "d " + hours + "h " + minutes + "m";
			if (hours > 0) return hours + "h " + minutes + "m";
			return minutes + "m";
		}

		function formatTimePlus(seconds) {
			var n = num(seconds);
			if (n === null || n < 0) return DASH;
			var hours = Math.floor(n / 3600);
			var minutes = Math.floor((n % 3600) / 60);
			var rest = n % 60;
			var restText = rest.toFixed(1);
			if (rest < 10) restText = "0" + restText;
			if (hours > 0) return hours + ":" + pad2(minutes) + ":" + restText;
			return minutes + ":" + restText;
		}

		function formatClock(epochMs) {
			var n = num(epochMs);
			if (n === null) return DASH;
			var date = new Date(n);
			if (isNaN(date.getTime())) return DASH;
			return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
		}

		function severityClass(percent) {
			var n = num(percent);
			if (n === null) return "sys-sev-none";
			if (n < 60) return "sys-sev-ok";
			if (n < 85) return "sys-sev-warn";
			return "sys-sev-crit";
		}

		function stateClass(state) {
			var letter = String(state || "").toUpperCase();
			if (letter === "R") return "sys-sev-ok";
			if (letter === "D") return "sys-sev-warn";
			if (letter === "Z" || letter === "X") return "sys-sev-crit";
			return "sys-sev-none";
		}

		function average(values) {
			var list = arr(values);
			var total = 0;
			var count = 0;
			for (var index = 0; index < list.length; index += 1) {
				var value = num(list[index]);
				if (value === null) continue;
				total += value;
				count += 1;
			}
			return count === 0 ? null : total / count;
		}

		/* ------------------------------------------------------------------
		 * data access
		 * ------------------------------------------------------------------ */

		function useSysMonData(intervalMs, paused) {
			const [snapshot, setSnapshot] = useState(null);
			const [error, setError] = useState(null);
			const [updatedAt, setUpdatedAt] = useState(0);
			const mounted = useRef(true);
			const inFlight = useRef(false);

			useEffect(function () {
				mounted.current = true;
				return function () {
					mounted.current = false;
				};
			}, []);

			const refresh = useCallback(async function () {
				if (typeof fetch !== "function") return null;
				if (inFlight.current) return null;
				inFlight.current = true;
				try {
					const response = await fetch(SNAPSHOT_URL, {
						credentials: "same-origin",
						cache: "no-store",
						headers: { accept: "application/json" },
					});
					if (!response || !response.ok) {
						throw new Error("HTTP " + (response ? response.status : "?"));
					}
					const payload = await response.json();
					if (!payload || typeof payload !== "object") throw new Error("invalid snapshot payload");
					if (mounted.current) {
						setSnapshot(payload);
						setError(null);
						setUpdatedAt(Date.now());
					}
					return payload;
				} catch (failure) {
					if (mounted.current) setError(failure && failure.message ? failure.message : String(failure));
					return null;
				} finally {
					inFlight.current = false;
				}
			}, []);

			useEffect(function () {
				if (paused) return undefined;
				var timer = 0;
				function tick() {
					if (typeof document !== "undefined" && document && document.visibilityState === "hidden") return;
					refresh();
				}
				function onVisibility() {
					if (typeof document !== "undefined" && document && document.visibilityState === "visible") refresh();
				}
				tick();
				timer = setInterval(tick, intervalMs);
				if (typeof document !== "undefined" && document && document.addEventListener) {
					document.addEventListener("visibilitychange", onVisibility);
				}
				return function () {
					clearInterval(timer);
					if (typeof document !== "undefined" && document && document.removeEventListener) {
						document.removeEventListener("visibilitychange", onVisibility);
					}
				};
			}, [intervalMs, paused, refresh]);

			return { snapshot: snapshot, error: error, updatedAt: updatedAt, refresh: refresh };
		}

		/* ------------------------------------------------------------------
		 * sparkline
		 * ------------------------------------------------------------------ */

		function Sparkline(props) {
			var values = arr(props.values);
			var mode = props.mode === "cpu" ? "cpu" : props.mode === "auto" ? "auto" : "fixed";
			var height = isNum(props.height) ? props.height : 34;
			var max = mode === "fixed" ? 100 : 0;
			var index;
			if (mode !== "fixed") {
				for (index = 0; index < values.length; index += 1) {
					var sample = num(values[index]);
					if (sample !== null && sample > max) max = sample;
				}
			}
			if (mode === "cpu") max = Math.max(100, max);
			if (mode === "auto") max = Math.max(max, 1);
			var points = [];
			var count = values.length;
			for (index = 0; index < count; index += 1) {
				var value = num(values[index]);
				if (value === null) continue;
				var x = count <= 1 ? 0 : (index / (count - 1)) * 100;
				var y = 100 - clamp(value / max, 0, 1) * 100;
				points.push([x, y]);
			}
			var line = "";
			if (points.length === 1) {
				var only = points[0][1].toFixed(2);
				line = "M0," + only + " L100," + only;
			} else if (points.length > 1) {
				var parts = [];
				for (index = 0; index < points.length; index += 1) {
					parts.push(points[index][0].toFixed(2) + "," + points[index][1].toFixed(2));
				}
				line = "M" + parts.join(" L");
			}
			var area = line ? line + " L100,100 L0,100 Z" : "";
			var hundredLine = max > 100.5 ? 100 - (100 / max) * 100 : null;
			return h("div", {
				className: "sys-spark-wrap" + (props.className ? " " + props.className : ""),
				style: { height: height + "px" },
			},
				h("svg", {
					className: "sys-spark",
					viewBox: "0 0 100 100",
					preserveAspectRatio: "none",
					width: "100%",
					height: "100%",
					"aria-hidden": "true",
					focusable: "false",
				},
					h("line", { className: "sys-spark-grid", x1: 0, y1: 0.5, x2: 100, y2: 0.5, vectorEffect: "non-scaling-stroke" }),
					hundredLine === null ? null : h("line", { className: "sys-spark-grid", x1: 0, y1: hundredLine, x2: 100, y2: hundredLine, vectorEffect: "non-scaling-stroke" }),
					area ? h("path", { className: "sys-spark-area", d: area }) : null,
					line ? h("path", { className: "sys-spark-line", d: line, vectorEffect: "non-scaling-stroke" }) : null
				)
			);
		}

		/* ------------------------------------------------------------------
		 * panels
		 * ------------------------------------------------------------------ */

		function panel(title, extra, children) {
			return h("section", { className: "sys-panel" },
				h("div", { className: "sys-panel-head" },
					h("span", { className: "sys-panel-title" }, title),
					extra ? h("span", { className: "sys-panel-extra" }, extra) : null),
				children);
		}

		function detailRow(label, value) {
			return h("div", { className: "sys-kv-row", key: label },
				h("span", { className: "sys-k" }, label),
				h("span", { className: "sys-v" }, value));
		}

		function CoreBars(props) {
			var cores = arr(props.cores);
			if (cores.length === 0) return null;
			var bars = [];
			for (var index = 0; index < cores.length; index += 1) {
				var value = num(cores[index]);
				var tooltip = "core " + (index + 1) + " " + DASH + " " + (value === null ? DASH : value.toFixed(1) + "%");
				bars.push(h("div", {
					className: "sys-core",
					key: index,
					role: "listitem",
					title: tooltip,
				},
					h("div", {
						className: "sys-core-fill " + severityClass(value),
						"data-active": value !== null && value > 0 ? "true" : undefined,
						style: { height: (value === null ? 0 : clamp(value, 0, 100)) + "%" },
					})
				));
			}
			return h("div", { className: "sys-cores", role: "list", "aria-label": TEXT.cores }, bars);
		}

		function CpuPanel(props) {
			var cpu = obj(props.cpu);
			var host = obj(props.host);
			var hist = obj(props.hist);
			var usage = pickNum(cpu, "usage");
			var perCore = arr(cpu ? cpu.perCore : null);
			var freq = average(cpu ? cpu.freqMHz : null);
			var cores = pickNum(host, "cores");
			var model = host && host.cpuModel ? String(host.cpuModel) : "";
			var extraBits = [];
			if (freq !== null) extraBits.push((freq / 1000).toFixed(2) + " GHz");
			if (cores !== null) extraBits.push(formatCount(cores) + " " + TEXT.cores);
			var note = model || (props.hasData ? TEXT.sampling : TEXT.collecting);
			return panel(TEXT.cpu, extraBits.join(" · "), [
				h("div", { className: "sys-hero", key: "hero" },
					h("span", { className: "sys-big " + severityClass(usage) },
						usage === null ? DASH : usage.toFixed(1),
						h("span", { className: "sys-big-unit" }, "%")),
					h("span", { className: "sys-hero-note", title: model || note }, note)),
				h(Sparkline, {
					key: "spark",
					values: arr(hist ? hist.cpu : null),
					mode: "cpu",
					height: 44,
					className: severityClass(usage),
				}),
				h(CoreBars, { key: "cores", cores: perCore }),
			]);
		}

		function MemoryPanel(props) {
			var mem = obj(props.mem);
			var hist = obj(props.hist);
			var total = pickNum(mem, "total");
			var used = pickNum(mem, "used");
			var percent = total !== null && total > 0 && used !== null ? (used / total) * 100 : null;
			var swapTotal = pickNum(mem, "swapTotal");
			var swapUsed = pickNum(mem, "swapUsed");
			return panel(TEXT.mem, null, [
				h("div", { className: "sys-hero", key: "hero" },
					h("span", { className: "sys-mid" },
						h("span", { className: severityClass(percent) }, formatBytes(used)),
						h("span", { className: "sys-dim" }, " / " + formatBytes(total))),
					h("span", { className: "sys-mid " + severityClass(percent) }, formatPercent(percent))),
				h("div", { className: "sys-bar " + severityClass(percent), key: "bar" },
					h("div", { className: "sys-bar-fill", style: { width: clamp(percent === null ? 0 : percent, 0, 100) + "%" } })),
				h(Sparkline, {
					key: "spark",
					values: arr(hist ? hist.mem : null),
					mode: "fixed",
					height: 30,
					className: severityClass(percent),
				}),
				h("div", { className: "sys-kv", key: "kv" },
					detailRow(TEXT.available, formatBytes(pickNum(mem, "available"))),
					detailRow(TEXT.buffers, formatBytes(pickNum(mem, "buffers"))),
					detailRow(TEXT.cached, formatBytes(pickNum(mem, "cached"))),
					detailRow(TEXT.swap, formatBytes(swapUsed) + " / " + formatBytes(swapTotal))),
			]);
		}

		function ioRow(key, label, value, series, toneClass) {
			var children = [
				h("div", { className: "sys-io-head", key: "head" },
					h("span", { className: "sys-io-label" }, label),
					h("span", { className: "sys-io-value", title: formatRate(value) }, formatRate(value))),
			];
			if (Array.isArray(series)) {
				children.push(h(Sparkline, { key: "spark", values: series, mode: "auto", height: 26, className: toneClass }));
			}
			return h("div", { className: "sys-io", key: key }, children);
		}

		function NetworkPanel(props) {
			var net = obj(props.net);
			var hist = obj(props.hist);
			var ifaces = arr(net ? net.ifaces : null);
			var rows = [];
			if (ifaces.length > 0) {
				var ifaceRows = [];
				for (var index = 0; index < ifaces.length; index += 1) {
					var iface = obj(ifaces[index]) || {};
					var name = iface.name ? String(iface.name) : DASH;
					ifaceRows.push(h("div", { className: "sys-iface", key: name + ":" + index },
						h("span", { className: "sys-iface-name", title: name }, name),
						h("span", { className: "sys-iface-rate", title: formatRate(pickNum(iface, "rxBps")) },
							"↓ " + formatRate(pickNum(iface, "rxBps"))),
						h("span", { className: "sys-iface-rate", title: formatRate(pickNum(iface, "txBps")) },
							"↑ " + formatRate(pickNum(iface, "txBps")))));
				}
				rows.push(h("div", { className: "sys-ifaces", key: "ifaces" }, ifaceRows));
			}
			return panel(TEXT.net, null, [
				ioRow("rx", "↓ " + TEXT.rx, pickNum(net, "rxBps"), arr(hist ? hist.rx : null), "sys-tone-a"),
				ioRow("tx", "↑ " + TEXT.tx, pickNum(net, "txBps"), arr(hist ? hist.tx : null), "sys-tone-b"),
				rows.length > 0 ? rows[0] : null,
			]);
		}

		function DiskPanel(props) {
			var disk = obj(props.disk);
			var devices = arr(disk ? disk.devices : null);
			var rows = [];
			if (devices.length > 0) {
				var deviceRows = [];
				for (var index = 0; index < devices.length; index += 1) {
					var device = obj(devices[index]) || {};
					var name = device.name ? String(device.name) : DASH;
					deviceRows.push(h("div", { className: "sys-iface", key: name + ":" + index },
						h("span", { className: "sys-iface-name", title: name }, name),
						h("span", { className: "sys-iface-rate" }, "r " + formatRate(pickNum(device, "readBps"))),
						h("span", { className: "sys-iface-rate" }, "w " + formatRate(pickNum(device, "writeBps")))));
				}
				rows.push(h("div", { className: "sys-ifaces", key: "devices" }, deviceRows));
			}
			return panel(TEXT.disk, null, [
				ioRow("read", TEXT.read, pickNum(disk, "readBps"), null, "sys-tone-a"),
				ioRow("write", TEXT.write, pickNum(disk, "writeBps"), null, "sys-tone-b"),
				rows.length > 0 ? rows[0] : null,
			]);
		}

		function PressurePanel(props) {
			var pressure = obj(props.pressure);
			var rows = [
				{ key: "cpu10", label: TEXT.pressureCpu },
				{ key: "io10", label: TEXT.pressureIo },
				{ key: "mem10", label: TEXT.pressureMem },
			];
			var any = false;
			var meters = [];
			for (var index = 0; index < rows.length; index += 1) {
				var row = rows[index];
				var value = pickNum(pressure, row.key);
				if (value !== null) any = true;
				meters.push(h("div", {
					className: "sys-meter",
					key: row.key,
					title: row.label + " " + formatPercent(value, 2),
				},
					h("span", { className: "sys-meter-label" }, row.label),
					h("div", { className: "sys-meter-track " + severityClass(value) },
						h("div", { className: "sys-meter-fill", style: { width: clamp(value === null ? 0 : value, 0, 100) + "%" } })),
					h("span", { className: "sys-meter-value " + severityClass(value) }, formatPercent(value))));
			}
			if (!any) return null;
			return panel(TEXT.pressure, null, meters);
		}

		/* ------------------------------------------------------------------
		 * process table
		 * ------------------------------------------------------------------ */

		const COLUMNS = [
			{ key: "pid", label: TEXT.colPid, numeric: true },
			{ key: "user", label: TEXT.colUser, numeric: false },
			{ key: "cpu", label: TEXT.colCpu, numeric: true },
			{ key: "mem", label: TEXT.colMem, numeric: true },
			{ key: "rss", label: TEXT.colRss, numeric: true },
			{ key: "thr", label: TEXT.colThr, numeric: true },
			{ key: "state", label: TEXT.colState, numeric: false },
			{ key: "time", label: TEXT.colTime, numeric: true },
			{ key: "cmd", label: TEXT.colCmd, numeric: false },
		];

		function isTextColumn(key) {
			return key === "user" || key === "state" || key === "cmd";
		}

		function compareProcs(left, right, key, direction) {
			if (isTextColumn(key)) {
				var ltext = String(left && left[key] !== undefined && left[key] !== null ? left[key] : "");
				var rtext = String(right && right[key] !== undefined && right[key] !== null ? right[key] : "");
				return direction * ltext.localeCompare(rtext);
			}
			var lnum = num(left ? left[key] : null);
			var rnum = num(right ? right[key] : null);
			if (lnum === null && rnum === null) return 0;
			if (lnum === null) return 1;
			if (rnum === null) return -1;
			return direction * (lnum - rnum);
		}

		function cellClass(column) {
			return "sys-cell" + (column.numeric ? " sys-cell-num" : "");
		}

		function ProcessTable(props) {
			var procs = arr(props.procs);
			const [search, setSearch] = useState("");
			const [sortKey, setSortKey] = useState("cpu");
			const [sortDir, setSortDir] = useState(-1);
			const [selected, setSelected] = useState(null);
			const [armed, setArmed] = useState(null);
			const armTimer = useRef(0);

			var selectedPid = selected && selected.pid !== undefined ? selected.pid : null;

			useEffect(function () {
				if (armTimer.current) {
					clearTimeout(armTimer.current);
					armTimer.current = 0;
				}
				setArmed(null);
			}, [selectedPid]);

			/* Drop a selection whose process no longer exists, so a successful
			 * kill leaves no stale signal controls behind. The check reads the
			 * unfiltered list, so a search filter cannot clear a live selection. */
			useEffect(function () {
				if (!selected || !Array.isArray(props.procs)) return;
				var pid = selected.pid;
				if (pid === undefined || pid === null) return;
				for (var index = 0; index < procs.length; index += 1) {
					var candidate = obj(procs[index]);
					if (candidate && String(candidate.pid) === String(pid)) return;
				}
				setSelected(null);
			}, [procs, selected]);

			useEffect(function () {
				return function () {
					if (armTimer.current) clearTimeout(armTimer.current);
				};
			}, []);

			const rows = useMemo(function () {
				var query = String(search || "").trim().toLowerCase();
				var filtered = [];
				for (var index = 0; index < procs.length; index += 1) {
					var proc = obj(procs[index]);
					if (!proc) continue;
					if (query) {
						var haystack = (String(proc.pid === undefined || proc.pid === null ? "" : proc.pid) +
							" " + String(proc.user || "") +
							" " + String(proc.cmd || "") +
							" " + String(proc.args || "")).toLowerCase();
						if (haystack.indexOf(query) === -1) continue;
					}
					filtered.push(proc);
				}
				filtered.sort(function (left, right) {
					var result = compareProcs(left, right, sortKey, sortDir);
					if (result !== 0) return result;
					return (num(left && left.pid) || 0) - (num(right && right.pid) || 0);
				});
				return filtered;
			}, [procs, search, sortKey, sortDir]);

			var rendered = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;
			var killError = obj(props.killError);
			var killing = props.killing === true;

			function toggleSort(key) {
				if (key === sortKey) {
					setSortDir(sortDir === 0 ? -1 : -sortDir);
					return;
				}
				setSortKey(key);
				setSortDir(isTextColumn(key) || key === "pid" ? 1 : -1);
			}

			function selectRow(proc) {
				if (!proc) return;
				setSelected({
					pid: proc.pid,
					user: proc.user,
					cmd: proc.cmd,
					args: proc.args,
				});
			}

			function armSignal(signal) {
				if (!selected) return;
				if (armed === signal) {
					if (armTimer.current) {
						clearTimeout(armTimer.current);
						armTimer.current = 0;
					}
					setArmed(null);
					if (typeof props.onKill === "function") props.onKill(selected.pid, signal);
					return;
				}
				setArmed(signal);
				if (armTimer.current) clearTimeout(armTimer.current);
				armTimer.current = setTimeout(function () {
					armTimer.current = 0;
					setArmed(null);
				}, ARM_TIMEOUT_MS);
			}

			var headerCells = [];
			for (var columnIndex = 0; columnIndex < COLUMNS.length; columnIndex += 1) {
				var column = COLUMNS[columnIndex];
				var active = column.key === sortKey;
				headerCells.push(h("div", {
					key: column.key,
					role: "columnheader",
					className: "sys-th" + (column.numeric ? " sys-cell-num" : ""),
					"aria-sort": active ? (sortDir > 0 ? "ascending" : "descending") : "none",
				},
					h("button", {
						type: "button",
						className: "sys-th-btn",
						onClick: function (key) {
							return function () {
								toggleSort(key);
							};
						}(column.key),
						"aria-label": format(TEXT.sortBy, { name: column.label }),
						title: format(TEXT.sortBy, { name: column.label }),
					},
						h("span", null, column.label),
						active ? h("span", { className: "sys-sort-mark", "aria-hidden": "true" }, sortDir > 0 ? "▲" : "▼") : null)));
			}

			var bodyRows = [];
			for (var rowIndex = 0; rowIndex < rendered.length; rowIndex += 1) {
				var proc = rendered[rowIndex];
				var pid = proc.pid;
				var isSelected = selectedPid !== null && String(selectedPid) === String(pid);
				var command = proc.args || proc.cmd;
				bodyRows.push(h("div", {
					role: "row",
					key: String(pid) + ":" + rowIndex,
					className: "sys-tr" + (isSelected ? " sys-row-selected" : ""),
					"data-sysmon-proc-row": pid === undefined || pid === null ? "" : String(pid),
					"data-sysmon-selected": isSelected ? "true" : undefined,
					title: command ? String(command) : undefined,
					"aria-current": isSelected ? "true" : undefined,
					onClick: function (target) {
						return function () {
							selectRow(target);
						};
					}(proc),
				},
					h("div", { role: "cell", className: cellClass(COLUMNS[0]) },
						h("button", {
							type: "button",
							className: "sys-pid",
							title: pid === undefined || pid === null ? undefined : String(pid),
							"aria-label": TEXT.selectPid + " " + String(pid),
							"aria-pressed": isSelected,
							onClick: function (target) {
								return function (event) {
									event.stopPropagation();
									selectRow(target);
								};
							}(proc),
						}, pid === undefined || pid === null ? DASH : String(pid))),
					h("div", { role: "cell", className: cellClass(COLUMNS[1]), title: String(proc.user || "") }, String(proc.user || DASH)),
					h("div", { role: "cell", className: cellClass(COLUMNS[2]) + " " + severityClass(proc.cpu) }, formatProcessCpu(proc.cpu)),
					h("div", { role: "cell", className: cellClass(COLUMNS[3]) + " " + severityClass(proc.mem) }, formatPercent(proc.mem)),
					h("div", { role: "cell", className: cellClass(COLUMNS[4]) }, formatBytes(proc.rss)),
					h("div", { role: "cell", className: cellClass(COLUMNS[5]) }, formatCount(proc.thr)),
					h("div", { role: "cell", className: cellClass(COLUMNS[6]) + " " + stateClass(proc.state) },
						h("span", { className: "sys-state" }, String(proc.state || DASH))),
					h("div", { role: "cell", className: cellClass(COLUMNS[7]) }, formatTimePlus(proc.time)),
					h("div", { role: "cell", className: cellClass(COLUMNS[8]) + " sys-cmd", title: String(command || "") },
						String(command || DASH))));
			}

			var emptyText = props.hasData ? TEXT.noProcs : TEXT.collecting;
			var footChildren = [];
			if (killError) {
				footChildren.push(h("div", { className: "sys-kill-error", key: "error", role: "alert" },
					h("span", { className: "sys-kill-error-text" }, TEXT.killFailed + String(killError.message || "")),
					h("button", {
						type: "button",
						className: "sys-icon-btn",
						"aria-label": TEXT.dismiss,
						title: TEXT.dismiss,
						onClick: function () {
							if (typeof props.onDismissKillError === "function") props.onDismissKillError();
						},
					}, "×")));
			}
			if (selected) {
				var selCommand = selected.args || selected.cmd || DASH;
				footChildren.push(h("div", { className: "sys-sel", key: "sel" },
					h("span", { className: "sys-sel-tag" }, TEXT.selected,
						" #" + String(selected.pid)),
					h("span", { className: "sys-sel-cmd", title: String(selCommand) }, String(selCommand)),
					h("span", { className: "sys-sel-actions" },
						h("button", {
							type: "button",
							className: "sys-kill",
							"data-sysmon-kill": "TERM",
							"data-armed": armed === "TERM" ? "true" : "false",
							disabled: killing,
							"aria-pressed": armed === "TERM",
							"aria-label": TEXT.killTerm + " " + String(selected.pid),
							onClick: function () {
								armSignal("TERM");
							},
						}, armed === "TERM" ? TEXT.confirmTerm : TEXT.killTerm),
						h("button", {
							type: "button",
							className: "sys-kill sys-kill-hard",
							"data-sysmon-kill": "KILL",
							"data-armed": armed === "KILL" ? "true" : "false",
							disabled: killing,
							"aria-pressed": armed === "KILL",
							"aria-label": TEXT.killKill + " " + String(selected.pid),
							onClick: function () {
								armSignal("KILL");
							},
						}, armed === "KILL" ? TEXT.confirmKill : TEXT.killKill))));
			} else {
				footChildren.push(h("span", { className: "sys-foot-empty", key: "hint" }, TEXT.selectHint));
			}

			return h("div", { className: "sys-right" },
				h("div", { className: "sys-table-bar" },
					h("input", {
						className: "sys-search",
						type: "search",
						"data-sysmon-search": "1",
						value: search,
						placeholder: TEXT.search,
						"aria-label": TEXT.search,
						spellCheck: false,
						autoComplete: "off",
						onChange: function (event) {
							setSearch(event.target.value);
						},
					}),
					h("span", { className: "sys-count", role: "status" },
						format(TEXT.showing, { n: rendered.length, m: rows.length }))),
				h("div", { className: "sys-table", role: "table", "aria-label": TEXT.processPanel },
					h("div", { className: "sys-scroll", role: "rowgroup" },
						h("div", { className: "sys-tr sys-thead", role: "row" }, headerCells),
						bodyRows.length > 0
							? bodyRows
							: h("div", { className: "sys-empty", role: "row" },
								h("div", { className: "sys-empty-cell", role: "cell" }, emptyText)))),
				h("div", { className: "sys-foot" }, footChildren));
		}

		/* ------------------------------------------------------------------
		 * page body (pure): everything below the polling hook
		 * ------------------------------------------------------------------ */

		function SysMonBody(props) {
			var source = props || {};
			var snapshot = obj(source.snapshot);
			var error = source.error ? String(source.error) : null;
			var paused = source.paused === true;
			var intervalMs = isNum(source.intervalMs) ? source.intervalMs : 2000;
			var updatedAt = num(source.updatedAt);
			var host = obj(snapshot ? snapshot.host : null);
			var load = obj(snapshot ? snapshot.load : null);
			var counts = obj(snapshot ? snapshot.counts : null);
			var hist = obj(snapshot ? snapshot.hist : null);
			var onTogglePause = typeof source.onTogglePause === "function" ? source.onTogglePause : noop;
			var onIntervalChange = typeof source.onIntervalChange === "function" ? source.onIntervalChange : noop;
			var onKill = typeof source.onKill === "function" ? source.onKill : noop;
			var onDismissKillError = typeof source.onDismissKillError === "function" ? source.onDismissKillError : noop;
			var totalProcs = pickNum(counts, "total");
			if (totalProcs === null) totalProcs = pickNum(load, "total");
			var state = error ? "offline" : !snapshot ? "idle" : paused ? "paused" : "live";
			var statusText = error ? TEXT.offline : !snapshot ? TEXT.collecting : paused ? TEXT.paused : TEXT.live;
			var statusTitle = error ? error : updatedAt !== null ? TEXT.updated + " " + formatClock(updatedAt) : "";
			var loadLine = [formatLoad(pickNum(load, "one")), formatLoad(pickNum(load, "five")), formatLoad(pickNum(load, "fifteen"))].join(" / ");
			var hostName = host && host.hostname ? String(host.hostname) : DASH;
			var kernel = host && host.kernel ? String(host.kernel) : DASH;

			function fact(key, label, value, title) {
				return h("span", { className: "sys-fact", key: key, title: title || undefined },
					h("span", { className: "sys-fact-k" }, label),
					h("span", { className: "sys-fact-v" }, value));
			}

			var options = [];
			for (var index = 0; index < INTERVALS.length; index += 1) {
				var value = INTERVALS[index];
				options.push(h("option", { key: value, value: String(value) }, value / 1000 + "s"));
			}

			var banner = error ? h("div", {
				className: "sys-banner",
				role: "status",
				"aria-live": "polite",
				"data-sysmon-offline": "1",
			},
				h("span", { className: "sys-banner-text" }, TEXT.offline),
				h("span", { className: "sys-banner-msg", title: error }, error)) : null;

			return h("div", { className: "sys-root", "data-sysmon": "panel", "data-sysmon-root": "1", "data-sysmon-state": state },
				h("style", { dangerouslySetInnerHTML: { __html: CSS } }),
				h("header", { className: "sys-header" },
					h("div", { className: "sys-brand" },
						h("span", { className: "sys-mark" }, "SYSMON"),
						h("span", { className: "sys-title" }, TEXT.pageTitle)),
					h("div", { className: "sys-facts" },
						fact("host", TEXT.host, hostName, host && host.cpuModel ? String(host.cpuModel) : undefined),
						fact("kernel", TEXT.kernel, kernel),
						fact("uptime", TEXT.uptime, formatUptime(pickNum(host, "uptime"))),
						fact("load", TEXT.load, loadLine),
						fact("procs", TEXT.procs, formatCount(totalProcs))),
					h("div", { className: "sys-controls" },
						h("span", { className: "sys-status", role: "status", "aria-live": "polite", title: statusTitle },
							h("span", { className: "sys-dot", "data-state": state, "aria-hidden": "true" }),
							statusText),
						h("button", {
							type: "button",
							className: "sys-btn",
							"aria-pressed": paused,
							onClick: function () {
								onTogglePause(!paused);
							},
						}, paused ? TEXT.resume : TEXT.pause),
						h("label", { className: "sys-interval" },
							h("span", { className: "sys-interval-label" }, TEXT.refresh),
							h("select", {
								className: "sys-select",
								value: String(intervalMs),
								"aria-label": TEXT.refresh,
								onChange: function (event) {
									onIntervalChange(Number(event.target.value));
								},
							}, options)))),
				banner,
				h("div", { className: "sys-body" },
					h("div", { className: "sys-left" },
						h(CpuPanel, { cpu: snapshot ? snapshot.cpu : null, hist: hist, host: host, hasData: !!snapshot }),
						h(MemoryPanel, { mem: snapshot ? snapshot.mem : null, hist: hist }),
						h(NetworkPanel, { net: snapshot ? snapshot.net : null, hist: hist }),
						h(DiskPanel, { disk: snapshot ? snapshot.disk : null }),
						h(PressurePanel, { pressure: snapshot ? snapshot.pressure : null })),
					h(ProcessTable, {
						procs: snapshot ? snapshot.procs : null,
						hasData: !!snapshot,
						onKill: onKill,
						killing: source.killing === true,
						killError: source.killError || null,
						onDismissKillError: onDismissKillError,
					})));
		}

		/* ------------------------------------------------------------------
		 * page (stateful)
		 * ------------------------------------------------------------------ */

		function SysMonPage() {
			const [intervalMs, setIntervalMs] = useState(2000);
			const [paused, setPaused] = useState(false);
			const data = useSysMonData(intervalMs, paused);
			const [killError, setKillError] = useState(null);
			const [killing, setKilling] = useState(false);
			const alive = useRef(true);

			useEffect(function () {
				alive.current = true;
				return function () {
					alive.current = false;
				};
			}, []);

			const killProcess = useCallback(async function (pid, signal) {
				if (!isNum(pid)) return false;
				if (typeof fetch !== "function") return false;
				if (alive.current) {
					setKilling(true);
					setKillError(null);
				}
				try {
					const response = await fetch(KILL_URL, {
						method: "POST",
						credentials: "same-origin",
						cache: "no-store",
						headers: { "content-type": "application/json", accept: "application/json" },
						body: JSON.stringify({ pid: pid, signal: signal }),
					});
					var payload = null;
					try {
						payload = await response.json();
					} catch (parseError) {
						payload = null;
					}
					if (!response.ok || !payload || payload.ok !== true) {
						var message = payload && payload.error ? String(payload.error) : "HTTP " + response.status;
						if (alive.current) setKillError({ pid: pid, signal: signal, message: message });
						return false;
					}
					if (alive.current) setKillError(null);
					await data.refresh();
					return true;
				} catch (failure) {
					if (alive.current) {
						setKillError({
							pid: pid,
							signal: signal,
							message: failure && failure.message ? failure.message : String(failure),
						});
					}
					return false;
				} finally {
					if (alive.current) setKilling(false);
				}
			}, [data.refresh]);

			return h(SysMonBody, {
				snapshot: data.snapshot,
				error: data.error,
				updatedAt: data.updatedAt,
				paused: paused,
				intervalMs: intervalMs,
				killing: killing,
				killError: killError,
				onTogglePause: function (next) {
					setPaused(next === undefined ? !paused : next === true);
				},
				onIntervalChange: function (next) {
					if (isNum(next) && INTERVALS.indexOf(next) !== -1) setIntervalMs(next);
				},
				onKill: killProcess,
				onDismissKillError: function () {
					setKillError(null);
				},
			});
		}

		/* ------------------------------------------------------------------
		 * sidebar icon
		 * ------------------------------------------------------------------ */

		function SysMonIcon(props) {
			var size = props && isNum(props.size) ? props.size : 16;
			return h("svg", {
				xmlns: "http://www.w3.org/2000/svg",
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				focusable: "false",
			},
				h("rect", { x: 1.7, y: 2.3, width: 12.6, height: 8.6, rx: 1.6 }),
				h("path", { d: "M8 10.9v2.7" }),
				h("path", { d: "M5.6 13.6h4.8" }),
				h("path", { d: "M3.9 6.9h1.6l1.1-2.1 1.7 4.1 1-2h2.8" }));
		}

		/* ------------------------------------------------------------------
		 * plugin registration
		 * ------------------------------------------------------------------ */

		function apply(ctx) {
			ctx.slots.inject("main", function* () {
				yield ctx.slots.register({ name: "main", key: "sysmon" }, SysMonPage);
			});
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: "sysmon",
				order: 25,
				label: () => TEXT.sidebarLabel,
			}, SysMonIcon));
		}

		const inject = ["slots"];

		/* ------------------------------------------------------------------
		 * styles
		 * ------------------------------------------------------------------ */

		const CSS = `
.sys-root{height:100%;min-height:0;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:16px;padding-top:calc(16px + var(--dsh-frame-top-clearance,0px));overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.45;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.sys-root *,.sys-root *::before,.sys-root *::after{box-sizing:border-box}
.sys-root button{font:inherit;color:inherit}
.sys-root button:focus-visible,.sys-root input:focus-visible,.sys-root select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.sys-dim{color:var(--dsw-alias-label-tertiary)}
.sys-header{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding-bottom:10px;border-bottom:.5px solid var(--dsw-alias-border-l3);min-width:0}
.sys-brand{display:flex;align-items:baseline;gap:8px;min-width:0}
.sys-mark{font-size:12px;font-weight:600;letter-spacing:.16em;color:var(--dsw-alias-brand-primary)}
.sys-title{font-size:11px;letter-spacing:.03em;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.sys-facts{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;min-width:0;flex:1 1 300px}
.sys-fact{display:inline-flex;align-items:baseline;gap:5px;min-width:0;white-space:nowrap;font-variant-numeric:tabular-nums}
.sys-fact-k{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--dsw-alias-label-caption)}
.sys-fact-v{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;max-width:34ch}
.sys-controls{display:flex;align-items:center;gap:8px;margin-left:auto;flex:none}
.sys-status{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.sys-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption);flex:none}
.sys-dot[data-state=live]{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);animation:sys-pulse 2.8s ease-in-out infinite}
.sys-dot[data-state=idle]{background:var(--dsw-alias-state-warn-primary);animation:sys-pulse 1.8s ease-in-out infinite}
.sys-dot[data-state=offline]{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}
.sys-dot[data-state=paused]{background:var(--dsw-alias-label-tertiary)}
@keyframes sys-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.sys-banner{flex:none;display:flex;align-items:center;gap:8px;min-width:0;padding:5px 10px;border-radius:var(--dsw-radius-sm);border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 28%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-size:11px}
.sys-banner-text{white-space:nowrap;font-weight:600}
.sys-banner-msg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,monospace)}
.sys-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);height:24px;padding:0 9px;font-size:11px;display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap}
@media(hover:hover){.sys-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
.sys-btn:active{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}
.sys-interval{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-caption);font-size:10px;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap}
.sys-select{height:24px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);font-family:inherit;font-size:11px;padding:0 4px;cursor:pointer}
.sys-body{flex:1;min-height:0;min-width:0;display:grid;grid-template-columns:minmax(320px,40%) minmax(0,1fr);gap:12px;overflow:hidden}
.sys-left{min-width:0;min-height:0;display:flex;flex-direction:column;gap:10px;overflow:auto;scrollbar-width:thin}
.sys-left > *{flex:0 0 auto}
.sys-panel{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:8px 10px 10px;display:flex;flex-direction:column;gap:6px;min-width:0}
.sys-panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.sys-panel-title{font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--dsw-alias-label-caption);white-space:nowrap}
.sys-panel-extra{font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.sys-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;min-width:0}
.sys-big{font-size:32px;line-height:1;font-weight:500;letter-spacing:-.02em;font-variant-numeric:tabular-nums;flex:none}
.sys-big-unit{font-size:14px;font-weight:400;opacity:.65;margin-left:1px}
.sys-mid{font-size:14px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.sys-hero-note{font-size:10px;line-height:1.35;color:var(--dsw-alias-label-tertiary);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:56%;min-width:0}
.sys-spark-wrap{position:relative;width:100%;min-width:0;overflow:hidden;border-radius:2px;flex:none}
.sys-spark{display:block;overflow:visible}
.sys-spark-grid{stroke:var(--dsw-alias-border-l3);stroke-width:1;stroke-dasharray:3 4;fill:none;opacity:.75}
.sys-spark-area{fill:currentColor;opacity:.14;stroke:none}
.sys-spark-line{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}
.sys-bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.sys-bar-fill{height:100%;border-radius:999px;background:currentColor;transition:width .4s ease}
.sys-cores{display:grid;grid-template-columns:repeat(auto-fit,minmax(6px,1fr));gap:2px;margin-top:2px}
.sys-core{height:28px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 16%,transparent);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2);border-radius:2px;display:flex;align-items:flex-end;overflow:hidden}
.sys-core-fill{width:100%;background:currentColor;border-radius:1px;transition:height .35s ease}
.sys-core-fill[data-active=true]{min-height:2px}
.sys-kv{display:flex;flex-direction:column;gap:1px;font-size:11px;margin-top:2px}
.sys-kv-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0}
.sys-k{color:var(--dsw-alias-label-caption);white-space:nowrap}
.sys-v{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sys-io{display:flex;flex-direction:column;gap:2px;min-width:0}
.sys-io-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;min-width:0}
.sys-io-label{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.sys-io-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.sys-ifaces{display:flex;flex-direction:column;gap:1px;margin-top:2px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:4px}
.sys-iface{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:baseline;gap:10px;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.sys-iface-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.sys-iface-rate{white-space:nowrap}
.sys-meter{display:grid;grid-template-columns:34px minmax(0,1fr) 46px;align-items:center;gap:8px;font-size:10.5px}
.sys-meter-label{color:var(--dsw-alias-label-tertiary)}
.sys-meter-track{height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.sys-meter-fill{height:100%;background:currentColor;border-radius:999px;transition:width .4s ease}
.sys-meter-value{text-align:right;font-variant-numeric:tabular-nums}
.sys-right{min-width:0;min-height:0;display:flex;flex-direction:column;gap:6px}
.sys-table-bar{flex:none;display:flex;align-items:center;gap:10px;min-width:0}
.sys-search{height:26px;flex:1 1 auto;min-width:110px;max-width:340px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11.5px;padding:0 8px}
.sys-search::placeholder{color:var(--dsw-alias-label-caption)}
.sys-count{font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;margin-left:auto}
.sys-table{flex:1;min-height:0;display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.sys-scroll{flex:1;min-height:0;overflow:auto;scrollbar-width:thin;overscroll-behavior:contain}
.sys-tr{display:grid;grid-template-columns:74px 78px 58px 58px 70px 44px 40px 84px minmax(110px,1fr);align-items:center;height:22px;padding:0 8px;font-size:11px;font-variant-numeric:tabular-nums;min-width:0}
.sys-thead{position:sticky;top:0;z-index:2;height:25px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-caption)}
.sys-th{min-width:0;display:flex;align-items:center;justify-content:flex-start;height:100%}
.sys-th.sys-cell-num{justify-content:flex-end}
.sys-th-btn{appearance:none;background:none;border:0;padding:0 4px;margin:0;height:100%;width:100%;display:flex;align-items:center;gap:3px;justify-content:inherit;cursor:pointer;color:inherit;font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;border-radius:var(--dsw-radius-sm);min-width:0}
.sys-th.sys-cell-num .sys-th-btn{justify-content:flex-end;padding-right:0}
@media(hover:hover){.sys-th-btn:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}}
.sys-sort-mark{font-size:7px;line-height:1;color:var(--dsw-alias-label-tertiary)}
.sys-cell{min-width:0;padding-right:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.sys-cell-num{text-align:right;padding-right:10px;padding-left:4px}
.sys-cell.sys-cell-num{padding-right:10px}
.sys-row-selected{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.sys-row-selected .sys-cell{color:var(--dsw-alias-label-primary)}
.sys-pid{appearance:none;background:none;border:0;padding:0 2px;margin:0;border-radius:2px;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.sys-row-selected .sys-pid{color:var(--dsw-alias-brand-primary);font-weight:600}
@media(hover:hover){.sys-pid:hover{text-decoration:underline;text-underline-offset:2px;color:var(--dsw-alias-label-primary)}}
.sys-cmd{color:var(--dsw-alias-label-primary);font-family:inherit}
.sys-state{letter-spacing:.04em}
.sys-empty{display:flex;align-items:center;justify-content:center;height:100%;min-height:80px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.sys-empty-cell{padding:16px}
.sys-foot{flex:none;display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:26px;font-size:11px;min-width:0}
.sys-foot-empty{color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.sys-sel{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto}
.sys-sel-tag{color:var(--dsw-alias-label-caption);font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap}
.sys-sel-cmd{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}
.sys-sel-actions{display:inline-flex;align-items:center;gap:6px;flex:none}
.sys-kill{appearance:none;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);height:22px;padding:0 8px;font-size:10px;letter-spacing:.06em;cursor:pointer;white-space:nowrap}
@media(hover:hover){.sys-kill:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
.sys-kill:disabled{opacity:.55;cursor:default}
.sys-kill.sys-kill-hard{color:var(--dsw-alias-state-error-primary)}
.sys-kill[data-armed=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent);color:var(--dsw-alias-state-error-primary);font-weight:600}
.sys-kill-error{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 28%,transparent);border-radius:var(--dsw-radius-sm);padding:3px 4px 3px 8px}
.sys-kill-error-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto;font-size:10.5px}
.sys-icon-btn{appearance:none;border:0;background:none;color:inherit;font-size:14px;line-height:1;width:20px;height:20px;border-radius:var(--dsw-radius-sm);cursor:pointer;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0}
@media(hover:hover){.sys-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.sys-left::-webkit-scrollbar,.sys-scroll::-webkit-scrollbar{width:8px;height:8px}
.sys-left::-webkit-scrollbar-thumb,.sys-scroll::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb,var(--dsw-alias-border-l3));border-radius:999px}
@media(max-width:1400px){
.sys-tr{grid-template-columns:74px 58px 52px 52px 70px 36px 34px 82px minmax(88px,1fr)}
}
@media(max-width:899px){
.sys-root{padding:12px;padding-top:calc(12px + var(--dsh-frame-top-clearance,0px));font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Arial,sans-serif)}
.sys-header{gap:6px 10px;padding-bottom:8px}
.sys-facts{flex:1 1 100%;gap:2px 10px}
.sys-controls{margin-left:auto}
.sys-body{display:block;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:auto}
.sys-left{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;align-items:start;overflow:visible;min-height:0}
.sys-right{margin-top:12px;min-height:0}
.sys-table{flex:none;height:min(60vh,480px);min-height:320px}
.sys-table-bar{flex-wrap:wrap;gap:6px 10px}
.sys-table-bar .sys-showing{margin-left:auto}
.sys-tr{grid-template-columns:72px 52px 52px 80px minmax(0,1fr);font-size:11px}
.sys-th{padding-right:8px}
.sys-th.sys-cell-num{justify-content:flex-end}
.sys-tr > :nth-child(2),.sys-tr > :nth-child(5),.sys-tr > :nth-child(6),.sys-tr > :nth-child(7){display:none}
.sys-scroll{overscroll-behavior:auto}
.sys-foot{gap:6px}
}
@media(pointer:coarse){
.sys-root{font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Arial,sans-serif)}
.sys-banner-msg{font-family:inherit}
}
@media(max-width:480px){
.sys-root{padding:12px}
.sys-facts{gap:3px 12px}
.sys-fact-v{max-width:22ch}
}
@media(prefers-reduced-motion:reduce){
.sys-dot,.sys-bar-fill,.sys-core-fill,.sys-meter-fill{animation:none;transition:none}
}
.sys-root .sys-sev-ok{color:var(--dsw-alias-state-success-primary)}
.sys-root .sys-sev-warn{color:var(--dsw-alias-state-warn-primary)}
.sys-root .sys-sev-crit{color:var(--dsw-alias-state-error-primary)}
.sys-root .sys-sev-none{color:var(--dsw-alias-label-tertiary)}
.sys-root .sys-tone-a{color:var(--dsw-alias-brand-primary)}
.sys-root .sys-tone-b{color:var(--dsw-alias-label-secondary)}
`;

		/* ------------------------------------------------------------------
		 * exports
		 * ------------------------------------------------------------------ */

		exports.apply = apply;
		exports.inject = inject;
		/* test-only, harmless in production */
		exports.__SysMonPage = SysMonPage;
		exports.__SysMonIcon = SysMonIcon;
		exports.__SysMonBody = SysMonBody;

		return module.exports;
	}
});
