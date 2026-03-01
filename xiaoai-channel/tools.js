#!/usr/bin/env node
/**
 * XiaoAi Device Tools
 *
 * 小爱设备调试工具 — 列出设备、测试音量、测试TTS
 *
 * 用法:
 *   node tools.js list                       # 列出所有可用设备
 *   node tools.js tts "你好世界"              # 对默认设备播放TTS
 *   node tools.js tts "你好世界" --did 设备名  # 对指定设备播放TTS
 *   node tools.js volume                     # 查看当前音量
 *   node tools.js volume 30                  # 设置音量为30
 *   node tools.js status                     # 查看设备状态
 *   node tools.js pause                      # 暂停播放
 *
 * 环境变量（也可用命令行参数）:
 *   MI_DID        设备名称（米家App中的名称）
 *   MI_PASS_TOKEN passToken
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MiNA, MiIOT, getMiNA, getMiIOT } from "mi-service-lite";

// ─── Utilities ──────────────────────────────────────────────

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseVersion(version) {
    return String(version || "")
        .split(".")
        .map((part) => Number.parseInt(part, 10))
        .map((num) => (Number.isFinite(num) ? num : 0));
}

function compareVersion(a, b) {
    const av = parseVersion(a);
    const bv = parseVersion(b);
    const len = Math.max(av.length, bv.length);
    for (let i = 0; i < len; i++) {
        const ai = av[i] ?? 0;
        const bi = bv[i] ?? 0;
        if (ai > bi) return 1;
        if (ai < bi) return -1;
    }
    return 0;
}

function getSystemVersion(device) {
    const candidates = [
        device?.romVersion,
        device?.rom_version,
        device?.systemVersion,
        device?.sysVersion,
        device?.version,
        device?.fwVersion,
    ];
    for (const value of candidates) {
        const str = String(value || "").trim();
        if (str) return str;
    }
    return "";
}

function normalizeTtsEngine(raw) {
    const value = String(raw || "").trim().toLowerCase();
    if (value === "miot" || value === "mina" || value === "auto") return value;
    return "auto";
}

function chooseTtsEngine({ systemVersion, hasMiIOT, overrideEngine }) {
    const override = normalizeTtsEngine(overrideEngine);
    if (override === "miot") return hasMiIOT ? "miot" : "mina";
    if (override === "mina") return "mina";
    if (!hasMiIOT) return "mina";

    // LX04 older firmware is usually more stable via MiNA first.
    if (systemVersion && compareVersion(systemVersion, "2.90.0") < 0) {
        return "mina";
    }
    return "miot";
}

async function playTTSWithFallback({ mina, miiot, text, systemVersion, overrideEngine }) {
    const preferred = chooseTtsEngine({
        systemVersion,
        hasMiIOT: Boolean(miiot),
        overrideEngine,
    });
    const order = preferred === "miot" ? ["miot", "mina"] : ["mina", "miot"];
    let lastError = null;

    for (const engine of order) {
        if (engine === "miot") {
            if (!miiot) continue;
            try {
                const ok = await miiot.doAction(5, 1, [{ text, type: 0 }]);
                if (ok) return { ok: true, engine: "MiIOT" };
            } catch (err) {
                lastError = err;
            }
            continue;
        }

        try {
            const ok = await mina.play({ tts: text });
            if (ok !== false) return { ok: true, engine: "MiNA" };
        } catch (err) {
            lastError = err;
        }
    }

    if (lastError) {
        throw lastError;
    }
    return { ok: false, engine: preferred === "miot" ? "MiIOT" : "MiNA" };
}

// ─── Helpers ────────────────────────────────────────────────

function printUsage() {
    console.log(`
小爱设备调试工具 (XiaoAi Device Tools)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

用法:
  node tools.js list                            列出所有可用设备
  node tools.js tts <文本> [--did <设备名>]      播放TTS文本
  node tools.js volume [数值] [--did <设备名>]   查看/设置音量 (0-100)
  node tools.js status [--did <设备名>]          查看设备播放状态
  node tools.js pause [--did <设备名>]           暂停当前播放
  node tools.js test-interrupt [--did <设备名>]  测试打断小爱回复

认证方式:
  命令行参数:  --pass-token <passToken>
  环境变量:    MI_PASS_TOKEN
    TTS引擎:     --tts-engine auto|miot|mina (默认 auto)

示例:
  node tools.js list --pass-token "V1:xxx..."
  node tools.js tts "今天天气真好" --did "小爱音箱Pro"
  node tools.js volume 50
  node tools.js volume 20 --did "卧室的小爱"
  node tools.js test-interrupt
    node tools.js tts "你好" --tts-engine mina
`);
}

function parseArgs(argv) {
    const args = { _: [] };
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        if (arg === "--pass-token") {
            args.passToken = argv[++i];
        } else if (arg === "--did") {
            args.did = argv[++i];
        } else if (arg === "--trace") {
            args.trace = true;
        } else if (arg === "--tts-engine") {
            args.ttsEngine = argv[++i];
        } else if (arg === "--help" || arg === "-h") {
            args.help = true;
        } else {
            args._.push(arg);
        }
        i++;
    }
    return args;
}

function getCredentials(args) {
    const passToken = args.passToken || process.env.MI_PASS_TOKEN || "";
    const did = args.did || process.env.MI_DID || "";
    const ttsEngine = normalizeTtsEngine(args.ttsEngine || process.env.MI_TTS_ENGINE || "auto");

    if (!passToken) {
        console.error("❌ 缺少 passToken。请通过 --pass-token 或 MI_PASS_TOKEN 环境变量提供。");
        console.error("   示例: node tools.js list --pass-token \"V1:xxx...\"");
        process.exit(1);
    }
    return { passToken, did, trace: Boolean(args.trace), ttsEngine };
}

/**
 * Write passToken to ~/.mi.json for mi-service-lite authentication.
 * Returns the cached userId from the store, if available.
 */
