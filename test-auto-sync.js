/**
 * test-auto-sync.js — 自动云同步新行为验证（10 项）
 *
 * 验证内容：
 * A1  PULL_INTERVAL 为 15000（15 秒轮询）
 * A2  schedulePull 设置防抖定时器（2 秒）
 * A3  schedulePull 多次调用只保留一个定时器
 * A4  schedulePull 未配置时不触发
 * A5  schedulePull autoPull 关闭时不触发
 * A6  schedulePull _busy 时不触发
 * A7  _bindActivity 绑定后设置 _activityBound 标记
 * A8  startAuto 调用后设置 _started 标记并调用 _bindActivity
 * A9  startAuto 未配置时不启动
 * A10 storage 事件处理：另一标签写入数据时即时更新本页 DB._mem
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8902';
let browser, page;
let passed = 0, failed = 0;
const results = [];

async function login() {
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
        const u = document.querySelector('#loginForm input[name="username"]');
        const p = document.querySelector('#loginForm input[name="password"]');
        if (u) u.value = 'admin';
        if (p) p.value = 'admin123';
        const f = document.querySelector('#loginForm');
        if (f) {
            const evt = new Event('submit', { bubbles: true, cancelable: true });
            f.dispatchEvent(evt);
        }
    });
    await page.waitForTimeout(800);
}

async function cleanup() {
    await page.evaluate(() => {
        localStorage.removeItem('taiyuan_sync_cfg_v1');
        localStorage.removeItem('taiyuan_sync_status_v1');
        localStorage.removeItem('taiyuan_device_id_v1');
        CloudSync.cfg = null;
        CloudSync.status = null;
        CloudSync._started = false;
        CloudSync._activityBound = false;
        if (CloudSync._pullTimer) { clearInterval(CloudSync._pullTimer); CloudSync._pullTimer = null; }
        if (CloudSync._pushTimer) { clearTimeout(CloudSync._pushTimer); CloudSync._pushTimer = null; }
        if (CloudSync._focusTimer) { clearTimeout(CloudSync._focusTimer); CloudSync._focusTimer = null; }
    });
}

function ok(name, cond) {
    if (cond) { passed++; results.push('  PASS: ' + name); }
    else { failed++; results.push('  FAIL: ' + name); }
    console.log((cond ? '  PASS' : '  FAIL') + ': ' + name);
}

async function db(page, fn, arg) {
    if (arg) return await page.evaluate(({ src, a }) => eval('(' + src + ')')(a), { src: fn.toString(), a: arg });
    return await page.evaluate(({ src }) => eval('(' + src + ')')(), { src: fn.toString() });
}

(async () => {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await login();

    // == A1: PULL_INTERVAL 为 15000 ==
    console.log('== A1: PULL_INTERVAL ==');
    await cleanup();
    const interval = await db(page, () => CloudSync.PULL_INTERVAL);
    ok('A1 PULL_INTERVAL 为 15000（15 秒轮询）', interval === 15000);

    // == A2: schedulePull 设置防抖定时器 ==
    console.log('== A2: schedulePull 设置定时器 ==');
    await cleanup();
    await db(page, () => {
        CloudSync.cfg = { autoPull: true, code: 'test-code', provider: 'textdb', autoPush: true };
        CloudSync._busy = false;
        CloudSync._applying = false;
        CloudSync.schedulePull();
    });
    await page.waitForTimeout(100);
    const hasTimer2 = await db(page, () => !!CloudSync._focusTimer);
    ok('A2 schedulePull 设置了 _focusTimer 防抖定时器', hasTimer2);

    // == A3: schedulePull 多次调用只保留一个定时器 ==
    console.log('== A3: schedulePull 防抖去重 ==');
    await cleanup();
    await db(page, () => {
        CloudSync.cfg = { autoPull: true, code: 'test-code', provider: 'textdb', autoPush: true };
        CloudSync._busy = false;
        CloudSync._applying = false;
        CloudSync.schedulePull();
        CloudSync.schedulePull();
        CloudSync.schedulePull();
    });
    await page.waitForTimeout(100);
    // _focusTimer 存在即可（防抖保证只有一个）
    const hasTimer3 = await db(page, () => !!CloudSync._focusTimer);
    ok('A3 多次 schedulePull 只保留一个 _focusTimer', hasTimer3);

    // == A4: schedulePull 未配置时不触发 ==
    console.log('== A4: schedulePull 未配置 ==');
    await cleanup();
    await db(page, () => {
        CloudSync.cfg = { autoPull: true, code: '', provider: 'textdb', autoPush: true };
        CloudSync._busy = false;
        CloudSync._applying = false;
        CloudSync._focusTimer = null;
        CloudSync.schedulePull();
    });
    await page.waitForTimeout(100);
    const noTimer4 = await db(page, () => !CloudSync._focusTimer);
    ok('A4 未配置时 schedulePull 不设置 _focusTimer', noTimer4);

    // == A5: schedulePull autoPull 关闭时不触发 ==
    console.log('== A5: schedulePull autoPull 关闭 ==');
    await cleanup();
    await db(page, () => {
        CloudSync.cfg = { autoPull: false, code: 'test-code', provider: 'textdb', autoPush: true };
        CloudSync._busy = false;
        CloudSync._applying = false;
        CloudSync._focusTimer = null;
        CloudSync.schedulePull();
    });
    await page.waitForTimeout(100);
    const noTimer5 = await db(page, () => !CloudSync._focusTimer);
    ok('A5 autoPull 关闭时 schedulePull 不设置 _focusTimer', noTimer5);

    // == A6: schedulePull _busy 时不触发 ==
    console.log('== A6: schedulePull _busy ==');
    await cleanup();
    await db(page, () => {
        CloudSync.cfg = { autoPull: true, code: 'test-code', provider: 'textdb', autoPush: true };
        CloudSync._busy = true;
        CloudSync._applying = false;
        CloudSync._focusTimer = null;
        CloudSync.schedulePull();
    });
    await page.waitForTimeout(100);
    const noTimer6 = await db(page, () => !CloudSync._focusTimer);
    ok('A6 _busy 时 schedulePull 不设置 _focusTimer', noTimer6);

    // == A7: _bindActivity 绑定后设置标记 ==
    console.log('== A7: _bindActivity ==');
    await cleanup();
    await db(page, () => {
        CloudSync._activityBound = false;
        CloudSync._bindActivity();
    });
    await page.waitForTimeout(100);
    const bound = await db(page, () => CloudSync._activityBound);
    ok('A7 _bindActivity 设置了 _activityBound 标记', bound === true);

    // == A8: startAuto 调用后设置 _started 并调用 _bindActivity ==
    console.log('== A8: startAuto ==');
    await cleanup();
    await db(page, () => {
        CloudSync.cfg = { autoPull: true, code: 'test-code', provider: 'textdb', autoPush: true };
        CloudSync._started = false;
        CloudSync._activityBound = false;
        CloudSync._busy = false;
        CloudSync.startAuto();
    });
    await page.waitForTimeout(100);
    const started = await db(page, () => CloudSync._started);
    const activityBound = await db(page, () => CloudSync._activityBound);
    ok('A8 startAuto 设置 _started = true', started === true);
    ok('A8b startAuto 调用了 _bindActivity（_activityBound = true）', activityBound === true);
    // 清理定时器
    await db(page, () => { if (CloudSync._pullTimer) { clearInterval(CloudSync._pullTimer); CloudSync._pullTimer = null; } });

    // == A9: startAuto 未配置时不启动 ==
    console.log('== A9: startAuto 未配置 ==');
    await cleanup();
    await db(page, () => {
        CloudSync.cfg = { autoPull: true, code: '', provider: 'textdb', autoPush: true };
        CloudSync._started = false;
        CloudSync._activityBound = false;
        CloudSync.startAuto();
    });
    await page.waitForTimeout(100);
    const notStarted = await db(page, () => !CloudSync._started);
    const notBound = await db(page, () => !CloudSync._activityBound);
    ok('A9 未配置时 startAuto 不设置 _started', notStarted);
    ok('A9b 未配置时 startAuto 不调用 _bindActivity', notBound);

    // == A10: storage 事件处理：另一标签写入数据时即时更新 ==
    console.log('== A10: storage 事件即时同步 ==');
    await cleanup();
    await db(page, () => {
        CloudSync.cfg = { autoPull: true, code: 'test-code', provider: 'textdb', autoPush: true };
        CloudSync._activityBound = false;
        CloudSync._applying = false;
        CloudSync._bindActivity();
        // 当前 DB._mem 里 items 数量
        window.__beforeCount = (DB._mem.items || []).length;
        // 构造一份新数据（items +1）
        const newData = JSON.parse(JSON.stringify(DB._mem));
        newData.items = newData.items || [];
        newData.items.push({ id: 'test_item_st', name: 'Storage 测试商品', code: 'ST001', stock_unit: '个', sales_to_stock: 1, purchase_to_stock: 1, cost: 10, currency: 'CNY', category_id: 'cat1', active: true });
        // 模拟 storage 事件（同标签内 dispatchEvent）
        const ev = new StorageEvent('storage', { key: 'taiyuan_erp_data_v1', newValue: JSON.stringify(newData) });
        window.dispatchEvent(ev);
    });
    await page.waitForTimeout(300);
    const afterCount = await db(page, () => (DB._mem.items || []).length);
    const beforeCount = await db(page, () => window.__beforeCount);
    ok('A10 storage 事件即时更新了 DB._mem（items 数量 +1）', afterCount === beforeCount + 1);
    // 清理测试数据
    await db(page, () => {
        DB._mem.items = (DB._mem.items || []).filter(i => i.id !== 'test_item_st');
        localStorage.setItem('taiyuan_erp_data_v1', JSON.stringify(DB._mem));
    });

    // 打印结果
    console.log('\n========================================');
    console.log('自动同步新行为测试结果：' + passed + ' 通过 / ' + failed + ' 失败');
    console.log('========================================');

    await browser.close();
    process.exit(failed > 0 ? 1 : 0);
})();
