/* ============================================================
   verify-real-orphan.js — 真实线上验证「孤儿改动自动治癒」（8/27 修复核心场景）
   用户真实痛点场景（旧版本遗留孤儿删除）：
   - 手机 context 全新设备 → 首拉对齐云端（rev = 云端 rev）
   - 模拟旧版孤儿：直接改 localStorage 删除云端存在的客户，
     且 rev 保持与云端相同 + 删除 __hash（= 旧版推送失败后 App 重开的孤儿状态）
   - 手机 reload（App 重开，内存标志归零）→ 新版 pull() 指纹对账：
     rev 相同但内容不同 = 孤儿改动 → 后推赢自动推本地（治癒上云）
   - 验证：云端已无被删客户 + 电脑 context 首拉/12s 轮询自动看到删除
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
    const cloudRev = origSnap ? origSnap.rev : 0;
    const cloudCusts = custIds(origSnap);
    console.log("   云端当前 rev:", cloudRev, " customers:", cloudCusts.length);
    if (!origSnap || cloudCusts.length === 0) { console.error("云端无数据，终止"); process.exit(1); }

    // 挑一个云端真实存在的客户当「受害者」（测试后靠恢复原快照还原）
    const VICTIM = cloudCusts[cloudCusts.length - 1];
    const victimName = (origSnap.payload.customers || []).find(c => c.id === VICTIM);
    console.log("   孤儿删除受害者:", VICTIM, victimName ? "(" + victimName.name + ")" : "");

    const browser = await chromium.launch({ channel: "msedge", headless: true });

    /* ---------- 手机 context：全新设备首拉对齐云端 ---------- */
    console.log("\n== 1. 手机 context 全新设备首拉 ==");
    const phoneCtx = await browser.newContext({
        userAgent: iPhoneUA,
        viewport: { width: 390, height: 844 },
        hasTouch: true, isMobile: true, deviceScaleFactor: 3
    });
    const phone = await phoneCtx.newPage();
    await phone.goto(BASE, { waitUntil: "domcontentloaded" });
    await phone.evaluate(() => {
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
        await sleep(6000);
    }
    const mRev = await phone.evaluate(() => (JSON.parse(localStorage.getItem("taiyuan_erp_data_v1") || "{}").__rev) || 0);
    rec("O1 手机首拉对齐云端（rev=" + cloudRev + "）", mRev === cloudRev, "本地 rev=" + mRev);

    /* ---------- 制造旧版孤儿：localStorage 删除客户 + rev 不动 + 无 __hash ---------- */
    console.log("\n== 2. 模拟旧版孤儿状态（推送失败后 App 重开的手机）==");
    const orphanOK = await phone.evaluate((victimId) => {
        const d = JSON.parse(localStorage.getItem("taiyuan_erp_data_v1") || "{}");
        // 本地删除（孤儿改动）
        const before = (d.customers || []).length;
        d.customers = (d.customers || []).filter(c => c.id !== victimId);
        // rev 保持与云端相同（= 推送从未成功推进），删除 __hash（模拟旧版数据从未记录指纹）
        delete d.__hash;
        localStorage.setItem("taiyuan_erp_data_v1", JSON.stringify(d));
        return { before, after: d.customers.length, rev: d.__rev || 0 };
    }, VICTIM);
    rec("O2 孤儿状态已制造（本地删 1 客户、rev 与云端相同、无 __hash）",
        orphanOK.after === orphanOK.before - 1 && orphanOK.rev === cloudRev,
        JSON.stringify(orphanOK));

    /* ---------- App 重开 → 新版指纹对账自动治癒 ---------- */
    console.log("\n== 3. 手机 App 重开（reload）→ 指纹对账自动治癒上云 ==");
    await phone.reload({ waitUntil: "domcontentloaded" });
    await sleep(1500);
    const needLogin2 = await phone.evaluate(() => !!document.querySelector('input[type="password"]'));
    if (needLogin2) {
        await phone.fill('input[name="username"], input[type="text"]', "admin");
        await phone.fill('input[name="password"], input[type="password"]', "admin123");
        await phone.click('button[type="submit"], .btn.primary');
    }
    // 等首拉(1.5s)→指纹对账发现孤儿→自动 push 治癒（含网络）
    await sleep(15000);

    const st = await phone.evaluate(() => {
        const s = JSON.parse(localStorage.getItem("taiyuan_sync_status_v1") || "{}");
        return { lastError: s.lastError, lastPushAt: s.lastPushAt, localRev: (JSON.parse(localStorage.getItem("taiyuan_erp_data_v1") || "{}").__rev) || 0 };
    });
    console.log("   手机同步状态:", JSON.stringify(st));

    let cloud1 = null;
    try { cloud1 = JSON.parse(decode(await readCloud())); } catch (e) { }
    const cloudHealed = !!cloud1 && custIds(cloud1).indexOf(VICTIM) < 0 && cloud1.rev > cloudRev;
    rec("O3 孤儿删除已自动治癒上云（云端已无受害者、rev 已推进）", cloudHealed,
        "云端 customers=" + (cloud1 ? custIds(cloud1).length : "?") + " rev=" + (cloud1 && cloud1.rev) + "（治癒前 rev=" + cloudRev + "）");
    rec("O4 手机端无同步错误", !st.lastError, st.lastError || "");

    /* ---------- 电脑 context：首拉/12s 轮询自动看到删除 ---------- */
    console.log("\n== 4. 电脑 context（桌面 UA，全新浏览器）==");
    const pcCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pc = await pcCtx.newPage();
    await pc.goto(BASE, { waitUntil: "domcontentloaded" });
    await sleep(4000);
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
    await sleep(8000); // 首拉或 12s 轮询
    const pcState = await pc.evaluate((id) => {
        const c = DB.get("customers", id);
        const rev = (JSON.parse(localStorage.getItem("taiyuan_erp_data_v1") || "{}").__rev) || 0;
        return { stillExists: !!c, rev, count: DB.list("customers").length };
    }, VICTIM);
    rec("O5 电脑端已自动看到孤儿删除（受害者不存在）", !pcState.stillExists && pcState.rev >= (cloud1 ? cloud1.rev : 0),
        "电脑受害者存在=" + pcState.stillExists + " 电脑 rev=" + pcState.rev);
    rec("O6 电脑端客户数与云端一致", pcState.count === (cloud1 ? custIds(cloud1).length : -1),
        "电脑 customers=" + pcState.count + " 云端 customers=" + (cloud1 ? custIds(cloud1).length : "?"));

    /* ---------- 恢复云端 ---------- */
    console.log("\n== 5. 恢复云端原快照（受害者随之还原）==");
    if (original) {
        const ok = await writeCloud(original);
        rec("O7 云端已恢复测试前快照（受害者已还原）", ok, "");
    }

    await phoneCtx.close(); await pcCtx.close(); await browser.close();

    const pass = results.filter(r => r.pass).length;
    console.log("\n===== 结果: " + pass + "/" + results.length + " =====");
    process.exit(results.every(r => r.pass) ? 0 : 1);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
