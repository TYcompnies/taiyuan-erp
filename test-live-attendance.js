/**
 * test-live-attendance.js — 线上出勤模块验证（8 项）
 * 验证线上 GitHub Pages 的出勤系统嵌入功能。
 */
const { chromium } = require('playwright');
const BASE = 'https://tycompnies.github.io/taiyuan-erp';

let pass = 0, fail = 0;
const results = [];

async function test(name, fn) {
    try {
        await fn();
        pass++;
        results.push(`✅ PASS: ${name}`);
    } catch (e) {
        fail++;
        results.push(`❌ FAIL: ${name} — ${e.message}`);
    }
}

async function login(page) {
    await page.goto(BASE);
    // 禁用自动同步（线上验证脚本不读写生产云数据）
    await page.evaluate(() => { if (typeof CloudSync !== 'undefined') CloudSync.DEFAULT_SYNC_CFG = null; });
    await page.waitForSelector('#loginForm', { timeout: 15000 });
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'admin123');
    await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector('.erp-shell', { timeout: 15000 });
}

async function gotoHash(page, hash) {
    await page.evaluate(() => {
        document.querySelectorAll('.modal-mask').forEach(m => m.remove());
    });
    await page.evaluate(h => { location.hash = h; }, hash);
    await page.waitForTimeout(1200);
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();

    // ===== 1. ERP 登录正常 =====
    await test('线上 ERP 登录正常', async () => {
        await login(page);
        const shell = await page.locator('.erp-shell').count();
        if (!shell) throw new Error('ERP shell 未渲染');
    });

    // ===== 2. 出勤菜单可见 =====
    await test('线上出勤菜单可见', async () => {
        await gotoHash(page, '#/dashboard');
        const groups = await page.locator('.menu-group').all();
        let found = false;
        for (const g of groups) {
            const text = await g.textContent();
            if (text.includes('出勤管理')) { await g.click(); found = true; break; }
        }
        if (!found) throw new Error('无出勤管理菜单组');
        const link = page.locator('.menu-link[data-code="attendance"]');
        await link.waitFor({ timeout: 5000 });
    });

    // ===== 3. 出勤路由渲染 =====
    await test('线上出勤路由 #/attendance 渲染', async () => {
        await gotoHash(page, '#/attendance');
        const embed = page.locator('.attendance-embed');
        await embed.waitFor({ timeout: 8000 });
    });

    // ===== 4. iframe 加载出勤系统 =====
    await test('线上 iframe 加载出勤系统', async () => {
        await gotoHash(page, '#/attendance');
        await page.waitForSelector('#attendanceFrame', { timeout: 8000 });
        await page.waitForTimeout(3000);
        const frames = page.frames();
        const f = frames.find(fr => fr.url().includes('attendance/index.html'));
        if (!f) throw new Error('找不到出勤 iframe frame');
        const title = await f.title();
        if (!title.includes('出勤')) throw new Error(`title 不含出勤: ${title}`);
    });

    // ===== 5. 出勤系统独立访问 =====
    await test('线上出勤系统独立访问正常', async () => {
        const p2 = await browser.newPage();
        await p2.goto(BASE + '/attendance/index.html');
        await p2.waitForSelector('.login-card', { timeout: 15000 });
        const title = await p2.title();
        if (!title.includes('出勤')) throw new Error(`独立 title: ${title}`);
        await p2.close();
    });

    // ===== 6. 出勤系统独立登录 =====
    await test('线上出勤系统独立登录正常', async () => {
        const p2 = await browser.newPage();
        await p2.goto(BASE + '/attendance/index.html');
        await p2.waitForSelector('.login-card input', { timeout: 15000 });
        const inputs = await p2.locator('.login-card input').all();
        await inputs[0].fill('admin');
        await inputs[1].fill('admin123');
        await p2.locator('.login-card .btn-primary').click();
        await p2.waitForTimeout(4000);
        const dash = await p2.locator('.dashboard.active, .topbar').count();
        if (!dash) throw new Error('独立登录后仪表板未显示');
        await p2.close();
    });

    // ===== 7. ERP iframe 内出勤系统登录 =====
    await test('线上 ERP iframe 内出勤系统登录', async () => {
        await gotoHash(page, '#/attendance');
        await page.waitForSelector('#attendanceFrame', { timeout: 8000 });
        await page.waitForTimeout(2000);
        const frame = page.frames().find(fr => fr.url().includes('attendance/index.html'));
        if (!frame) throw new Error('找不到 iframe frame');
        await frame.waitForSelector('.login-card input', { timeout: 10000 });
        const inputs = await frame.locator('.login-card input').all();
        await inputs[0].fill('admin');
        await inputs[1].fill('admin123');
        await frame.locator('.login-card .btn-primary').click();
        await frame.waitForTimeout(4000);
        const dash = await frame.locator('.dashboard.active, .topbar').count();
        if (!dash) throw new Error('iframe 内登录后仪表板未显示');
    });

    // ===== 8. ERP 其他功能正常 =====
    await test('线上 ERP 仪表板正常', async () => {
        await gotoHash(page, '#/dashboard');
        const dash = page.locator('.kpi-grid').first();
        await dash.waitFor({ timeout: 10000 });
    });

    await browser.close();

    console.log('\n===== 线上出勤模块验证 =====');
    results.forEach(r => console.log(r));
    console.log(`\n总计: ${pass} 通过 / ${fail} 失败`);
    process.exit(fail > 0 ? 1 : 0);
})();
