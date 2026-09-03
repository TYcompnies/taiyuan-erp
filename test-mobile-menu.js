/* 移动端 ☰ 菜单按钮修复验证（移动端抽屉 + 桌面端折叠双逻辑） */
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:8904";
let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
}
async function login(page) {
    await page.goto(BASE + "/#/login", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
        const u = document.querySelector("#loginForm input[name='username']");
        const p = document.querySelector("#loginForm input[name='password']");
        if (u) u.value = "admin";
        if (p) p.value = "admin123";
        const f = document.querySelector("#loginForm");
        if (f) f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(800);
    // 等主壳完全渲染后再交互（过早点击会因冷启动渲染未就绪导致抽屉过渡不触发）
    await page.waitForSelector(".erp-shell", { timeout: 8000 });
    await page.waitForTimeout(600);
}
async function menuState(page) {
    return page.evaluate(() => {
        const sb = document.querySelector(".sidebar");
        const mask = document.querySelector(".sidebar-mask");
        if (!sb) return { rendered: false };
        // headless 下 CSS transition 动画时钟可能冻结（无 BeginFrame，过渡停在起点值），
        // 与逻辑无关。测量前强制收束所有过渡到最终状态，断言才具有确定性。
        try { document.getAnimations().forEach(a => { try { a.finish(); } catch (e) { /* 无限动画不可 finish */ } }); } catch (e) {}
        const r = sb.getBoundingClientRect();
        return {
            rendered: true,
            bodyOpen: document.body.classList.contains("sidebar-open"),
            bodyCollapsed: document.body.classList.contains("sidebar-collapsed"),
            rectLeft: Math.round(r.left),
            rectRight: Math.round(r.right),
            maskDisplay: mask ? getComputedStyle(mask).display : "none"
        };
    });
}

(async () => {
    const browser = await chromium.launch({ channel: "msedge", headless: true });

    // ============ 移动端（390x844 手机视口） ============
    console.log("\n── 移动端（390x844）──");
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await mctx.route(/textdb\.online|github|githubusercontent/i, r => (r.request().url().includes('github') ? r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : (r.request().method() === 'POST' ? r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' }) : r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' }))).catch(() => { }));
    const mp = await mctx.newPage();
    await login(mp);

    let st = await menuState(mp);
    ok("M1 登录后侧边栏默认隐藏（在屏幕外）", st.rendered && st.rectRight <= 0 && !st.bodyOpen);
    ok("M1b 遮罩默认隐藏", st.maskDisplay === "none");

    // 点击 ☰ 展开
    await mp.click(".topbar .icon-btn >> nth=0");
    await mp.waitForTimeout(400);
    st = await menuState(mp);
    ok("M2 点击 ☰ 后侧边栏滑出（body.sidebar-open）", st.bodyOpen && !st.bodyCollapsed && st.rectLeft >= 0);
    ok("M2b 遮罩显示", st.maskDisplay === "block");

    // 点击遮罩关闭
    await mp.click(".sidebar-mask", { position: { x: 380, y: 400 } });
    await mp.waitForTimeout(400);
    st = await menuState(mp);
    ok("M3 点击遮罩后侧边栏收起（sidebar-open 移除）", !st.bodyOpen && !st.bodyCollapsed && st.rectRight <= 0);

    // 再次展开 → 点击非当前页菜单链接 → 跳转且自动收起
    await mp.click(".topbar .icon-btn >> nth=0");
    await mp.waitForTimeout(300);
    const clicked = await mp.evaluate(() => {
        const cur = location.hash;
        const link = Array.from(document.querySelectorAll(".menu-link")).find(a => a.getAttribute("href") !== cur);
        if (!link) return false;
        link.click();
        return true;
    });
    await mp.waitForTimeout(700);
    st = await menuState(mp);
    const hash = await mp.evaluate(() => location.hash);
    ok("M4 展开后点击菜单项跳转页面", clicked && hash.startsWith("#/") && hash !== "#/dashboard" && hash !== "");
    ok("M4b 跳转后侧边栏自动收起", !st.bodyOpen);

    // 移动端不残留 sidebar-collapsed（无 localStorage 写入）
    const ls = await mp.evaluate(() => localStorage.getItem("taiyuan_erp_sidebar"));
    ok("M5 移动端不写桌面折叠状态", ls === null);
    await mctx.close();

    // ============ 桌面端（1280x800） ============
    console.log("\n── 桌面端（1280x800）──");
    const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await dctx.route(/textdb\.online|github|githubusercontent/i, r => (r.request().url().includes('github') ? r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : (r.request().method() === 'POST' ? r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' }) : r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' }))).catch(() => { }));
    const dp = await dctx.newPage();
    await login(dp);
    st = await menuState(dp);
    ok("D1 登录后侧边栏默认显示", st.rendered && !st.bodyCollapsed && !st.bodyOpen && st.rectLeft >= 0);

    await dp.click(".topbar .icon-btn >> nth=0");
    await dp.waitForTimeout(300);
    st = await menuState(dp);
    ok("D2 点击 ☰ 后折叠（sidebar-collapsed）", st.bodyCollapsed && st.rectRight <= 0);

    await dp.click(".topbar .icon-btn >> nth=0");
    await dp.waitForTimeout(300);
    st = await menuState(dp);
    ok("D3 再次点击恢复展开", !st.bodyCollapsed && st.rectLeft >= 0);

    // 折叠状态持久化：折叠后 reload
    await dp.click(".topbar .icon-btn >> nth=0");
    await dp.waitForTimeout(300);
    await dp.reload({ waitUntil: "domcontentloaded" });
    await dp.waitForTimeout(1200);
    st = await menuState(dp);
    ok("D4 折叠状态刷新后保持", st.bodyCollapsed);
    await dctx.close();

    await browser.close();
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
