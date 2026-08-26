/* ============================================================
   verify-real-delete.js — 真实端到端验证「手机删除 → 电脑自动看到删除」
   用户核心痛点场景：
   - 手机 context：iPhone UA + 触摸，打开线上 → 登录 → 首拉
   - 手机新增测试客户 c_rm_test「同步刪除測試」→ 自动 push → 确认云端有
   - 手机删除 c_rm_test → 自动 push → 确认云端已无
   - 电脑 context：桌面 UA → 登录 → 首拉/12s 轮询 → 确认电脑端也看不到
     （电脑自动「看到删除」= 客户列表已不含被删客户）
   - 测试后恢复云端原快照（不污染生产数据）
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
    function custIds(snap) {
        try { return (snap.payload.customers || []).map(c => c.id); } catch (e) { return []; }
    }

    console.log("== 0. 保存云端原快照（测试后恢复） ==");
    const original = await readCloud();
    const origSnap = original ? JSON.parse(decode(original)) : null;
    console.log("   云端当前 rev:", origSnap && origSnap.rev, " customers:", custIds(origSnap).length);

    const browser = await chromium.launch({ channel: "msedge", headless: true });

    /* ---------- 手机 context ---------- */
    console.log("\n== 1. 手机 context（iPhone UA + 触摸）==");
    const phoneCtx = await browser.newContext({
        userAgent: iPhoneUA,
        viewport: { width: 390, height: 844 },
        hasTouch: true, isMobile: true, deviceScaleFactor: 3
    });
    const phone = await phoneCtx.newPage();
    const phoneErrors = [];
    phone.on("console", m => { if (m.type() === "error") phoneErrors.push(m.text()); });
    phone.on("pageerror", e => phoneErrors.push("PAGEERROR: " + e.message));

    await phone.goto(BASE, { waitUntil: "domcontentloaded" });
    await phone.evaluate(() => {
        // 清掉本地配置/数据让首拉干净进行（全新手机设备）
        localStorage.removeItem("taiyuan_sync_cfg_v1");
        localStorage.removeItem("taiyuan_sync_status_v1");
        const d = JSON.parse(localStorage.getItem("taiyuan_erp_data_v1") || "{}");
        d.__rev = 0;
        localStorage.setItem("taiyuan_erp_data_v1", JSON.stringify(d));
    });
    await phone.reload({ waitUntil: "domcontentloaded" });
    await sleep(1500);

    const needLogin = await phone.evaluate(() => !!document.querySelector('input[type="password"]'));
    if (needLogin) {
        await phone.fill('input[name="username"], input[type="text"]', "admin");
        await phone.fill('input[name="password"], input[type="password"]', "admin123");
        await phone.click('button[type="submit"], .btn.primary');
        await sleep(6000); // startAuto 自动配置 + 首拉（1.5s + 网络）
    }

    const loggedIn = await phone.evaluate(() => !!(typeof DB !== "undefined" && DB.currentUser && DB.currentUser() && DB.currentUser().username));
    rec("D1 手机登录成功", loggedIn, "");
    const mRev = await phone.evaluate(() => (JSON.parse(localStorage.getItem("taiyuan_erp_data_v1") || "{}").__rev) || 0);
    rec("D2 手机首拉完成（本地 rev = 云端 rev）", mRev === (origSnap ? origSnap.rev : -1), "本地 rev=" + mRev);

    /* ---------- 手机操作 1：新增测试客户 → push → 云端有 ---------- */
    console.log("\n== 2. 手机新增测试客户并推上云端 ==");
    const RMID = "c_rm_test";
    const RMNAME = "同步刪除測試";
    await phone.evaluate(({ id, name }) => {
        DB.insert("customers", { id, code: id, name, phone: "10086", currency: "CNY", created_at: new Date().toISOString() });
        DB.flush();
    }, { id: RMID, name: RMNAME });
    console.log("   新增", RMID, "；等待自动 push…");
    await sleep(12000); // 3s 防抖 + push 网络

    let cloud1 = null;
    try { cloud1 = JSON.parse(decode(await readCloud())); } catch (e) { }
    rec("D3 云端已含测试客户（删除前状态）", !!cloud1 && custIds(cloud1).indexOf(RMID) >= 0,
        "云端 customers=" + custIds(cloud1).length + " rev=" + (cloud1 && cloud1.rev));

    /* ---------- 手机操作 2：删除测试客户 → push → 云端无 ---------- */
    console.log("\n== 3. 手机删除测试客户（核心痛点场景）==");
    await phone.evaluate((id) => {
        const c = DB.get("customers", id);
        if (c) DB.remove("customers", id);
        DB.flush();
    }, RMID);
    console.log("   已删除", RMID, "；等待自动 push…");
    await sleep(12000); // 3s 防抖 + push 网络

    const st = await phone.evaluate(() => {
        const s = JSON.parse(localStorage.getItem("taiyuan_sync_status_v1") || "{}");
        return { lastPushAt: s.lastPushAt, lastError: s.lastError, lastAction: s.lastAction, localRev: (JSON.parse(localStorage.getItem("taiyuan_erp_data_v1") || "{}").__rev) || 0 };
    });
    console.log("   手机同步状态:", JSON.stringify(st));

    let cloud2 = null;
    try { cloud2 = JSON.parse(decode(await readCloud())); } catch (e) { }
    const cloudStillHas = cloud2 && custIds(cloud2).indexOf(RMID) >= 0;
    rec("D4 云端已删除测试客户（删除已推到云端）", !!cloud2 && !cloudStillHas,
        "云端 customers=" + (cloud2 ? custIds(cloud2).length : "?") + " rev=" + (cloud2 && cloud2.rev));
    rec("D5 手机端无同步错误", !st.lastError, st.lastError || "");
    if (phoneErrors.length) console.log("   ⚠ 手机 console 错误:", phoneErrors.slice(0, 3));

    /* ---------- 电脑 context：拉取验证「看到删除」 ---------- */
    console.log("\n== 4. 电脑 context（桌面 UA，全新浏览器）==");
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
    // 等首拉或 12 秒轮询拿到删除后的云端快照
    await sleep(8000);
    const pcState = await pc.evaluate((id) => {
        const c = DB.get("customers", id);
        const rev = (JSON.parse(localStorage.getItem("taiyuan_erp_data_v1") || "{}").__rev) || 0;
        return { stillExists: !!c, rev };
    }, RMID);
    rec("D6 电脑端已自动看到删除（被删客户不存在）", !pcState.stillExists && pcState.rev >= (cloud2 ? cloud2.rev : 0),
        "电脑 c_rm_test 存在=" + pcState.stillExists + " 电脑 rev=" + pcState.rev + "（云端删除后 rev=" + (cloud2 && cloud2.rev) + "）");
    const pcCount = await pc.evaluate(() => DB.list("customers").length);
    rec("D7 电脑端客户数与云端一致", pcCount === (cloud2 ? custIds(cloud2).length : -1), "电脑 customers=" + pcCount + " 云端 customers=" + (cloud2 ? custIds(cloud2).length : "?"));

    /* ---------- 恢复云端 ---------- */
    console.log("\n== 5. 恢复云端原快照 ==");
    if (original) {
        const ok = await writeCloud(original);
        rec("D8 云端已恢复测试前快照", ok, "");
    }

    await phoneCtx.close(); await pcCtx.close(); await browser.close();

    const pass = results.filter(r => r.pass).length;
    console.log("\n===== 结果: " + pass + "/" + results.length + " =====");
    process.exit(results.every(r => r.pass) ? 0 : 1);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
