/**
 * OpenClaw XiaoAi Channel Plugin
 *
 * 将小爱同学智能音箱变成 OpenClaw 的对话通道。
 * 通过小米云服务 API 轮询用户对话，转发给 OpenClaw Agent，
 * 然后将 Agent 回复通过小爱 TTS 播报。
 *
 * 架构：
 *   用户 → 小爱同学(语音) → 小米云(对话记录) → 本插件(轮询)
 *     → OpenClaw(Agent) → 本插件(回复) → 小爱同学(TTS播报)
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CHANNEL_ID = "xiaoai";
const MI_CACHE_BACKUP_PATH = path.join(os.homedir(), ".openclaw", "xiaoai-mi-cache.json");

// ─── Plugin SDK Loader ──────────────────────────────────────

let getReplyFromConfigLoader = null;

async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function resolvePluginSdkIndexPath() {
    const candidates = [
        "/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/index.js",
        "/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/index.js",
    ];

    const openclawBinCandidates = [
        "/opt/homebrew/bin/openclaw",
        "/usr/local/bin/openclaw",
        "/opt/local/bin/openclaw",
    ];
    for (const binPath of openclawBinCandidates) {
        try {
            const realBin = await fs.realpath(binPath);
            const packageRoot = path.dirname(realBin);
            candidates.push(path.join(packageRoot, "dist/plugin-sdk/index.js"));
        } catch {
            // ignore
        }
    }

    for (const candidate of candidates) {
        if (await fileExists(candidate)) {
            return candidate;
        }
    }

    throw new Error(
        `cannot locate OpenClaw plugin-sdk index.js (checked: ${candidates.join(",")})`,
    );
}

async function resolveGetReplyFromConfigFn() {
    const indexPath = await resolvePluginSdkIndexPath();
    const sdkDir = path.dirname(indexPath);
    const entries = await fs.readdir(sdkDir, { withFileTypes: true });
    const candidates = entries
        .filter((entry) => entry.isFile() && /^reply-.*\.js$/.test(entry.name))
        .map((entry) => path.join(sdkDir, entry.name))
        .sort();

    for (const candidate of candidates) {
        const replyModule = await import(pathToFileURL(candidate).href);
        const byName = Object.values(replyModule).find(
            (v) => typeof v === "function" && v.name === "getReplyFromConfig",
        );
        if (typeof byName === "function") {
            return byName;
        }
    }

    throw new Error("plugin-sdk getReplyFromConfig export is unavailable");
}

async function loadGetReplyFromConfig() {
    if (!getReplyFromConfigLoader) {
        getReplyFromConfigLoader = resolveGetReplyFromConfigFn();
    }
    return getReplyFromConfigLoader;
}

// ─── MiNA helpers ───────────────────────────────────────────

function hasUsableMiCredentials(store) {
    const mina = store?.mina || {};
    const miiot = store?.miiot || {};
    const minaUserId = mina.pass?.userId || mina.userId;
    const minaPassword = mina.password;
    const miiotUserId = miiot.pass?.userId || miiot.userId || minaUserId;
    const miiotPassword = miiot.password || minaPassword;
    return Boolean(minaUserId && minaPassword && miiotUserId && miiotPassword);
}

async function readMiCacheBackup() {
    try {
        const raw = await fs.readFile(MI_CACHE_BACKUP_PATH, "utf8");
        return JSON.parse(raw) || {};
    } catch {
        return {};
    }
}

async function writeMiCacheBackup(store) {
    const payload = {
        mina: {
            userId: store?.mina?.userId || "",
            password: store?.mina?.password || "",
            did: store?.mina?.did || "",
            pass: {
                userId: store?.mina?.pass?.userId || "",
                passToken: store?.mina?.pass?.passToken || "",
            },
        },
        miiot: {
            userId: store?.miiot?.userId || "",
            password: store?.miiot?.password || "",
            did: store?.miiot?.did || "",
            pass: {
                userId: store?.miiot?.pass?.userId || "",
                passToken: store?.miiot?.pass?.passToken || "",
            },
        },
    };
    await fs.mkdir(path.dirname(MI_CACHE_BACKUP_PATH), { recursive: true });
    await fs.writeFile(MI_CACHE_BACKUP_PATH, JSON.stringify(payload, null, 2), "utf8");
}

function mergeMissingMiCredentials(store, backup) {
    const result = { ...store };
    if (!result.mina) result.mina = {};
    if (!result.mina.pass) result.mina.pass = {};
    if (!result.miiot) result.miiot = {};
    if (!result.miiot.pass) result.miiot.pass = {};

    if (!result.mina.userId && backup?.mina?.userId) result.mina.userId = backup.mina.userId;
    if (!result.mina.password && backup?.mina?.password) result.mina.password = backup.mina.password;
    if (!result.mina.did && backup?.mina?.did) result.mina.did = backup.mina.did;
    if (!result.mina.pass.userId && backup?.mina?.pass?.userId) {
        result.mina.pass.userId = backup.mina.pass.userId;
    }

    if (!result.miiot.userId && backup?.miiot?.userId) result.miiot.userId = backup.miiot.userId;
    if (!result.miiot.password && backup?.miiot?.password) result.miiot.password = backup.miiot.password;
    if (!result.miiot.did && backup?.miiot?.did) result.miiot.did = backup.miiot.did;
    if (!result.miiot.pass.userId && backup?.miiot?.pass?.userId) {
        result.miiot.pass.userId = backup.miiot.pass.userId;
    }

    return result;
}

/**
 * Ensure .mi.json contains the passToken for authentication.
 * This is needed because mi-service-lite reads passToken from .mi.json
 * to bypass Xiaomi's securityStatus:16 verification.
 */
