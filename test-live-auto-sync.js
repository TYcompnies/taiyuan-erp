/**
 * test-live-auto-sync.js — 线上自动云同步改造验证（6 项）
 * 验证线上版本包含跨设备自动同步新代码
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'https://tycompnies.github.io/taiyuan-erp/';
let browser, page;
let passed = 0, failed = 0;

async function login() {
    await page.goto(BASE + '#/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
        const u = document.querySelector('#loginForm input[name="username"]');
        const p = document.querySelector('#loginForm input[name="password"]');
        if (u) u.value = 'admin';
        if (p) p.value = 'admin123';
        const f = document.querySelector('#loginForm');
        if (f) { const e = new Event('submit', { bubbles: true, cancelable: true }); f.dispatchEvent(e); }
    });
    await page.waitForTimeout(1500);
}

function ok(name, cond) {
    if (cond) { passed++; }
    else { failed++; }
    console.log((cond ? '  PASS' : '  FAIL') + ': ' + name);
}

async function db(page, fn, arg) {
    if (arg) return await page.evaluate(({ src, a }) => eval('(' + src + ')')(a), { src: fn.toString(), a: arg });
    return await page.evaluate(({ src }) => eval('(' + src + ')')(), { src: fn.toString() });
}

(async () => {
    browser = await chromium.launch({ headless: true, channel: 'msedge', args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"] });
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    // 禁用自动同步（线上验证脚本不读写生产云数据；仅验证代码行为）
    await page.evaluate(() => { if (typeof CloudSync !== 'undefined') CloudSync.DEFAULT_SYNC_CFG = null; });
    await login();

    console.log('== 线上自动云同步验证 ==');

    // L1: 轮询间隔 12s（8/27 弱网强化调整）+ fetch 超时 15s
    const interval = await db(page, () => ({ pull: CloudSync.PULL_INTERVAL, fetch: CloudSync.FETCH_TIMEOUT }));
    ok('L1 PULL_INTERVAL 为 12000（12 秒轮询）', interval.pull === 12000);
    ok('L1b FETCH_TIMEOUT 为 15000（弱网 15s 超时切备用通道）', interval.fetch === 15000);

    // L2: schedulePull 方法存在
    const hasSchedulePull = await db(page, () => typeof CloudSync.schedulePull === 'function');
    ok('L2 schedulePull 方法已部署', hasSchedulePull);

    // L3: _bindActivity 方法存在
    const hasBindActivity = await db(page, () => typeof CloudSync._bindActivity === 'function');
    ok('L3 _bindActivity 方法已部署', hasBindActivity);

    // L4: schedulePull 设置定时器
    await db(page, () => {
        CloudSync.cfg = { autoPull: true, code: 'test-code', provider: 'textdb', autoPush: true };
        CloudSync._busy = false;
        CloudSync._applying = false;
        CloudSync._focusTimer = null;
        CloudSync.schedulePull();
    });
    await page.waitForTimeout(200);
    const hasTimer = await db(page, () => !!CloudSync._focusTimer);
    ok('L4 schedulePull 成功设置 _focusTimer 防抖定时器', hasTimer);

    // L5: _bindActivity 绑定后设置标记
    await db(page, () => {
        CloudSync._activityBound = false;
        CloudSync._bindActivity();
    });
    await page.waitForTimeout(100);
    const bound = await db(page, () => CloudSync._activityBound);
    ok('L5 _bindActivity 绑定活动监听成功', bound === true);

    // L6: storage 事件即时同步
    await db(page, () => {
        CloudSync._applying = false;
        CloudSync._activityBound = false;
        CloudSync._bindActivity();
        window.__before = (DB._mem.items || []).length;
        const newData = JSON.parse(JSON.stringify(DB._mem));
        newData.items = newData.items || [];
        newData.items.push({ id: 'live_test_item', name: 'Live Test', code: 'LT001', stock_unit: '个', sales_to_stock: 1, purchase_to_stock: 1, cost: 1, currency: 'CNY', category_id: 'cat1', active: true });
        const ev = new StorageEvent('storage', { key: 'taiyuan_erp_data_v1', newValue: JSON.stringify(newData) });
        window.dispatchEvent(ev);
    });
    await page.waitForTimeout(300);
    const after = await db(page, () => (DB._mem.items || []).length);
    const before = await db(page, () => window.__before);
    ok('L6 storage 事件即时同步正常（items +1）', after === before + 1);

    // 清理
    await db(page, () => {
        DB._mem.items = (DB._mem.items || []).filter(i => i.id !== 'live_test_item');
        localStorage.setItem('taiyuan_erp_data_v1', JSON.stringify(DB._mem));
    });

    console.log('\n========================================');
    console.log('线上自动同步验证：' + passed + ' 通过 / ' + failed + ' 失败');
    console.log('========================================');

    await browser.close();
    process.exit(failed > 0 ? 1 : 0);
})();