async function ensurePassToken(passToken) {
    if (!passToken) return null;
    const miJsonPath = path.join(os.homedir(), ".mi.json");
    let store = {};
    try {
        const raw = await fs.readFile(miJsonPath, "utf8");
        store = JSON.parse(raw) || {};
    } catch {
        // file doesn't exist yet
    }

    const needsUpdate =
        !store.mina?.pass?.passToken ||
        store.mina.pass.passToken !== passToken ||
        !store.miiot?.pass?.passToken ||
        store.miiot.pass.passToken !== passToken;

    if (needsUpdate) {
        if (!store.mina) store.mina = {};
        if (!store.mina.pass) store.mina.pass = {};
        store.mina.pass.passToken = passToken;

        if (!store.miiot) store.miiot = {};
        if (!store.miiot.pass) store.miiot.pass = {};
        store.miiot.pass.passToken = passToken;

        await fs.writeFile(miJsonPath, JSON.stringify(store, null, 2), "utf8");
    }

    // Return cached userId (phone number or numeric ID) for API calls
    return store.mina?.userId || store.miiot?.userId || null;
}

async function createMiNA(creds) {
    await ensurePassToken(creds.passToken);
    // Read cached credentials from ~/.mi.json (written by previous login or ensurePassToken)
    const miJsonPath = path.join(os.homedir(), ".mi.json");
    let store = {};
    try {
        store = JSON.parse(await fs.readFile(miJsonPath, "utf8")) || {};
    } catch { /* empty */ }
    const account = store.mina || {};
    // Use numeric userId from pass (more reliable than phone-number userId)
    const userId = account.pass?.userId || account.userId || "";
    const password = account.password || "";
    if (!userId) {
        console.error("❌ ~/.mi.json 中没有缓存的账号信息。请先用 miUser+miPass 登录一次（通过 OpenClaw 配置）。");
        process.exit(1);
    }
    const mina = await getMiNA({
        userId,
        password,
        did: creds.did || account.did || undefined,
        enableTrace: creds.trace,
    });
    if (!mina) {
        console.error("❌ MiNA 初始化失败，请检查账号密码和设备名称。");
        process.exit(1);
    }
    return mina;
}

async function createMiIOT(creds, miotDid) {
    if (!miotDid) return null;
    try {
        await ensurePassToken(creds.passToken);
        const miJsonPath = path.join(os.homedir(), ".mi.json");
        let store = {};
        try {
            store = JSON.parse(await fs.readFile(miJsonPath, "utf8")) || {};
        } catch { /* empty */ }
        const account = store.miiot || {};
        const userId = account.pass?.userId || account.userId || store.mina?.pass?.userId || store.mina?.userId || "";
        const password = account.password || store.mina?.password || "";
        const miiot = await getMiIOT({
            userId,
            password,
            did: miotDid,
            enableTrace: creds.trace,
        });
        return miiot ?? null;
    } catch {
        return null;
    }
}