async function ensureMiJsonPassToken(account) {
    const miJsonPath = path.join(os.homedir(), ".mi.json");
    let store = {};
    try {
        const raw = await fs.readFile(miJsonPath, "utf8");
        store = JSON.parse(raw) || {};
    } catch {
        // file doesn't exist yet
    }

    const passToken = account.passToken;
    if (!passToken) return store; // no passToken configured

    let restoredCredentials = false;
    if (!hasUsableMiCredentials(store)) {
        const backup = await readMiCacheBackup();
        const merged = mergeMissingMiCredentials(store, backup);
        restoredCredentials = JSON.stringify(merged) !== JSON.stringify(store);
        store = merged;
    }

    // Only write passToken if the stored one is different or missing
    const needsUpdate = (
        !store.mina?.pass?.passToken ||
        store.mina.pass.passToken !== passToken ||
        !store.miiot?.pass?.passToken ||
        store.miiot.pass.passToken !== passToken
    );

    if (needsUpdate || restoredCredentials) {
        // Preserve existing store data, only update passToken
        if (!store.mina) store.mina = {};
        if (!store.mina.pass) store.mina.pass = {};
        store.mina.pass.passToken = passToken;

        if (!store.miiot) store.miiot = {};
        if (!store.miiot.pass) store.miiot.pass = {};
        store.miiot.pass.passToken = passToken;

        await fs.writeFile(miJsonPath, JSON.stringify(store, null, 2), "utf8");
    }

    if (hasUsableMiCredentials(store)) {
        await writeMiCacheBackup(store).catch(() => {});
    }

    return store;
}

/**
 * Initialize MiNA service for a given account.
 * Returns an MiNA instance or throws.
 *
 * Uses passToken + cached credentials from ~/.mi.json for authentication.
 * The numeric userId (pass.userId) is used instead of phone number to avoid
 * cookie/serviceToken mismatch causing 401 errors.
 */
async function initMiNA(account) {
    // Write passToken to .mi.json and read cached credentials
    const store = await ensureMiJsonPassToken(account);
    const cached = store?.mina || {};
    // Prefer numeric userId from pass (avoids phone-number mismatch)
    const userId = cached.pass?.userId || cached.userId || "";
    const password = cached.password || "";

    if (!userId) {
        throw new Error(
            `MiNA 初始化失败: ~/.mi.json 中没有缓存的账号信息。\n` +
            `请先使用 miUser+miPass 登录一次，之后只需 passToken 即可。`,
        );
    }

    const { getMiNA } = await import("mi-service-lite");
    const did = account.did || account.hardware || "LX04";
    const mina = await getMiNA({
        userId,
        password,
        did,
        enableTrace: Boolean(account.enableTrace),
    });
    if (!mina) {
        throw new Error(
            `MiNA 初始化失败: 请检查 passToken 和设备名称 ` +
            `(did=${did})\n` +
            `提示: did 应为米家中的设备名称(如"小爱触屏音箱")，而非型号(如"LX04")`,
        );
    }
    return mina;
}

/**
 * Initialize MiIOT service for TTS on newer firmware (e.g. 2.99.99).
 * Uses miotDID from MiNA device info, or account.miotDid override.
 * Returns null if unavailable (falls back to MiNA play).
 */
async function initMiIOT(account, miotDid) {
    if (!miotDid) return null;
    try {
        const store = await ensureMiJsonPassToken(account);
        const cached = store?.miiot || store?.mina || {};
        const userId = cached.pass?.userId || cached.userId || "";
        const password = cached.password || "";
        const { getMiIOT } = await import("mi-service-lite");
        const miiot = await getMiIOT({
            userId,
            password,
            did: miotDid,
            enableTrace: Boolean(account.enableTrace),
        });
        return miiot ?? null;
    } catch {
        return null;
    }
}

