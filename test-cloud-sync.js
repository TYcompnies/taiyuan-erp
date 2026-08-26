/* ============================================================
   云端同步测试 test-cloud-sync.js
   覆盖：配置读写、备份/恢复、编解码、页面渲染、自动调度
   ============================================================ */
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:8902/";

(async () => {
    const browser = await chromium.launch({ channel: "msedge", headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let pass = 0, fail = 0;
    const errors = [];
    page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
    page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

    const ok = (name, cond, extra) => {
        if (cond) { pass++; console.log("  PASS " + name); }
        else { fail++; console.log("  FAIL " + name + (extra ? "  | " + extra : "")); }
    };
    const db = (fn, arg) => page.evaluate(({ src, a }) => { const f = eval("(" + src + ")"); return f(a); }, { src: fn.toString(), a: arg });
    const gotoHash = async (h) => {
        await page.evaluate(() => document.querySelectorAll('.modal-mask').forEach(m => m.remove()));
        await page.goto(BASE + "#" + h);
        await page.waitForTimeout(300);
    };

    console.log("== 0. 登录 ==");
    await page.goto(BASE);
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE);
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForSelector(".erp-shell", { timeout: 8000 });
    ok("admin 登录成功", await page.locator(".erp-shell").count() > 0);

    console.log("\n== 1. CloudSync 对象存在 ==");
    const csExists = await db(() => typeof CloudSync !== "undefined");
    ok("CloudSync 已加载", csExists);
    const csCfgExists = await db(() => {
        const c = CloudSync.loadCfg();
        // 本地开发环境豁免：未配置时保持默认 textdb，不自动应用内置 github 配置（防污染）
        return c && c.provider === "textdb" && c.autoPush === true;
    });
    ok("本地环境未配置时保持默认配置（不自动应用内置）", csCfgExists);

    console.log("\n== 2. 配置保存 ==");
    await db(() => {
        CloudSync.saveCfg({ provider: "textdb", code: "test_sync_code_001", pass: "testpass123" });
        return true;
    });
    const savedCfg = await db(() => {
        const c = CloudSync.loadCfg();
        return { code: c.code, pass: c.pass, provider: c.provider };
    });
    ok("同步码已保存", savedCfg.code === "test_sync_code_001");
    ok("加密口令已保存", savedCfg.pass === "testpass123");
    ok("供应商默认 textdb", savedCfg.provider === "textdb");

    console.log("\n== 3. isConfigured 检查 ==");
    const configured = await db(() => CloudSync.isConfigured());
    ok("textdb 已配置（有同步码）", configured === true);
    await db(() => { CloudSync.saveCfg({ code: "" }); return true; });
    const notConfigured = await db(() => CloudSync.isConfigured());
    ok("无同步码时未配置", notConfigured === false);
    await db(() => { CloudSync.saveCfg({ code: "test_sync_code_001" }); return true; });

    console.log("\n== 4. deviceId 生成 ==");
    const dev1 = await db(() => CloudSync.deviceId());
    const dev2 = await db(() => CloudSync.deviceId());
    ok("deviceId 生成且稳定", dev1 && dev1 === dev2 && dev1.length > 5);

    console.log("\n== 5. 快照构建 ==");
    const snap = await db(() => {
        const s = CloudSync.buildSnapshot();
        return { rev: s.rev, device: s.device, hasPayload: !!s.payload, payloadRev: s.payload.__rev };
    });
    ok("快照有 rev", snap.rev > 0);
    ok("快照有 device", snap.device && snap.device.length > 5);
    ok("快照有 payload", snap.hasPayload);
    ok("payload 含 __rev", snap.payloadRev === snap.rev);

    console.log("\n== 6. 压缩/解压 ==");
    const compressResult = await db(async () => {
        const text = JSON.stringify({ test: "hello", data: "x".repeat(500) });
        const marked = await CloudSync._compress(text);
        const decompressed = await CloudSync._decompress(marked);
        return { marked: marked, match: decompressed === text, prefix: marked.split(":")[0] };
    });
    ok("压缩+解压数据一致", compressResult.match);
    ok("压缩格式标记正确", compressResult.prefix === "TY1" || compressResult.prefix === "TY0");

    console.log("\n== 7. 加密/解密 ==");
    const encResult = await db(async () => {
        CloudSync.saveCfg({ pass: "testpass123" });
        const marked = "TY0:" + JSON.stringify({ secret: "data" });
        const enc = await CloudSync._encrypt(marked);
        const dec = await CloudSync._decrypt(enc);
        return { encPrefix: enc.split(":")[0], match: dec === marked };
    });
    ok("加密格式标记 TYE1", encResult.encPrefix === "TYE1");
    ok("加密+解密数据一致", encResult.match);

    console.log("\n== 8. 无口令时不加密 ==");
    const noEncResult = await db(async () => {
        CloudSync.saveCfg({ pass: "" });
        const marked = "TY0:test";
        const enc = await CloudSync._encrypt(marked);
        return { enc: enc, isPlain: enc === marked };
    });
    ok("无口令时数据不加密", noEncResult.isPlain);
    await db(() => { CloudSync.saveCfg({ pass: "testpass123" }); return true; });

    console.log("\n== 9. 本地备份 ==");
    const bkResult = await db(() => {
        const before = CloudSync.backups().length;
        CloudSync.backupLocal("测试备份");
        const after = CloudSync.backups().length;
        return { before, after, hasData: CloudSync.backups()[0] && CloudSync.backups()[0].data.length > 0 };
    });
    ok("备份后数量增加", bkResult.after === bkResult.before + 1);
    ok("备份数据非空", bkResult.hasData);

    console.log("\n== 10. 备份保留上限 ==");
    const limitResult = await db(() => {
        // 连续创建 7 个备份（超过 BACKUP_KEEP=5）
        for (let i = 0; i < 7; i++) CloudSync.backupLocal("批量备份" + i);
        const bks = CloudSync.backups();
        return { count: bks.length };
    });
    ok("备份数量不超过上限5", limitResult.count === 5, "实际: " + limitResult.count);

    console.log("\n== 11. 云端同步页面渲染 ==");
    // 先禁用自动拉取避免干扰
    await db(() => { CloudSync.saveCfg({ autoPull: false }); CloudSync._started = true; return true; });
    // 通过 hash 导航
    await page.evaluate(() => {
        document.querySelectorAll('.modal-mask').forEach(m => m.remove());
        location.hash = "#/tools/cloud-sync";
    });
    await page.waitForTimeout(500);
    ok("同步页面渲染", await page.locator('h1:has-text("云端同步")').count() > 0);
    ok("有同步设置表单", await page.locator("form").count() > 0);
    ok("有测试连接按钮", await page.locator('text=测试连接').count() > 0);
    ok("有立即上传按钮", await page.locator('text=立即上传').count() > 0);
    ok("有立即下载按钮", await page.locator('text=立即下载').count() > 0);
    ok("有 KPI 卡片", await page.locator(".kpi-card").count() >= 3);
    ok("有备份列表表格", await page.locator("table").count() >= 1);

    console.log("\n== 12. 同步码生成 ==");
    await gotoHash("/tools/cloud-sync");
    await page.click('button:has-text("生成随机码")');
    await page.waitForTimeout(200);
    const codeVal = await page.inputValue('input[name="code"]');
    ok("生成随机同步码", codeVal && codeVal.length > 5 && codeVal.indexOf("ty") === 0);

    console.log("\n== 13. 配置保存到页面 ==");
    await gotoHash("/tools/cloud-sync");
    await page.fill('input[name="code"]', 'test_final_code');
    await page.fill('input[name="pass"]', 'finalpass');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(400);
    const finalCfg = await db(() => {
        const c = CloudSync.loadCfg();
        return { code: c.code, pass: c.pass };
    });
    ok("页面保存配置成功", finalCfg.code === "test_final_code" && finalCfg.pass === "finalpass");

    console.log("\n== 14. schedulePush 防抖 ==");
    const scheduleResult = await db(() => {
        CloudSync.saveCfg({ code: "test_final_code", autoPush: true });
        // 清除可能存在的定时器
        if (CloudSync._pushTimer) clearTimeout(CloudSync._pushTimer);
        CloudSync._pushTimer = null;
        // 多次调用应该只设一个定时器
        CloudSync.schedulePush();
        const hasTimer1 = !!CloudSync._pushTimer;
        CloudSync.schedulePush();
        CloudSync.schedulePush();
        const hasTimer2 = !!CloudSync._pushTimer;
        // 清除定时器避免实际推送
        if (CloudSync._pushTimer) clearTimeout(CloudSync._pushTimer);
        CloudSync._pushTimer = null;
        return { hasTimer1, hasTimer2 };
    });
    ok("schedulePush 设置定时器", scheduleResult.hasTimer1);
    ok("多次 schedulePush 只保留一个定时器", scheduleResult.hasTimer2);

    console.log("\n== 15. 未配置时不调度 ==");
    const noScheduleResult = await db(() => {
        CloudSync.saveCfg({ code: "", autoPush: true });
        if (CloudSync._pushTimer) clearTimeout(CloudSync._pushTimer);
        CloudSync._pushTimer = null;
        CloudSync.schedulePush();
        const hasTimer = !!CloudSync._pushTimer;
        CloudSync.saveCfg({ code: "test_final_code" });
        return { hasTimer };
    });
    ok("未配置时 schedulePush 不触发", noScheduleResult.hasTimer === false);

    console.log("\n== 16. 状态读写 ==");
    await db(() => {
        CloudSync.setStatus({ lastPushAt: "2026-01-20T10:00:00Z", lastError: "测试错误" });
        return true;
    });
    const st = await db(() => {
        const s = CloudSync.loadStatus();
        return { lastPushAt: s.lastPushAt, lastError: s.lastError };
    });
    ok("状态写入成功", st.lastPushAt === "2026-01-20T10:00:00Z");
    ok("状态错误信息写入", st.lastError === "测试错误");

    console.log("\n== 17. _businessEmpty 检查 ==");
    const bizEmpty = await db(() => {
        DB.clearBusiness();
        return CloudSync._businessEmpty();
    });
    ok("业务数据为空时返回 true", bizEmpty === true);
    const bizNotEmpty = await db(() => {
        DB.insert("items", { id: "it_sync_test", code: "SYNC001", name: "同步测试" });
        return CloudSync._businessEmpty();
    });
    ok("有业务数据时返回 false", bizNotEmpty === false);

    console.log("\n== 18. 清理测试数据 ==");
    await db(() => {
        DB.clearBusiness();
        localStorage.removeItem(CloudSync.BACKUP_KEY);
        localStorage.removeItem(CloudSync.STATUS_KEY);
        CloudSync.saveCfg({ code: "", pass: "" });
        return true;
    });
    ok("测试数据已清理", (await db(() => CloudSync.backups().length)) === 0);

    console.log("\n========================================");
    console.log("云端同步测试结果：" + pass + " 通过 / " + fail + " 失败");
    if (errors.length) {
        console.log("页面错误：");
        errors.forEach(e => console.log("  " + e));
    }
    console.log("========================================");
    await browser.close();
    process.exit(fail > 0 ? 1 : 0);
})();