// ─── Commands ───────────────────────────────────────────────

/**
 * List all available XiaoAi devices.
 */
async function cmdList(creds) {
    console.log("🔍 正在获取设备列表...\n");

    const mina = await createMiNA(creds);
    const devices = await mina.getDevices();

    if (!devices || !Array.isArray(devices) || devices.length === 0) {
        console.log("未找到任何设备。");
        return;
    }

    console.log(`找到 ${devices.length} 个设备:\n`);
    console.log("┌─────┬──────────────────────┬──────────────┬────────────┬──────────┬──────────────────┐");
    console.log("│ #   │ 名称                 │ 型号         │ 系统版本   │ 状态     │ miotDID          │");
    console.log("├─────┼──────────────────────┼──────────────┼────────────┼──────────┼──────────────────┤");

    for (let i = 0; i < devices.length; i++) {
        const d = devices[i];
        const num = String(i + 1).padEnd(3);
        const name = (d.name || d.alias || "未知").padEnd(20).slice(0, 20);
        const hw = (d.hardware || d.model || "").padEnd(12).slice(0, 12);
        const sys = (getSystemVersion(d) || "未知").padEnd(10).slice(0, 10);
        const status = d.presence === "online" ? "🟢 在线 " : "🔴 离线 ";
        const miotDid = (d.miotDID || "").padEnd(16).slice(0, 16);
        console.log(`│ ${num} │ ${name} │ ${hw} │ ${sys} │ ${status} │ ${miotDid} │`);
    }
    console.log("└─────┴──────────────────────┴──────────────┴────────────┴──────────┴──────────────────┘");

    // Show the current connected device
    const cur = mina.account?.device;
    if (cur) {
        console.log(`\n当前连接的设备: ${cur.name || cur.alias || "未知"} (${cur.hardware || ""})`);
        console.log(`  deviceId:     ${cur.deviceID || cur.deviceId || ""}`);
        console.log(`  serialNumber: ${cur.serialNumber || ""}`);
        console.log(`  systemVersion:${getSystemVersion(cur) || "未知"}`);
        console.log(`  miotDID:      ${cur.miotDID || ""}`);
        console.log(`  mac:          ${cur.mac || ""}`);
    }
}

/**
 * Play TTS text on the device.
 */
async function cmdTTS(creds, text) {
    if (!text) {
        console.error("❌ 请提供要播放的文本。示例: node tools.js tts \"你好世界\"");
        process.exit(1);
    }

    console.log(`🔊 正在连接设备...`);
    const mina = await createMiNA(creds);
    const device = mina.account?.device;
    const systemVersion = getSystemVersion(device);
    console.log(`✓ 已连接: ${device?.name || "未知"} (${device?.hardware || ""})`);
    if (systemVersion) {
        console.log(`✓ 系统版本: ${systemVersion}`);
    }

    // Try MiIOT first for newer firmware
    const miotDid = device?.miotDID;
    const miiot = await createMiIOT(creds, miotDid);
    if (miiot) {
        console.log(`✓ MiIOT 可用 (did=${miotDid})`);
    }

    console.log(`\n📢 播放TTS: "${text}"\n`);

    try {
        const result = await playTTSWithFallback({
            mina,
            miiot,
            text,
            systemVersion,
            overrideEngine: creds.ttsEngine,
        });
        console.log(result.ok ? `✅ TTS 播放成功 (via ${result.engine})` : "❌ TTS 播放失败");
    } catch (err) {
        console.error(`❌ TTS 播放失败: ${err.message}`);
        process.exit(1);
    }
}

/**
 * Get or set volume.
 */
async function cmdVolume(creds, value) {
    console.log(`🔊 正在连接设备...`);
    const mina = await createMiNA(creds);
    const device = mina.account?.device;
    console.log(`✓ 已连接: ${device?.name || "未知"} (${device?.hardware || ""})\n`);

    if (value === undefined || value === null) {
        // Get current volume
        const vol = await mina.getVolume();
        if (vol !== undefined) {
            const bar = "█".repeat(Math.round(vol / 5)) + "░".repeat(20 - Math.round(vol / 5));
            console.log(`🔊 当前音量: ${vol}`);
            console.log(`   [${bar}] ${vol}%`);
        } else {
            console.log("❌ 无法获取音量");
        }
    } else {
        const vol = Math.max(0, Math.min(100, Number(value)));
        if (Number.isNaN(vol)) {
            console.error("❌ 音量值无效，请输入 0-100 的数字。");
            process.exit(1);
        }

        // Get current volume first
        const currentVol = await mina.getVolume();
        if (currentVol !== undefined) {
            console.log(`   当前音量: ${currentVol}`);
        }

        const success = await mina.setVolume(vol);
        if (success) {
            const bar = "█".repeat(Math.round(vol / 5)) + "░".repeat(20 - Math.round(vol / 5));
            console.log(`✅ 音量已设置为: ${vol}`);
            console.log(`   [${bar}] ${vol}%`);
        } else {
            console.error("❌ 设置音量失败");
            process.exit(1);
        }
    }
}