/**
 * Get the latest conversation record from XiaoAi.
 */
async function getLastConversation(mina) {
    try {
        const convs = await mina.getConversations({ limit: 2 });
        if (!convs?.records?.length) return null;

        const last = convs.records[0];
        const query = last.query?.trim() ?? "";
        let answer = "";
        if (last.answers?.length) {
            const first = last.answers[0];
            if (first.type === "TTS" && first.tts?.text) {
                answer = first.tts.text;
            }
        }
        return { query, answer, timestamp: last.time ?? 0 };
    } catch (err) {
        return null;
    }
}

/**
 * Send TTS text via XiaoAi speaker.
 */
async function ttsPlay(mina, text, miiot, playbackOptions = {}) {
    const normalizedText = normalizeTtsText(text);
    if (!normalizedText) return;

    const preferred = chooseTtsEngine(playbackOptions, Boolean(miiot));
    const order = preferred === "miot" ? ["miot", "mina"] : ["mina", "miot"];
    let lastError = null;

    for (const engine of order) {
        if (engine === "miot") {
            if (!miiot) continue;
            try {
                const ok = await miiot.doAction(5, 1, [{ text: normalizedText, type: 0 }]);
                if (ok) return;
            } catch (err) {
                lastError = err;
            }
            continue;
        }

        try {
            const ok = await mina.play({ tts: normalizedText });
            if (ok !== false) return;
        } catch (err) {
            lastError = err;
        }
    }

    if (lastError) {
        throw lastError;
    }
}

/**
 * Pause/stop current XiaoAi response.
 */
async function ttsPause(mina, miiot) {
    try {
        if (miiot) {
            await miiot.doAction(3, 2, []);
        } else {
            await mina.pause();
        }
    } catch {
        // often normal if nothing is playing
    }
}

/**
 * Aggressively stop XiaoAi's own response.
 *
 * The problem: by the time we detect a new query via polling,
 * XiaoAi has already started (or even finished) its built-in response.
 *
 * Key insight (tested on LX04 firmware 2.99.99):
 *   - XiaoAi's built-in response uses the MiNA TTS channel
 *   - MiNA TTS CANNOT override another MiNA TTS (sending a new one is ignored)
 *   - MiIOT doAction(5,1) CAN override MiNA TTS (different audio pipeline)
 *   - stop/pause only affect media playback, NOT TTS
 *
 * Therefore the ONLY reliable way to interrupt XiaoAi's response is
 * to send a MiIOT doAction(5,1) with a silent/minimal text.
 *
 * NOTE: On firmware 2.99.99, all TTS calls (MiNA and MiIOT) prepend/append
 * the word "test". This is a firmware-level debug marker and cannot be
 * avoided through software.
 */
async function forceStopXiaoaiResponse(mina, miiot, log, playbackOptions = {}) {
    const preferred = chooseTtsEngine(playbackOptions, Boolean(miiot));
    if (preferred === "miot" && miiot) {
        // MiIOT doAction is the only method that can override MiNA TTS.
        // Send a silent comma to replace XiaoAi's current response.
        log?.debug?.("  打断: 使用 MiIOT doAction 覆盖小爱回复...");
        await miiot.doAction(5, 1, [{ text: "，", type: 0 }]).catch(() => {});
        // Brief pause then stop the comma TTS
        await sleep(200);
        await miiot.doAction(3, 2, []).catch(() => {});
    } else {
        // Old firmware usually works better with stop/pause first.
        log?.debug?.("  打断: 使用 stop+pause...");
        await Promise.allSettled([
            mina.stop().catch(() => {}),
            mina.pause().catch(() => {}),
        ]);
        if (miiot) {
            // Best-effort extra stop for mixed firmware behavior.
            await miiot.doAction(3, 2, []).catch(() => {});
        }
    }

    log?.debug?.("  打断命令已发送");
}

/**
 * Split long text at sentence boundaries for TTS.
 */
function splitTextForTTS(text, maxLen = 200) {
    text = text.trim();
    if (!text) return [];
    if (text.length <= maxLen) return [text];

    const chunks = [];
    const seps = ["。", "！", "？", "；", "\n", ".", "!", "?", ";", "，", ","];

    while (text) {
        if (text.length <= maxLen) {
            chunks.push(text);
            break;
        }
        let pos = -1;
        for (const sep of seps) {
            const found = text.lastIndexOf(sep, maxLen);
            if (found > maxLen / 3) {
                pos = found + sep.length;
                break;
            }
        }
        if (pos <= 0) pos = maxLen;
        const chunk = text.slice(0, pos).trim();
        if (chunk) chunks.push(chunk);
        text = text.slice(pos).trim();
    }
    return chunks;
}

