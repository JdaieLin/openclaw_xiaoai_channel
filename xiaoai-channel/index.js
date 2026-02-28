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
import path from "node:path";
import { pathToFileURL } from "node:url";

const CHANNEL_ID = "xiaoai";

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

/**
 * Ensure .mi.json contains the passToken for authentication.
 * This is needed because mi-service-lite reads passToken from .mi.json
 * to bypass Xiaomi's securityStatus:16 verification.
 */
async function ensureMiJsonPassToken(account) {
    const miJsonPath = path.resolve(process.cwd(), ".mi.json");
    let store = {};
    try {
        const raw = await fs.readFile(miJsonPath, "utf8");
        store = JSON.parse(raw) || {};
    } catch {
        // file doesn't exist yet
    }

    const passToken = account.passToken;
    if (!passToken) return; // no passToken configured, rely on password auth

    // Only write passToken if the stored one is different or missing
    const needsUpdate = (
        !store.mina?.pass?.passToken ||
        store.mina.pass.passToken !== passToken ||
        !store.miiot?.pass?.passToken ||
        store.miiot.pass.passToken !== passToken
    );

    if (needsUpdate) {
        // Preserve existing store data, only update passToken
        if (!store.mina) store.mina = {};
        if (!store.mina.pass) store.mina.pass = {};
        store.mina.pass.passToken = passToken;

        if (!store.miiot) store.miiot = {};
        if (!store.miiot.pass) store.miiot.pass = {};
        store.miiot.pass.passToken = passToken;

        await fs.writeFile(miJsonPath, JSON.stringify(store, null, 2), "utf8");
    }
}

/**
 * Initialize MiNA service for a given account.
 * Returns an MiNA instance or throws.
 *
 * NOTE: Requires a patched mi-service-lite that updates account.userId
 * to the numeric ID from pass.userId after login. Without this patch,
 * the phone-number userId in the API cookie mismatches the serviceToken
 * and causes 401 errors.
 */
async function initMiNA(account) {
    // Write passToken to .mi.json if configured
    await ensureMiJsonPassToken(account);

    const { getMiNA } = await import("mi-service-lite");
    const did = account.did || account.hardware || "LX04";
    const mina = await getMiNA({
        userId: account.miUser,
        password: account.miPass,
        did,
        enableTrace: Boolean(account.enableTrace),
    });
    if (!mina) {
        throw new Error(
            `MiNA 初始化失败: 请检查小米账号/密码/设备名称/passToken ` +
            `(user=${maskStr(account.miUser)}, did=${did})\n` +
            `提示: did 应为米家中的设备名称(如"小爱触屏音箱")，而非型号(如"LX04")`,
        );
    }
    return mina;
}

function maskStr(s) {
    if (!s || s.length < 4) return "***";
    return s.slice(0, 2) + "***" + s.slice(-2);
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
async function ttsPlay(mina, text) {
    await mina.play({ tts: text });
}

/**
 * Pause/stop current XiaoAi response.
 */
async function ttsPause(mina) {
    try {
        await mina.pause();
    } catch {
        // often normal if nothing is playing
    }
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
async function ttsLongText(mina, text, chunkSize = 200) {
    const chunks = splitTextForTTS(text, chunkSize);
    for (let i = 0; i < chunks.length; i++) {
        if (i > 0) {
            const waitMs = Math.max(chunks[i - 1].length * 200, 2000);
            await sleep(waitMs);
        }
        await ttsPlay(mina, chunks[i]);
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
    return {
        enabled: section?.enabled !== false,
        ...acct,
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
async function processInboundQuery(ctx, mina, query, account) {
    const accountLabel = sanitizeSessionPart(ctx.accountId || "default") || "default";
    const senderId = `xiaoai-user-${accountLabel}`;
    const senderName = `小爱用户(${accountLabel})`;
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
        await ttsLongText(mina, text, chunkSize);
    }

    return replies.length;
}

function normalizeReplyPayloads(payload) {
    if (!payload) return [];
    return Array.isArray(payload) ? payload.filter(Boolean) : [payload];
}

function payloadToReplyText(payload) {
    const text = String(payload?.text ?? "").trim();
    if (text) return text;
    const mediaUrl = String(payload?.mediaUrl ?? "").trim();
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
                accounts: {
                    type: "array",
                    items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            id: { type: "string", description: "账号标识" },
                            enabled: { type: "boolean" },
                            miUser: { type: "string", description: "小米账号" },
                            miPass: { type: "string", description: "小米密码" },
                            hardware: { type: "string", description: "设备型号 (如 LX04)" },
                            did: { type: "string", description: "设备名称 (米家App中的名称，如'小爱触屏音箱')" },
                            passToken: { type: "string", description: "小米 passToken (从浏览器Cookie获取，替代密码登录)" },
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
                enabled: eff?.enabled !== false,
                miUser: typeof eff?.miUser === "string" ? eff.miUser : "",
                miPass: typeof eff?.miPass === "string" ? eff.miPass : "",
                hardware: typeof eff?.hardware === "string" ? eff.hardware : "LX04",
                did: typeof eff?.did === "string" ? eff.did : "",
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
                    typeof eff?.miUser === "string" &&
                    eff.miUser.trim().length > 0 &&
                    ((
                        typeof eff?.miPass === "string" &&
                        eff.miPass.trim().length > 0
                    ) || (
                        typeof eff?.passToken === "string" &&
                        eff.passToken.trim().length > 0
                    )),
            };
        },
        isConfigured: (account) => Boolean(account?.configured),
        describeAccount: (account) => ({
            accountId: account?.accountId ?? "default",
            enabled: account?.enabled !== false,
            configured: Boolean(account?.configured),
            miUser: account?.miUser ? "[set]" : "[missing]",
            miPass: account?.miPass ? "[set]" : "[missing]",
            hardware: account?.hardware || "LX04",
            did: account?.did || "[auto]",
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
            if (!account.miUser || (!account.miPass && !account.passToken)) {
                throw new Error(
                    `xiaoai account "${accountId}" 未配置小米账号。` +
                    `请在 channels.xiaoai.accounts 中配置 miUser 和 miPass (或 passToken)。`,
                );
            }

            // Initialize MiNA and send TTS
            const mina = await initMiNA(account);
            await ttsLongText(mina, text);
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

            if (!account.miUser || (!account.miPass && !account.passToken)) {
                throw new Error(
                    `xiaoai account "${ctx.accountId}" 未配置。` +
                    `请在 channels.xiaoai.accounts 中配置 miUser 和 miPass (或 passToken)。`,
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
            ctx.log?.info?.(
                `[${ctx.accountId}] ✓ 已连接设备: ${deviceInfo?.name ?? "unknown"} ` +
                `(${deviceInfo?.hardware ?? ""})`,
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
                                        await ttsPause(mina);
                                        await sleep(300);
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
                                            account,
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
                                            await ttsPlay(mina, "抱歉，我现在无法回答，请稍后再试。");
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
                                `[${ctx.accountId}] 连续错误达到 ${maxErrors} 次，停止轮询`,
                            );
                            break;
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