/**
 * Get device status.
 */
async function cmdStatus(creds) {
    console.log(`🔍 正在连接设备...`);
    const mina = await createMiNA(creds);
    const device = mina.account?.device;
    console.log(`✓ 已连接: ${device?.name || "未知"} (${device?.hardware || ""})\n`);

    const status = await mina.getStatus();
    if (!status) {
        console.log("❌ 无法获取设备状态");
        return;
    }

    const statusLabels = {
        idle: "⏹️  空闲",
        playing: "▶️  播放中",
        paused: "⏸️  已暂停",
        stopped: "⏹️  已停止",
        unknown: "❓ 未知",
    };

    console.log("设备状态:");
    console.log(`  播放状态: ${statusLabels[status.status] || status.status}`);
    console.log(`  音量:     ${status.volume ?? "未知"}`);
    if (status.media_type !== undefined) {
        const mediaTypes = { 0: "空", 1: "音乐", 2: "有声书", 3: "FM" };
        console.log(`  媒体类型: ${mediaTypes[status.media_type] ?? status.media_type}`);
    }
    if (status.loop_type !== undefined) {
        const loopTypes = { 0: "列表循环", 1: "单曲循环", 2: "随机播放", 3: "单曲播放" };
        console.log(`  循环模式: ${loopTypes[status.loop_type] ?? status.loop_type}`);
    }
}

/**
 * Pause playback.
 */
async function cmdPause(creds) {
    console.log(`⏸️  正在连接设备...`);
    const mina = await createMiNA(creds);
    const device = mina.account?.device;
    const systemVersion = getSystemVersion(device);
    console.log(`✓ 已连接: ${device?.name || "未知"} (${device?.hardware || ""})\n`);

    // Try MiIOT first
    const miotDid = device?.miotDID;
    const miiot = await createMiIOT(creds, miotDid);
    const preferredEngine = chooseTtsEngine({
        systemVersion,
        hasMiIOT: Boolean(miiot),
        overrideEngine: creds.ttsEngine,
    });

    try {
        if (preferredEngine === "miot" && miiot) {
            await miiot.doAction(3, 2, []);
            console.log("✅ 已暂停播放 (via MiIOT)");
        } else {
            const success = await mina.pause();
            if (success) {
                console.log("✅ 已暂停播放 (via MiNA)");
            } else if (miiot) {
                await miiot.doAction(3, 2, []).catch(() => {});
                console.log("⚠️  MiNA 暂停未确认，已补发 MiIOT stop");
            } else {
                console.log("⚠️  暂停命令已发送（设备可能未在播放）");
            }
        }
    } catch (err) {
        console.log(`⚠️  暂停失败 (可能当前没有在播放): ${err.message}`);
    }
}

/**
 * Test the aggressive interrupt mechanism.
 * Plays a long TTS via MiIOT, waits 3 seconds, then tries to forcefully stop it
 * using the same strategy as forceStopXiaoaiResponse in index.js.
 */