/**
 * TTS a long text in segments with estimated wait between chunks.
 */
async function ttsLongText(mina, text, chunkSize = 200, miiot, playbackOptions = {}) {
    const chunks = splitTextForTTS(text, chunkSize);
    for (let i = 0; i < chunks.length; i++) {
        if (i > 0) {
            const waitMs = Math.max(chunks[i - 1].length * 200, 2000);
            await sleep(waitMs);
        }
        await ttsPlay(mina, chunks[i], miiot, playbackOptions);
    }
}

// ─── Config Helpers ─────────────────────────────────────────

function normalizeAccountsConfig(accountsValue) {
    if (!accountsValue) return {};
    if (Array.isArray(accountsValue)) {
        const normalized = {};
        for (let i = 0; i < accountsValue.length; i++) {
            const entry = accountsValue[i];
            if (!entry || typeof entry !== "object") continue;
            const rawId = typeof entry.id === "string" ? entry.id.trim() : "";
            const fallbackId = i === 0 ? "default" : `account-${i + 1}`;
            const id = rawId || fallbackId;
            normalized[id] = { ...entry, id };
        }
        return normalized;
    }
    return typeof accountsValue === "object" ? accountsValue : {};
}

function resolveAccountSection(cfg, accountId) {
    const section = cfg?.channels?.[CHANNEL_ID] ?? {};
    const accountKey = accountId ?? "default";
    const accounts = normalizeAccountsConfig(section?.accounts);
    const acct =
        accounts[accountKey] && typeof accounts[accountKey] === "object"
            ? accounts[accountKey]
            : {};

    // Inherit shared passToken from channel-level config.
    // Account-level value takes priority over channel-level.
    const passToken = acct.passToken || section.passToken || "";
    const ttsEngine = acct.ttsEngine || section.ttsEngine || "auto";
    const startupVolume = acct.startupVolume ?? section.startupVolume;

    return {
        enabled: section?.enabled !== false,
        ...acct,
        passToken,
        ttsEngine,
        startupVolume,
        accountId: accountKey,
        hasAccountSection:
            Boolean(acct && typeof acct === "object" && Object.keys(acct).length > 0),
    };
}

/**
 * Check if a query should be forwarded to OpenClaw.
 * Returns false for blacklisted keywords; checks trigger prefix.
 */
function shouldForward(query, account) {
    const q = (query ?? "").toLowerCase().trim();
    if (!q) return false;

    const blacklist = (account.keywordBlacklist ?? "播放音乐,放首歌,定闹钟,设闹钟,几点了,打开,关闭,音量")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);

    for (const kw of blacklist) {
        if (q.includes(kw)) return false;
    }

    const prefix = (account.triggerPrefix ?? "").toLowerCase();
    if (prefix && !q.startsWith(prefix)) return false;

    return true;
}

/**
 * Strip trigger prefix from user query.
 */
function extractQuery(query, account) {
    const prefix = account.triggerPrefix ?? "";
    if (prefix && query.toLowerCase().startsWith(prefix.toLowerCase())) {
        query = query.slice(prefix.length);
    }
    return query.trim();
}

function sanitizeSessionPart(value) {
    return String(value ?? "")
        .trim()
        .replace(/[:\s]+/g, "-")
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 96);
}

// ─── Inbound Processing ─────────────────────────────────────

/**
 * Process a new user query through OpenClaw agent pipeline.
 */
async function processInboundQuery(ctx, mina, query, account, miiot) {
    const accountLabel = sanitizeSessionPart(ctx.accountId || "default") || "default";
    const senderId = `xiaoai-user-${accountLabel}`;
    const displayLabel = account.label || accountLabel;
    const senderName = `小爱用户(${displayLabel})`;
    const sessionKey = `agent:main:${CHANNEL_ID}:${accountLabel}:direct:${senderId}`;

    const inboundCtx = {
        Body: query,
        BodyForAgent: query,
        BodyForCommands: query,
        RawBody: query,
        CommandBody: query,
        SessionKey: sessionKey,
        AccountId: ctx.accountId,
        ConversationLabel: senderName,
        SenderName: senderName,
        Timestamp: Date.now(),
        From: senderId,
        To: senderId,
        ChatType: "direct",
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: senderId,
        CommandAuthorized: true,
    };

    const getReplyFromConfig = await loadGetReplyFromConfig();
    const replyPayload = await getReplyFromConfig(inboundCtx, undefined, ctx.cfg);
    const replies = normalizeReplyPayloads(replyPayload);

    for (const payload of replies) {
        const text = payloadToReplyText(payload);
        if (!text) continue;

        const chunkSize =
            typeof account.ttsChunkSize === "number" && Number.isFinite(account.ttsChunkSize)
                ? account.ttsChunkSize
                : 200;
        const playbackOptions = {
            systemVersion: account.systemVersion,
            ttsEngine: account.ttsEngine,
        };
        await ttsLongText(mina, text, chunkSize, miiot, playbackOptions);
    }

    return replies.length;
}

