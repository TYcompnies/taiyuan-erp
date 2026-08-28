/**
 * test-attendance.js — 出勤管理模块集成测试（15 项）
 * 验证出勤系统完整嵌入 ERP，设置保持不变，功能正常可用。
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8902';

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
    await page.waitForSelector('#loginForm', { timeout: 10000 });
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'admin123');
    await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector('.erp-shell', { timeout: 10000 });
}

async function gotoHash(page, hash) {
    // 先清除残留弹窗
    await page.evaluate(() => {
        document.querySelectorAll('.modal-mask').forEach(m => m.remove());
    });
    await page.evaluate(h => { location.hash = h; }, hash);
    await page.waitForTimeout(800);
}

async function getFrame(page) {
    // 等待 iframe 加载
    await page.waitForSelector('#attendanceFrame', { timeout: 8000 });
    await page.waitForTimeout(2000); // 等 iframe 内容加载
    const frames = page.frames();
    const f = frames.find(fr => fr.url().includes('attendance/index.html'));
    if (!f) throw new Error('找不到出勤系统 iframe frame (frames: ' + frames.map(f => f.url()).join(', ') + ')');
    return f;
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();

    // ===== 1. 出勤菜单可见 =====
    await test('出勤菜单在侧边栏可见', async () => {
        await login(page);
        await gotoHash(page, '#/dashboard');
        // 展开出勤管理分组
        const groups = await page.locator('.menu-group').all();
        let found = false;
        for (const g of groups) {
            const text = await g.textContent();
            if (text.includes('出勤管理')) {
                await g.click();
                found = true;
                break;
            }
        }
        if (!found) throw new Error('侧边栏无出勤管理分组');
        const link = page.locator('.menu-link[data-code="attendance"]');
        await link.waitFor({ timeout: 3000 });
        const label = await link.textContent();
        if (!label.includes('出勤管理')) throw new Error(`菜单文字不符: ${label}`);
    });

    // ===== 2. 路由 #/attendance 可达 =====
    await test('路由 #/attendance 正确渲染', async () => {
        await gotoHash(page, '#/attendance');
        const embed = page.locator('.attendance-embed');
        await embed.waitFor({ timeout: 5000 });
        const exists = await embed.count();
        if (!exists) throw new Error('出勤嵌入容器未渲染');
    });

    // ===== 3. iframe 存在且 src 正确 =====
    await test('iframe 存在且指向 attendance/index.html', async () => {
        await gotoHash(page, '#/attendance');
        const iframe = page.locator('#attendanceFrame');
        await iframe.waitFor({ timeout: 5000 });
        const src = await iframe.getAttribute('src');
        if (!src || !src.includes('attendance/index.html'))
            throw new Error(`iframe src 不正确: ${src}`);
    });

    // ===== 4. iframe 内容加载（出勤系统登录页） =====
    await test('iframe 内出勤系统登录页加载', async () => {
        await gotoHash(page, '#/attendance');
        const frame = await getFrame(page);
        const title = await frame.title();
        if (!title.includes('出勤') && !title.includes('WiFi'))
            throw new Error(`iframe 内 title 不含出勤: "${title}"`);
    });

    // ===== 5. 出勤系统可登录 =====
    await test('出勤系统可登录（admin/admin123）', async () => {
        await gotoHash(page, '#/attendance');
        const frame = await getFrame(page);
        // 等登录页加载
        await frame.waitForSelector('.login-card input', { timeout: 8000 });
        const inputs = await frame.locator('.login-card input').all();
        if (inputs.length < 2) throw new Error(`登录表单输入框不足: ${inputs.length}`);
        await inputs[0].fill('admin');
        await inputs[1].fill('admin123');
        const btn = frame.locator('.login-card .btn-primary').first();
        await btn.click();
        await frame.waitForTimeout(3000);
        // 验证登录成功 — dashboard 或 topbar 出现
        const dash = await frame.locator('.dashboard.active, .topbar').count();
        if (!dash) throw new Error('登录后仪表板未显示');
    });

    // ===== 6. 打卡页面可见 =====
    await test('出勤系统打卡页面可见', async () => {
        const frame = await getFrame(page);
        // 确保在打卡页
        const clockTab = frame.locator('[data-page="clock"]').first();
        if (await clockTab.count()) { await clockTab.click(); await frame.waitForTimeout(500); }
        const clockPage = await frame.locator('#page-clock').count();
        if (!clockPage) throw new Error('打卡页面未显示');
    });

    // ===== 7. 导航标签完整 =====
    await test('出勤系统导航标签完整（打卡/記錄/請假）', async () => {
        const frame = await getFrame(page);
        const tabs = await frame.locator('.nav-tab, [data-page]').allTextContents();
        const allText = tabs.join(' ');
        const hasClock = allText.includes('打卡');
        const hasHistory = allText.includes('記錄') || allText.includes('记录');
        const hasLeave = allText.includes('請假') || allText.includes('请假');
        if (!hasClock || !hasHistory || !hasLeave)
            throw new Error(`导航标签不完整: ${allText}`);
    });

    // ===== 8. 管理员标签可见 =====
    await test('管理员功能标签可见（統計/員工/考勤/設定）', async () => {
        const frame = await getFrame(page);
        const visibleCount = await frame.locator('.nav-tab.admin-only:not([style*="display:none"]), .admin-only[data-page]:not([style*="display:none"])').count();
        if (visibleCount < 3) throw new Error(`管理员标签可见数不足: ${visibleCount}`);
    });

    // ===== 9. 出勤系统独立访问正常 =====
    await test('出勤系统独立访问正常（非 iframe）', async () => {
        const page2 = await browser.newPage();
        await page2.goto(BASE + '/attendance/index.html');
        await page2.waitForSelector('.login-card', { timeout: 8000 });
        const title = await page2.title();
        if (!title.includes('出勤')) throw new Error(`独立访问 title 不含出勤: ${title}`);
        await page2.close();
    });

    // ===== 10. 出勤系统独立登录正常 =====
    await test('出勤系统独立登录功能正常', async () => {
        const page2 = await browser.newPage();
        await page2.goto(BASE + '/attendance/index.html');
        await page2.waitForSelector('.login-card input', { timeout: 8000 });
        const inputs = await page2.locator('.login-card input').all();
        await inputs[0].fill('admin');
        await inputs[1].fill('admin123');
        await page2.locator('.login-card .btn-primary').click();
        await page2.waitForTimeout(3000);
        const dash = await page2.locator('.dashboard.active, .topbar').count();
        if (!dash) throw new Error('独立登录后仪表板未显示');
        await page2.close();
    });

    // ===== 11. 出勤系统 localStorage 独立 =====
    await test('出勤系统 localStorage 与 ERP 数据隔离', async () => {
        const erpData = await page.evaluate(() => localStorage.getItem('taiyuan_erp_data_v1'));
        if (!erpData) throw new Error('ERP 数据键不存在');
        // 在独立页面验证出勤数据键
        const page2 = await browser.newPage();
        await page2.goto(BASE + '/attendance/index.html');
        await page2.waitForTimeout(1000);
        const attData = await page2.evaluate(() => localStorage.getItem('attendance_system_db'));
        await page2.close();
        if (!attData) throw new Error('出勤数据键不存在');
        if (attData === erpData) throw new Error('数据键冲突');
        const parsed = JSON.parse(attData);
        if (parsed.items || parsed.sales_orders || parsed.vouchers)
            throw new Error('出勤数据混入了 ERP 集合');
    });

    // ===== 12. 工具栏新窗口链接正确 =====
    await test('工具栏「新窗口打开」链接正确', async () => {
        await gotoHash(page, '#/attendance');
        const link = page.locator('.attendance-toolbar-actions a');
        await link.waitFor({ timeout: 5000 });
        const href = await link.getAttribute('href');
        const target = await link.getAttribute('target');
        if (!href || !href.includes('attendance/index.html'))
            throw new Error(`新窗口链接 href 不正确: ${href}`);
        if (target !== '_blank') throw new Error(`target 不是 _blank: ${target}`);
    });

    // ===== 13. 出勤系统打卡功能测试 =====
    await test('出勤系统打卡页面功能正常', async () => {
        await gotoHash(page, '#/attendance');
        const frame = await getFrame(page);
        // 确保已登录
        const loggedIn = await frame.locator('.dashboard.active, .topbar').count();
        if (!loggedIn) {
            // 重新登录
            await frame.waitForSelector('.login-card input', { timeout: 5000 });
            const inputs = await frame.locator('.login-card input').all();
            await inputs[0].fill('admin');
            await inputs[1].fill('admin123');
            await frame.locator('.login-card .btn-primary').click();
            await frame.waitForTimeout(3000);
        }
        // 切换到打卡页
        const clockTab = frame.locator('[data-page="clock"]').first();
        if (await clockTab.count()) { await clockTab.click(); await frame.waitForTimeout(500); }
        // 验证时钟显示
        const clockTime = await frame.locator('.clock-time').count();
        if (!clockTime) throw new Error('时钟显示元素未找到');
        // 验证状态项
        const statusItems = await frame.locator('.status-item').count();
        if (statusItems < 2) throw new Error(`状态项不足: ${statusItems}`);
    });

    // ===== 14. ERP 其他功能不受影响 =====
    await test('ERP 原有功能不受影响（仪表板正常）', async () => {
        await gotoHash(page, '#/dashboard');
        const dash = page.locator('.kpi-grid').first();
        await dash.waitFor({ timeout: 8000 });
        const count = await dash.count();
        if (!count) throw new Error('仪表板 KPI 未渲染');
    });

    // ===== 15. ERP 账款模块不受影响（会计模块已移除，验证 AR 页正常） =====
    await test('ERP 账款模块不受影响（应收账款页正常）', async () => {
        await gotoHash(page, '#/accounting/accounts-receivable');
        await page.waitForTimeout(1000);
        const content = await page.locator('.content').textContent();
        if (!content.includes('应收') && !content.includes('收款'))
            throw new Error('应收账款页内容异常');
    });

    await browser.close();

    console.log('\n===== 出勤模块集成测试 =====');
    results.forEach(r => console.log(r));
    console.log(`\n总计: ${pass} 通过 / ${fail} 失败`);
    process.exit(fail > 0 ? 1 : 0);
})();