async function cmdTestInterrupt(creds) {
    console.log(`🧪 打断测试: 先播放长文本，3秒后尝试打断\n`);

    const mina = await createMiNA(creds);
    const device = mina.account?.device;
    const systemVersion = getSystemVersion(device);
    console.log(`✓ 已连接: ${device?.name || "未知"} (${device?.hardware || ""})`);
    if (systemVersion) {
        console.log(`✓ 系统版本: ${systemVersion}`);
    }

    const miotDid = device?.miotDID;
    const miiot = await createMiIOT(creds, miotDid);
    if (miiot) console.log(`✓ MiIOT 可用 (did=${miotDid})`);

    // Step 1: Play a long text via MiIOT (same channel XiaoAi uses for responses)
    const longText = "这是一段用于测试打断功能的长文本。" +
        "我现在正在说一段很长很长的话，目的是测试系统能不能成功打断我。" +
        "如果你听到了这句话的全部内容，说明打断失败了。" +
        "系统应该在我说话的过程中把我打断。" +
        "打断之后你应该会听到一条确认消息，告诉你测试成功。" +
        "现在我继续说，继续说，继续说，一直说到被打断为止。" +
        "这段话足够长，应该要说十几秒钟才能说完。";

    console.log(`\n📢 Step 1: 播放长文本...`);
    if (miiot) {
        await miiot.doAction(5, 1, [{ text: longText, type: 0 }]).catch(() => {});
    } else {
        await mina.play({ tts: longText }).catch(() => {});
    }

    console.log(`⏳ Step 2: 等待 3 秒让设备开始播放...`);
    await sleep(3000);

    // Step 3: Interrupt using same strategy as forceStopXiaoaiResponse
    // Key discovery: MiNA TTS CANNOT override MiNA TTS, but MiIOT doAction CAN.
    // XiaoAi's built-in response uses MiNA TTS channel.
    console.log(`\n🛑 Step 3: 执行打断...`);
    const startMs = Date.now();

    const preferredEngine = chooseTtsEngine({
        systemVersion,
        hasMiIOT: Boolean(miiot),
        overrideEngine: creds.ttsEngine,
    });

    if (preferredEngine === "miot" && miiot) {
        // Use MiIOT doAction to override the MiNA TTS (different audio pipeline)
        console.log(`   使用 MiIOT doAction 覆盖 MiNA TTS...`);
        await miiot.doAction(5, 1, [{ text: "，", type: 0 }]).catch(() => {});
        console.log(`   MiIOT 覆盖已发送 (${Date.now() - startMs}ms)`);

        // Brief pause then stop the comma TTS
        await sleep(200);
        console.log(`   发送 MiIOT stop...`);
        await miiot.doAction(3, 2, []).catch(() => {});
        console.log(`   MiIOT stop 完成 (${Date.now() - startMs}ms)`);
    } else {
        // Strategy fallback for firmware where MiNA is preferred.
        console.log(`   ⚠️ 当前策略回退到 stop+pause (可能无法打断TTS)...`);
        await Promise.allSettled([
            mina.stop().catch(() => {}),
            mina.pause().catch(() => {}),
        ]);
        console.log(`   stop+pause 完成 (${Date.now() - startMs}ms)`);
    }

    const elapsed = Date.now() - startMs;
    console.log(`\n✅ 打断命令已全部发送 (总耗时 ${elapsed}ms)`);

    // Step 4: Wait and play confirmation
    await sleep(800);
    console.log(`\n📢 Step 4: 播放确认消息...`);
    if (preferredEngine === "miot" && miiot) {
        await miiot.doAction(5, 1, [{ text: "打断测试完成。如果你没有听到之前那段长文本的结尾，说明打断成功了。", type: 0 }]).catch(() => {});
    } else {
        await mina.play({ tts: "打断测试完成。如果你没有听到之前那段长文本的结尾，说明打断成功了。" }).catch(() => {});
    }
    console.log(`✅ 测试完成\n`);
    console.log(`提示: 如果你仍然听到了长文本的全部内容，说明打断机制对此设备无效。`);
    console.log(`      这种情况下，可以尝试降低轮询间隔 (pollInterval) 来更早检测到新对话。`);
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help || args._.length === 0) {
        printUsage();
        process.exit(0);
    }

    const command = args._[0].toLowerCase();

    const creds = getCredentials(args);

    switch (command) {
        case "list":
        case "ls":
        case "devices":
            await cmdList(creds);
            break;

        case "tts":
        case "say":
        case "speak":
            await cmdTTS(creds, args._[1] || "");
            break;

        case "volume":
        case "vol":
            await cmdVolume(creds, args._[1]);
            break;

        case "status":
        case "info":
            await cmdStatus(creds);
            break;

        case "pause":
        case "stop":
            await cmdPause(creds);
            break;

        case "test-interrupt":
        case "interrupt":
            await cmdTestInterrupt(creds);
            break;

        default:
            console.error(`❌ 未知命令: ${command}`);
            printUsage();
            process.exit(1);
    }
}

main().catch((err) => {
    console.error(`\n❌ 错误: ${err.message}`);
    if (err.stack && process.env.DEBUG) {
        console.error(err.stack);
    }
    process.exit(1);
});