function normalizeReplyPayloads(payload) {
    if (!payload) return [];
    return Array.isArray(payload) ? payload.filter(Boolean) : [payload];
}

function payloadToReplyText(payload) {
    const text = normalizeTtsText(payload?.text ?? "");
    if (text) return text;
    const mediaUrl = normalizeTtsText(payload?.mediaUrl ?? "");
    if (mediaUrl) return mediaUrl;
    return "";
}

// ─── Channel Plugin Definition ──────────────────────────────

const xiaoaiChannel = {
    id: CHANNEL_ID,
    meta: {
        id: CHANNEL_ID,
        label: "XiaoAi",
        selectionLabel: "XiaoAi (小爱同学 Smart Speaker)",
        docsPath: "/channels/xiaoai",
        blurb: "小爱同学智能音箱桥接通道，通过小米云服务 API 实现语音对话转发。",
        aliases: ["xiaoai", "xiaomi", "miai"],
    },
    capabilities: {
        chatTypes: ["direct"],
        reactions: false,
        threads: false,
        media: false,
        nativeCommands: false,
        blockStreaming: true,
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    configSchema: {
        schema: {
            type: "object",
            additionalProperties: false,
            properties: {
                enabled: { type: "boolean" },
                // Shared passToken — inherited by all accounts, can be overridden per-account
                passToken: { type: "string", description: "小米 passToken (所有设备共享，可在 account 中覆盖)" },
                ttsEngine: { type: "string", description: "TTS引擎策略 auto|miot|mina (所有设备共享，可在 account 中覆盖)" },
                startupVolume: { type: "number", description: "设备启用时自动设置音量 (0-100，留空则不调整)" },
                accounts: {
                    type: "array",
                    items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            id: { type: "string", description: "账号标识 (用于 OpenClaw chat 页面区分不同设备)" },
                            label: { type: "string", description: "设备显示名称 (如'客厅小爱'、'卧室小爱')" },
                            enabled: { type: "boolean" },
                            passToken: { type: "string", description: "小米 passToken (不填则继承顶层配置)" },
                            ttsEngine: { type: "string", description: "TTS引擎策略 auto|miot|mina" },
                            startupVolume: { type: "number", description: "设备启用时自动设置音量 (0-100，留空则不调整)" },
                            hardware: { type: "string", description: "设备型号 (如 LX04)" },
                            did: { type: "string", description: "设备名称 (米家App中的名称，如'小爱触屏音箱')" },
                            miotDid: { type: "string", description: "MiIOT 设备 DID (通常自动获取，无需手动填写)" },
                            enableTrace: { type: "boolean", description: "启用 mi-service-lite 调试日志" },
                            pollInterval: { type: "number", description: "轮询间隔秒数" },
                            triggerPrefix: { type: "string", description: "触发前缀 (如'请问')" },
                            ttsChunkSize: { type: "number", description: "TTS分段字符数" },
                            stopXiaoaiResponse: { type: "boolean", description: "是否停止小爱自带回复" },
                            keywordBlacklist: { type: "string", description: "不转发的关键词(逗号分隔)" },
                        },
                    },
                },
            },
        },
    },

    // ─── Account config ─────────────────────────────────────

    config: {
        listAccountIds: (cfg) => {
            const section = cfg?.channels?.[CHANNEL_ID] ?? {};
            const accounts = normalizeAccountsConfig(section?.accounts);
            const keys = Object.keys(accounts).filter(Boolean);
            return keys.length > 0 ? keys : ["default"];
        },
        defaultAccountId: (cfg) => {
            const section = cfg?.channels?.[CHANNEL_ID] ?? {};
            const accounts = normalizeAccountsConfig(section?.accounts);
            return Object.prototype.hasOwnProperty.call(accounts, "default")
                ? "default"
                : (Object.keys(accounts)[0] ?? "default");
        },
        resolveAccount: (cfg, accountId) => {
            const eff = resolveAccountSection(cfg, accountId);
            return {
                accountId: eff.accountId,
                label: typeof eff?.label === "string" ? eff.label : "",
                enabled: eff?.enabled !== false,
                hardware: typeof eff?.hardware === "string" ? eff.hardware : "LX04",
                did: typeof eff?.did === "string" ? eff.did : "",
                miotDid: typeof eff?.miotDid === "string" ? eff.miotDid : "",
                ttsEngine: normalizeTtsEngine(eff?.ttsEngine),
                startupVolume: normalizeStartupVolume(eff?.startupVolume),
                passToken: typeof eff?.passToken === "string" ? eff.passToken : "",
                enableTrace: eff?.enableTrace === true,
                pollInterval:
                    typeof eff?.pollInterval === "number" && Number.isFinite(eff.pollInterval)
                        ? eff.pollInterval
                        : 1,
                triggerPrefix: typeof eff?.triggerPrefix === "string" ? eff.triggerPrefix : "",
                ttsChunkSize:
                    typeof eff?.ttsChunkSize === "number" ? eff.ttsChunkSize : 200,
                stopXiaoaiResponse: eff?.stopXiaoaiResponse !== false,
                keywordBlacklist:
                    typeof eff?.keywordBlacklist === "string"
                        ? eff.keywordBlacklist
                        : "播放音乐,放首歌,定闹钟,设闹钟,几点了,打开,关闭,音量",
                configured:
                    eff?.hasAccountSection === true &&
                    typeof eff?.passToken === "string" &&
                    eff.passToken.trim().length > 0,
            };
        },
        isConfigured: (account) => Boolean(account?.configured),
        describeAccount: (account) => ({
            accountId: account?.accountId ?? "default",
            label: account?.label || account?.accountId || "default",
            enabled: account?.enabled !== false,
            configured: Boolean(account?.configured),
            passToken: account?.passToken ? "[set]" : "[missing]",
            hardware: account?.hardware || "LX04",
            did: account?.did || "[auto]",
            ttsEngine: account?.ttsEngine || "auto",
            startupVolume:
                typeof account?.startupVolume === "number" ? account.startupVolume : "[keep]",
            pollInterval: account?.pollInterval ?? 1,
            triggerPrefix: account?.triggerPrefix || "[none]",
        }),
    },

    // ─── Messaging ──────────────────────────────────────────

    messaging: {
        normalizeTarget: (raw) => {
            const value = String(raw ?? "").trim();
            return value ? value.replace(/^xiaoai:/i, "") : undefined;
        },
        targetResolver: {
            looksLikeId: (raw) => String(raw ?? "").trim().length > 0,
            hint: "<device-id>",
        },
    },

    // ─── Outbound (TTS) ────────────────────────────────────

    outbound: {
        deliveryMode: "direct",
        sendText: async ({ cfg, accountId, text }) => {
            const account = resolveAccountSection(cfg, accountId);
            if (!account.passToken) {
                throw new Error(
                    `xiaoai account "${accountId}" 未配置 passToken。` +
                    `请在 channels.xiaoai.accounts 中配置 passToken。`,
                );
            }

            // Initialize MiNA and send TTS
            const mina = await initMiNA(account);
            const deviceInfo = mina.account?.device;
            const systemVersion = getSystemVersion(deviceInfo);
            const miotDid = account.miotDid || deviceInfo?.miotDID;
            const miiot = await initMiIOT(account, miotDid);
            await ttsLongText(mina, text, undefined, miiot, {
                systemVersion,
                ttsEngine: account.ttsEngine,
            });
            return { ok: true, channel: CHANNEL_ID };
        },
        sendMedia: async ({ cfg, accountId, text, mediaUrl }) => {
            const caption = String(text ?? "").trim();
            const media = String(mediaUrl ?? "").trim();
            const composed = media ? (caption ? `${caption}\n\n${media}` : media) : caption;
            return xiaoaiChannel.outbound.sendText({ cfg, accountId, text: composed });
        },
    },

    // ─── Status ─────────────────────────────────────────────

    status: {
        defaultRuntime: {
            accountId: "default",
            running: false,
            configured: false,
            lastStartAt: null,
            lastStopAt: null,
            lastInboundAt: null,
            lastOutboundAt: null,
            lastError: null,
            mode: "poll",
        },
        buildAccountSnapshot: ({ account, runtime }) => ({
            accountId: account?.accountId ?? "default",
            enabled: account?.enabled !== false,
            configured: Boolean(account?.configured),
            running: runtime?.running ?? false,
            lastStartAt: runtime?.lastStartAt ?? null,
            lastStopAt: runtime?.lastStopAt ?? null,
            lastInboundAt: runtime?.lastInboundAt ?? null,
            lastOutboundAt: runtime?.lastOutboundAt ?? null,
            lastError: runtime?.lastError ?? null,
            mode: "poll",
        }),
    },

    // ─── Gateway (inbound polling loop) ─────────────────────

    gateway: {
        startAccount: async (ctx) => {
            const account = resolveAccountSection(ctx.cfg, ctx.accountId);

            if (!account.passToken) {
                throw new Error(
                    `xiaoai account "${ctx.accountId}" 未配置 passToken。` +
                    `请在 channels.xiaoai.accounts 中配置 passToken。`,
                );
            }

            ctx.log?.info?.(`[${ctx.accountId}] 正在初始化 MiNA 服务...`);

            let mina;
            try {
                mina = await initMiNA(account);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                ctx.log?.error?.(`[${ctx.accountId}] MiNA 初始化失败: ${msg}`);
                throw err;
            }

            const deviceInfo = mina.account?.device;
            const systemVersion = getSystemVersion(deviceInfo);
            ctx.log?.info?.(
                `[${ctx.accountId}] ✓ 已连接设备: ${deviceInfo?.name ?? "unknown"} ` +
                `(${deviceInfo?.hardware ?? ""}${systemVersion ? ` / ${systemVersion}` : ""})`,
            );

            // Initialize MiIOT for firmware that requires doAction for TTS
            const miotDid = account.miotDid || deviceInfo?.miotDID;
            let miiot = null;
            if (miotDid) {
                miiot = await initMiIOT(account, miotDid);
                ctx.log?.info?.(
                    `[${ctx.accountId}] MiIOT: ${miiot ? `✓ 已连接 (did=${miotDid})` : `✗ 不可用 (did=${miotDid})，将回退到 MiNA TTS`}`,
                );
            }

            const playbackOptions = {
                systemVersion,
                ttsEngine: normalizeTtsEngine(account.ttsEngine),
            };

            const startupVolume = normalizeStartupVolume(account.startupVolume);
            if (startupVolume !== null) {
                try {
                    const previous = await mina.getVolume().catch(() => undefined);
                    const ok = await mina.setVolume(startupVolume);
                    if (ok === false) {
                        ctx.log?.warn?.(
                            `[${ctx.accountId}] 音量自动调整失败: setVolume(${startupVolume}) 返回 false`,
                        );
                    } else {
                        const prevLabel =
                            typeof previous === "number" ? String(previous) : "unknown";
                        ctx.log?.info?.(
                            `[${ctx.accountId}] 已自动设置设备音量: ${prevLabel} → ${startupVolume}`,
                        );
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    ctx.log?.warn?.(
                        `[${ctx.accountId}] 音量自动调整异常: ${msg}`,
                    );
                }
            }

            ctx.log?.info?.(
                `[${ctx.accountId}] TTS策略: ${chooseTtsEngine(playbackOptions, Boolean(miiot))} ` +
                `(engine=${playbackOptions.ttsEngine}${systemVersion ? `, version=${systemVersion}` : ""})`,
            );

            // Preflight: load reply handler
            ctx.log?.info?.(`[${ctx.accountId}] 正在加载 OpenClaw reply handler...`);
            await loadGetReplyFromConfig();
            ctx.log?.info?.(`[${ctx.accountId}] ✓ reply handler 就绪`);

            const isAborted = () => Boolean(ctx.abortSignal?.aborted);

            ctx.setStatus({
                accountId: ctx.accountId,
                configured: true,
                running: true,
                mode: "poll",
                lastStartAt: Date.now(),
                lastError: null,
            });

            // Get initial conversation to skip old messages
            let lastQuery = "";
            let lastTimestamp = 0;
            const initialConv = await getLastConversation(mina);
            if (initialConv) {
                lastQuery = initialConv.query;
                lastTimestamp = initialConv.timestamp;
                ctx.log?.info?.(`[${ctx.accountId}] 跳过已有对话: "${lastQuery}"`);
            }

            const pollInterval =
                typeof account.pollInterval === "number" && Number.isFinite(account.pollInterval)
                    ? account.pollInterval
                    : 1;

            ctx.log?.info?.(
                `[${ctx.accountId}] 开始轮询对话 (间隔: ${pollInterval}s` +
                `${account.triggerPrefix ? `, 前缀: "${account.triggerPrefix}"` : ""})`,
            );

            let errorCount = 0;
            const maxErrors = 10;

            try {
                while (!isAborted()) {
                    try {
                        const conv = await getLastConversation(mina);

                        if (conv && (conv.query !== lastQuery || conv.timestamp !== lastTimestamp)) {
                            lastQuery = conv.query;
                            lastTimestamp = conv.timestamp;

                            ctx.log?.info?.(`[${ctx.accountId}] ► 用户说: "${conv.query}"`);

                            if (shouldForward(conv.query, account)) {
                                const actualQuery = extractQuery(conv.query, account);
                                if (actualQuery) {
                                    // Stop XiaoAi's own response
                                    if (account.stopXiaoaiResponse !== false) {
                                        ctx.log?.debug?.(`[${ctx.accountId}] 正在打断小爱自带回复...`);
                                        await forceStopXiaoaiResponse(mina, miiot, ctx.log, playbackOptions);
                                    }

                                    ctx.log?.info?.(
                                        `[${ctx.accountId}] → 转发至 OpenClaw: "${actualQuery}"`,
                                    );
                                    const startMs = Date.now();

                                    try {
                                        const replyCount = await processInboundQuery(
                                            ctx,
                                            mina,
                                            actualQuery,
                                            { ...account, systemVersion },
                                            miiot,
                                        );
                                        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
                                        ctx.log?.info?.(
                                            `[${ctx.accountId}] ← OpenClaw 已回复 (${elapsed}s, ${replyCount} 条)`,
                                        );

                                        ctx.setStatus({
                                            ...ctx.getStatus(),
                                            accountId: ctx.accountId,
                                            running: true,
                                            configured: true,
                                            mode: "poll",
                                            lastInboundAt: Date.now(),
                                            lastOutboundAt: Date.now(),
                                            lastError: null,
                                        });
                                    } catch (replyErr) {
                                        const errMsg = replyErr instanceof Error
                                            ? replyErr.message
                                            : String(replyErr);
                                        ctx.log?.error?.(
                                            `[${ctx.accountId}] OpenClaw 回复失败: ${errMsg}`,
                                        );
                                        // Inform user via TTS
                                        try {
                                            await ttsPlay(mina, "抱歉，我现在无法回答，请稍后再试。", miiot, playbackOptions);
                                        } catch {
                                            // best effort
                                        }
                                    }
                                }
                            } else {
                                ctx.log?.debug?.(
                                    `[${ctx.accountId}]   跳过（不满足转发条件）`,
                                );
                            }
                        }

                        errorCount = 0;
                    } catch (err) {
                        if (isAborted()) break;
                        errorCount++;
                        const errMsg = err instanceof Error ? err.message : String(err);
                        ctx.log?.warn?.(
                            `[${ctx.accountId}] 轮询异常 (${errorCount}/${maxErrors}): ${errMsg}`,
                        );
                        ctx.setStatus({
                            ...ctx.getStatus(),
                            accountId: ctx.accountId,
                            running: true,
                            configured: true,
                            mode: "poll",
                            lastError: errMsg,
                        });

                        if (errorCount >= maxErrors) {
                            ctx.log?.error?.(
                                `[${ctx.accountId}] 连续错误达到 ${maxErrors} 次，进入冷却后继续重试`,
                            );
                            const coolDownSec = 60;
                            await sleep(coolDownSec * 1000);
                            errorCount = 0;
                            continue;
                        }

                        const backoff = Math.min(pollInterval * 2 ** errorCount, 60);
                        await sleep(backoff * 1000);
                        continue;
                    }

                    await sleep(pollInterval * 1000);
                }
            } finally {
                ctx.setStatus({
                    ...ctx.getStatus(),
                    accountId: ctx.accountId,
                    running: false,
                    lastStopAt: Date.now(),
                });
                ctx.log?.info?.(`[${ctx.accountId}] 轮询已停止`);
            }
        },
    },
};

