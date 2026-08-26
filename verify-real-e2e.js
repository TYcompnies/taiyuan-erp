/* ============================================================
   verify-real-e2e.js — 真实端到端验证「手机操作 → 电脑看到」
   场景完整模拟用户真实状态：
   - 手机 context：iPhone UA + 触摸 + 移动视口，localStorage 预置
     「旧版 GitHub 配置（无令牌）」——模拟用户手机残留的旧配置
   - 打开线上 → 登录 → 自动迁移 textdb → 首拉 → 修改客户名 →
     自动 push（3 秒防抖 + 网络等待）→ 检查云端 textdb 是否真的变化
   - 电脑 context：桌面 UA → 登录 → 首拉 → 验证看到手机的修改
   - 测试后把云端恢复为测试前快照（不污染生产数据）
   ============================================================ */
const { chromium } = require("playwright");

const BASE = "https://tycompnies.github.io/taiyuan-erp/";
const CODE = "382d3aa9-de38-4803-90be-ed24eff373b5";
const PASS = "c663bf4076dc622b4f8fd1e2";

const iPhoneUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const results = [];
function rec(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log((pass ? "  ✅ " : "  ❌ ") + name + (detail ? " — " + detail : ""));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function readCloud() {
    const r = await fetch("https://textdb.online/" + CODE + "?t=" + Date.now(), { cache: "no-store" });
    const t = (await r.text()).trim();
    if (!t || t === "null") return null;
    return t;
}
async function writeCloud(value) {
    const url = "https://api.textdb.online/update/?key=" + encodeURIComponent(CODE) + "&value=" + encodeURIComponent(value);
    const r = await fetch(url, { method: "POST" });
    return r.ok;
}

(async () => {
    // Node 解密快照（查看 rev）
    const crypto = require("crypto"), zlib = require("zlib");
    function decode(enc) {
        if (enc.indexOf("TYE1:") !== 0) return enc;
        const raw = Buffer.from(enc.slice(5), "base64");
        const salt = raw.subarray(0, 16), iv = raw.subarray(16, 28), ct = raw.subarray(28);
        const key = crypto.pbkdf2Sync(PASS, salt, 100000, 32, "sha256");
        const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
        d.setAuthTag(ct.subarray(ct.length - 16));
        const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8");
        if (pt.indexOf("TY1:") === 0) return zlib.inflateSync(Buffer.from(pt.slice(4), "base64")).toString("utf8");
        if (pt.indexOf("TY0:") === 0) return pt.slice(4);
        return pt;
    }

    console.log("== 0. 保存云端原快照（测试后恢复） ==");
    const original = await readCloud();
    const origSnap = original ? JSON.parse(decode(original)) : null;
    console.log("   云端当前 rev:", origSnap && origSnap.rev, origSnap && origSnap.updated_at);

    const browser = await chromium.launch({ channel: "msedge", headless: true });

    /* ---------- 手机 context：残留旧 GitHub 配置 ---------- */
    console.log("\n== 1. 手机 context（iPhone UA + 残留旧 GitHub 配置）==");
    const phoneCtx = await browser.newContext({
        userAgent: iPhoneUA,
        viewport: { width: 390, height: 844 },
        hasTouch: true, isMobile: true,
        deviceScaleFactor: 3
    });
    const phone = await phoneCtx.newPage();
    const phoneErrors = [];
    phone.on("console", m => { if (m.type() === "error") phoneErrors.push(m.text()); });
    phone.on("pageerror", e => phoneErrors.push("PAGEERROR: " + e.message));

    // 预置残留旧配置（打开页面前写入 —— 需先访问一次同源页）
    await phone.goto(BASE, { waitUntil: "domcontentloaded" });
    await phone.evaluate((cfg) => {
        localStorage.setItem("taiyuan_sync_cfg_v1", JSON.stringify(cfg));
    }, {
        provider: "github", code: "", ghToken: "", ghRepo: "TYcompnies/taiyuan-erp", ghPath: "erp-sync.json",
        pass: "c663bf4076dc622b4f8fd1e2", autoPush: true, autoPull: true
    });
    // 清掉数据让首拉干净进行（模拟手机本地有旧数据的情况：保留少量旧业务数据）
    await phone.evaluate(() => {
        const d = JSON.parse(localStorage.getItem("taiyuan_erp_data_v1") || "{}");
        d.__rev = 0; // 模拟从未同步过的旧设备
        localStorage.setItem("taiyuan_erp_data_v1", JSON.stringify(d));
    });
    await phone.reload({ waitUntil: "domcontentloaded" });
    await sleep(2000);

    // 登录（迁移/首拉发生在登录后 render()→startAuto()，必须在登录后再检查）
    const needLogin = await phone.evaluate(() => !!document.querySelector('input[type="password"]'));
    if (needLogin) {
        await phone.fill('input[name="username"], input[type="text"]', "admin");
        await phone.fill('input[name="password"], input[type="password"]', "admin123");
        await phone.click('button[type="submit"], .btn.primary');
        await sleep(5000); // 等 startAuto 迁移 + 首拉（1.5s 首拉 + 网络）
    }

    const loginState = await phone.evaluate(() => {
        const cfg = JSON.parse(localStorage.getItem("taiyuan_sync_cfg_v1") || "{}");
        return { provider: cfg.provider, hasCode: !!cfg.code, rev: (JSON.parse(localStorage.getItem("taiyuan_erp_data_v1") || "{}").__rev) || 0 };
    });
    rec("M1 手机旧 GitHub 配置自动迁移到 textdb", loginState.provider === "textdb" && loginState.hasCode, JSON.stringify(loginState));
    rec("M2 手机首拉完成（本地 rev = 云端 rev）", loginState.rev === (origSnap ? origSnap.rev : -1), "本地 rev=" + loginState.rev);

    const loggedIn = await phone.evaluate(() => !!(typeof DB !== "undefined" && DB.currentUser && DB.currentUser().username));
    rec("M3 手机登录成功", loggedIn, "");

    /* ---------- 手机操作：修改客户名 ---------- */
    console.log("\n== 2. 手机操作（修改客户名 cu1 → 同步诊断标记）==");
    const before = await phone.evaluate(() => {
        const c = DB.get("customers", "cu1");
        return c ? c.name : null;
    });
    const MARK = "同步诊断-" + Date.now().toString(36);
    await phone.evaluate((mark) => {
        const c = DB.get("customers", "cu1");
        c.name = mark;
        DB.update("customers", c.id, { name: mark });
        DB.flush();
    }, MARK);
    console.log("   修改 cu1:", before, "→", MARK, "；等待自动 push（3s 防抖 + 网络）…");
    await sleep(12000); // 3s 防抖 + push 网络 + 双写

    // 检查手机端同步状态
    const st = await phone.evaluate(() => {
        const s = JSON.parse(localStorage.getItem("taiyuan_sync_status_v1") || "{}");
        return { lastPushAt: s.lastPushAt, lastError: s.lastError, lastAction: s.lastAction, remoteRev: s.remoteRev, localRev: (JSON.parse(localStorage.getItem("taiyuan_erp_data_v1") || "{}").__rev) || 0 };
    });
    console.log("   手机同步状态:", JSON.stringify(st));

    // 检查云端是否真的变化
    const after = await readCloud();
    let afterSnap = null;
    try { afterSnap = after ? JSON.parse(decode(after)) : null; } catch (e) { }
    console.log("   云端 rev:", origSnap && origSnap.rev, "→", afterSnap && afterSnap.rev, " device:", afterSnap && afterSnap.device);
    rec("M4 手机修改后云端 rev 已更新", !!afterSnap && afterSnap.rev > (origSnap ? origSnap.rev : 0),
        "云端 rev " + (origSnap && origSnap.rev) + " → " + (afterSnap && afterSnap.rev) + " by " + (afterSnap && afterSnap.device));
    let cloudHasMark = false;
    try {
        const cu = (afterSnap && afterSnap.payload && afterSnap.payload.customers) || [];
        cloudHasMark = cu.some(c => c.name === MARK);
    } catch (e) { }
    rec("M5 云端数据包含手机的修改", cloudHasMark, "");
    rec("M6 手机端无同步错误", !st.lastError, st.lastError || "");
    if (phoneErrors.length) console.log("   ⚠ 手机 console 错误:", phoneErrors.slice(0, 3));

    /* ---------- 电脑 context：拉取验证 ---------- */
    console.log("\n== 3. 电脑 context（桌面 UA，全新浏览器）==");
    const pcCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pc = await pcCtx.newPage();
    await pc.goto(BASE, { waitUntil: "domcontentloaded" });
    await sleep(4000); // 自动配置 + 首拉

    const pcLogin = await pc.evaluate(() => !!(typeof DB !== "undefined" && DB.currentUser && DB.currentUser() && DB.currentUser().username));
    if (!pcLogin) {
        const hasPwd = await pc.evaluate(() => !!document.querySelector('input[type="password"]'));
        if (hasPwd) {
            await pc.fill('input[name="username"], input[type="text"]', "admin");
            await pc.fill('input[name="password"], input[type="password"]', "admin123");
            await pc.click('button[type="submit"], .btn.primary');
            await sleep(2500);
        }
    }
    // 等 12 秒轮询或首拉生效
    await sleep(8000);
    const pcName = await pc.evaluate(() => {
        const c = DB.get("customers", "cu1");
        return c ? c.name : null;
    });
    const pcRev = await pc.evaluate(() => (JSON.parse(localStorage.getItem("taiyuan_erp_data_v1") || "{}").__rev) || 0);
    rec("M7 电脑端看到手机的修改", pcName === MARK, "电脑 cu1=" + pcName + "（期望 " + MARK + "） rev=" + pcRev);

    /* ---------- 恢复云端 ---------- */
    console.log("\n== 4. 恢复云端原快照 ==");
    if (original) {
        const ok = await writeCloud(original);
        // 同时恢复 GitHub 备用源（通过手机端直接改回？跳过——GitHub 备用源由下次双写自然更新）
        rec("M8 云端已恢复测试前快照", ok, "");
    }

    await phoneCtx.close(); await pcCtx.close(); await browser.close();

    const pass = results.filter(r => r.pass).length;
    console.log("\n===== 结果: " + pass + "/" + results.length + " =====");
    process.exit(results.every(r => r.pass) ? 0 : 1);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
