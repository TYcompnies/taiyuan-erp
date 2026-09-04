/**
 * test-menu-order.js — 菜单顺序专项测试（2026-09-03）
 * 需求：
 *   1) 日常作业组内顺序：采购单 / 销货订单 / 出货单 / 采购退回/折让 / 销货退回/折让 / 样品领料
 *   2) ERP 组顺序：首页 / 基本资料 / 日常作业 / 进销存账款 / 财务会计 / 商品估价试算 / 报表查询 / 出勤管理 / 系统设置
 * 运行：BASE=<云端或本地 URL> node test-menu-order.js
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8904';

let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
    try { await fn(); pass++; results.push(`✅ PASS: ${name}`); }
    catch (e) { fail++; results.push(`❌ FAIL: ${name} — ${e.message.split('\n')[0]}`); }
}
async function login(page) {
    // 拦截云同步域名（textdb/GitHub API），防拉生产云覆盖注入数据/测试数据外推
    await page.context().route(/textdb\.online|api\.github\.com|raw\.githubusercontent\.com/i, r => (r.request().url().includes('github') ? r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : (r.request().method() === 'POST' ? r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' }) : r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' }))).catch(() => { }));
    await page.goto(BASE);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(BASE);
    await page.evaluate(() => {
        try {
            localStorage.removeItem("taiyuan_sync_cfg_v1");
            if (typeof CloudSync !== "undefined") {
                CloudSync.DEFAULT_SYNC_CFG = null;
                CloudSync._started = true;
                if (CloudSync._pullTimer) clearInterval(CloudSync._pullTimer);
            }
        } catch (e) { }
    });
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'admin123');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.sidebar, nav', { timeout: 15000 });
    await page.waitForTimeout(500);
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    try {
        await login(page);

        /* ---------- 1. ERP 组顺序（admin 全权限渲染序） ---------- */
        await test('G1 菜单组顺序 首页/基本资料/日常作业/进销存账款/财务会计/商品估价试算/报表查询/出勤管理/系统设置', async () => {
            const order = await page.evaluate(() =>
                Array.from(document.querySelectorAll('.menu-group .menu-main span')).map(s => s.textContent.trim()));
            const expected = ['首页', '基本资料', '日常作业', '进销存账款', '财务会计', '商品估价试算', '报表查询', '出勤管理', '系统设置'];
            if (JSON.stringify(order) !== JSON.stringify(expected)) {
                throw new Error(`实际组序 ${JSON.stringify(order)}`);
            }
        });

        /* ---------- 2. 日常作业组内顺序 ---------- */
        await test('G2 日常作业组内顺序 采购单/销货订单/出货单/采购退回折让/销货退回折让/样品领料', async () => {
            const order = await page.evaluate(() => {
                const g = Array.from(document.querySelectorAll('.menu-group')).find(grp => {
                    const sp = grp.querySelector('.menu-main span');
                    return sp && sp.textContent.trim() === '日常作业';
                });
                return g ? Array.from(g.querySelectorAll('.menu-link')).map(a => a.textContent.trim()) : [];
            });
            const expected = ['采购单', '销货订单', '出货单', '采购退回/折让', '销货退回/折让', '样品领料'];
            if (JSON.stringify(order) !== JSON.stringify(expected)) {
                throw new Error(`实际项序 ${JSON.stringify(order)}`);
            }
        });

        /* ---------- 3. 日常作业组内顺序与路由 hash 对应 ---------- */
        await test('G3 日常作业组项 hash 对应（采购#/purchase-orders、销货#/sales-orders…）', async () => {
            const pairs = await page.evaluate(() => {
                const g = Array.from(document.querySelectorAll('.menu-group')).find(grp => {
                    const sp = grp.querySelector('.menu-main span');
                    return sp && sp.textContent.trim() === '日常作业';
                });
                return g ? Array.from(g.querySelectorAll('.menu-link')).map(a => ({ t: a.textContent.trim(), href: a.getAttribute('href') })) : [];
            });
            const expected = [
                { t: '采购单', href: '#/purchase-orders' },
                { t: '销货订单', href: '#/sales-orders' },
                { t: '出货单', href: '#/shipments' },
                { t: '采购退回/折让', href: '#/purchase-returns' },
                { t: '销货退回/折让', href: '#/sales-returns' },
                { t: '样品领料', href: '#/inventory/inventory_adjust' }
            ];
            if (JSON.stringify(pairs) !== JSON.stringify(expected)) {
                throw new Error(`实际配对 ${JSON.stringify(pairs)}`);
            }
        });

        /* ---------- 4. 顺序导航抽查：点击第 1 项采购单可进入采购页 ---------- */
        await test('G4 点击日常作业组第 1 项「采购单」路由正确', async () => {
            await page.evaluate(() => {
                const g = Array.from(document.querySelectorAll('.menu-group')).find(grp => {
                    const sp = grp.querySelector('.menu-main span');
                    return sp && sp.textContent.trim() === '日常作业';
                });
                g.querySelector('.menu-link').click();
            });
            await page.waitForTimeout(600);
            const ok = await page.evaluate(() => location.hash.startsWith('#/purchase-orders') && document.querySelector('.main h1, .content h1, #app h1') !== null);
            if (!ok) throw new Error(`hash=${await page.evaluate(() => location.hash)}`);
        });

    } catch (e) {
        fail++;
        results.push(`❌ FAIL: 套件异常 — ${e.message.split('\n')[0]}`);
    } finally {
        await browser.close();
    }

    console.log(`\n菜单顺序测试：通过 ${pass} / 失败 ${fail}`);
    results.forEach(r => console.log(r));
    process.exit(fail ? 1 : 0);
})();