// ─── Plugin Export ───────────────────────────────────────────

const plugin = {
    id: "xiaoai-channel",
    name: "XiaoAi Channel",
    description: "小爱同学智能音箱桥接通道插件",
    register(api) {
        api.registerChannel({ plugin: xiaoaiChannel });
    },
};

export default plugin;

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

function chooseTtsEngine(playbackOptions = {}, hasMiIOT = false) {
    const override = normalizeTtsEngine(playbackOptions.ttsEngine);
    if (override === "miot") return hasMiIOT ? "miot" : "mina";
    if (override === "mina") return "mina";
    if (!hasMiIOT) return "mina";

    const systemVersion = String(playbackOptions.systemVersion || "").trim();
    if (systemVersion && compareVersion(systemVersion, "2.90.0") < 0) {
        return "mina";
    }
    return "miot";
}

function normalizeTtsText(input) {
    return String(input ?? "")
        .replace(/\\r\\n|\\n|\\r/g, "，")
        .replace(/\r\n|\n|\r/g, "，")
        .replace(/\t+/g, "，")
        .replace(/，{2,}/g, "，")
        .replace(/\s{2,}/g, " ")
        .trim();
}

function normalizeStartupVolume(raw) {
    if (raw === null || raw === undefined || raw === "") return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, Math.round(value)));
}
