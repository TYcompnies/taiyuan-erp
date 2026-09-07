/**
 * test-so-alert.js — 销货订单新增提醒回归测试（20260907e，6 项）
 * 需求：「销货订单如有新增订单请发出提示音效」——他机/他标签新增订单经云端同步到达本机时，
 * 播放提示音（Web Audio 合成）+ toast。本机自己建单（上传路径）、手动下载、恢复备份不打扰。
 * 全程拦截云同步通道（textdb / GitHub），内存快照模拟云端，不产生真实网络副作用。
 */
const { chromium } = require('playwright');
const crypto = require('crypto');
const zlib = require('zlib');

const BASE = process.env.BASE || 'http://localhost:8904';
const PASS = 'c663bf4076dc622b4f8fd1e2';
const CODE = '382d3aa9-de38-4803-90be-ed24eff373b5';

let passed = 0, failed = 0;
function ok(name, cond) {
    if (cond) passed++; else failed++;
    console.log((cond ? '  PASS' : '  FAIL') + ': ' + name);
}

function b64(bytes) { return Buffer.from(bytes).toString('base64'); }

/* 构造与 sync.js 相同格式的加密云端快照（TYE1: salt+iv+ct，内层 TY1: zlib deflate） */
async function buildEncSnapshot(payload, rev) {
    const snap = { v: 1, rev, device: 'DTEST', updated_at: new Date().toISOString(), payload };
    const marked = 'TY1:' + b64(zlib.deflateSync(Buffer.from(JSON.stringify(snap))));
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        await crypto.subtle.importKey('raw', Buffer.from(PASS), 'PBKDF2', false, ['deriveKey']),
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(marked));
    return 'TYE1:' + b64(Buffer.concat([salt, iv, Buffer.from(ct)]));
}

/* 构造一份云端可渲染的销货订单（字段对齐页面列表所读字段） */
function mkSO(id, no, customerId) {
    return {
        id, no, channel: '虾皮', platform_no: 'PLT-' + no, customer_id: customerId,
        payment_status: 'unpaid', payment_method: '', currency: 'CNY',
        order_date: '2026-09-07', delivery_date: '', status: 'draft',
        logistics_method: '', sales_owner: 'admin', shipment_no: '',
        recipient_name: '', recipient_phone: '', shipping_address: '',
        invoice_type: '', price_tax_mode: 'tax_included', tax_type: '',
        tax_rate: 0, shipping_fee: 0, commission_rate: 0, platform_fee: 0,
        payment_fee: 0, other_fee: 0, settlement_tax_included: false,
        taxable_amount: 0, tax_amount: 0, invoice_amount: 0, net_receipt: 0,
        invoice_title: '', invoice_tax_id: '', invoice_no: '', invoice_date: '',
        invoice_status: '未开', lines: [], remark: '', created_by: 'DTEST'
    };
}

(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'msedge', args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"] });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    /* ---- 断云：textdb / GitHub 全拦截。POST 记数，GET 注入内存快照 ---- */
    let pushCount = 0;
    let cloudSnapshot = null;
    await ctx.route(/textdb\.online|api\.github\.com|raw\.githubusercontent\.com|cdn\.jsdelivr\.net/i, async r => {
        const url = r.request().url();
        if (url.includes('github')) return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        if (r.request().method() === 'POST') { pushCount++; return r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' }); }
        if (url.includes('api.textdb.online/update/')) return r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' });
        if (cloudSnapshot) return r.fulfill({ status: 200, contentType: 'text/plain', body: cloudSnapshot });
        return r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' });
    });

    /* ---- 首次打开种子化 + 登录 admin ---- */
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const seededObj = JSON.parse(await page.evaluate(() => JSON.stringify(DB._mem)));
    const custId = (seededObj.customers || [])[0] && (seededObj.customers)[0].id;

    await page.evaluate(() => { const f = document.querySelector('#loginForm'); if (f) { document.querySelector('input[name="username"]').value = 'admin'; document.querySelector('input[name="password"]').value = 'admin123'; f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } });
    await page.waitForSelector('.sidebar, nav', { timeout: 15000 });
    await page.waitForTimeout(800);

    /* ---- 替换提示音为计数桩（headless 无真实音频；验证触发逻辑） ---- */
    await page.evaluate(() => { window.__chimeCalls = 0; CloudSync.playNewOrderChime = function () { window.__chimeCalls++; }; });
    await page.waitForTimeout(2200); // 让登录后 1.5s 首拉以「云端无数据」结束（cloudSnapshot 尚未注入）

    /* ========== T1：自动同步到达 2 笔新销货订单 → 响铃 1 次 + toast + 数据套用 ========== */
    const rev1 = Date.now();
    const remote1 = JSON.parse(JSON.stringify(seededObj));
    remote1.sales_orders = [mkSO('so_rmt_a', 'SO-RMTA', custId), mkSO('so_rmt_b', 'SO-RMTB', custId)];
    remote1.__rev = rev1;
    cloudSnapshot = await buildEncSnapshot(remote1, rev1);

    await page.evaluate(() => { location.hash = '#/sales-orders'; });
    await page.waitForTimeout(600);
    const r1 = await page.evaluate(async () => {
        await CloudSync.pull(false); // 自动语义拉取（等同 12 秒轮询命中）
        return new Promise(res => setTimeout(() => res({
            chime: window.__chimeCalls,
            hasA: !!DB.get('sales_orders', 'so_rmt_a'),
            hasB: !!DB.get('sales_orders', 'so_rmt_b'),
            toast: document.body.innerText.includes('新销货订单')
        }), 300));
    });
    ok('T1a 自动同步拉到 2 笔新订单（so_rmt_a/b 已套用）', r1.hasA && r1.hasB);
    ok('T1b 新订单到达播放提示音 1 次', r1.chime === 1);
    ok('T1c 弹出「新销货订单」toast 说明', r1.toast === true);

    /* ========== T2：相同快照重复拉取不重复响铃 ========== */
    const r2 = await page.evaluate(async () => {
        await CloudSync.pull(false);
        return new Promise(res => setTimeout(() => res(window.__chimeCalls), 300));
    });
    ok('T2 内容一致重复拉取不再响铃（计数仍为 1）', r2 === 1);

    /* ========== T3：本机自己新建订单（上传路径）不触发提醒 ========== */
    await page.evaluate((cid) => {
        DB.insert('sales_orders', { id: 'so_local', no: 'SO-LOCAL', channel: '淘宝', platform_no: '', customer_id: cid, payment_status: 'unpaid', payment_method: '', currency: 'CNY', order_date: '2026-09-07', status: 'draft', logistics_method: '', sales_owner: 'admin', invoice_amount: 0, shipping_fee: 0, platform_fee: 0, payment_fee: 0, other_fee: 0, tax_amount: 0, net_receipt: 0, invoice_status: '未开', lines: [], created_by: 'admin' });
        DB.flush();
    }, custId);
    await page.waitForTimeout(4500); // 防抖 3 秒 + 推送
    const r3 = await page.evaluate(() => ({ chime: window.__chimeCalls, pushPending: !!CloudSync._pendingPush }));
    ok('T3 本机新增订单已上传且不响铃（本机录入无需提醒）', r3.chime === 1 && r3.pushPending === false);

    /* ========== T4：手动下载含新订单的云端快照 → 静默套用（不响铃） ========== */
    // 云端构造：以本机当前已上传内容（含 T3 本机单）为基础 + 1 笔新单 so_rmt_c
    const curMem = JSON.parse(await page.evaluate(() => JSON.stringify(DB._mem)));
    curMem.sales_orders = (curMem.sales_orders || []).concat([mkSO('so_rmt_c', 'SO-RMTC', custId)]);
    delete curMem.__hash;
    const rev2 = Date.now() + 100000;
    cloudSnapshot = await buildEncSnapshot(curMem, rev2);
    await page.evaluate(() => CloudSync.pull(true)); // 手动下载 → confirmModal
    await page.waitForSelector('#confirmOkBtn', { timeout: 8000 });
    await page.click('#confirmOkBtn');
    await page.waitForTimeout(800);
    const r4 = await page.evaluate(() => ({ chime: window.__chimeCalls, hasC: !!DB.get('sales_orders', 'so_rmt_c'), hasLocal: !!DB.get('sales_orders', 'so_local') }));
    ok('T4a 手动下载套用云端快照（so_rmt_c 到达、本机单仍保留）', r4.hasC && r4.hasLocal);
    ok('T4b 手动下载静默处理不响铃', r4.chime === 1);

    /* ========== T5：storage 事件（同浏览器他标签写入）含新订单 → 响铃 ========== */
    const r5 = await page.evaluate(() => {
        const mem = JSON.parse(JSON.stringify(DB._mem));
        mem.sales_orders = (mem.sales_orders || []).concat([{ id: 'so_tab', no: 'SO-TAB', channel: '抖音', platform_no: '', customer_id: (DB.list('customers')[0] || {}).id, payment_status: 'unpaid', payment_method: '', currency: 'CNY', order_date: '2026-09-07', status: 'draft', logistics_method: '', sales_owner: 'admin', invoice_amount: 0, shipping_fee: 0, platform_fee: 0, payment_fee: 0, other_fee: 0, tax_amount: 0, net_receipt: 0, invoice_status: '未开', lines: [], created_by: 'admin' }]);
        window.dispatchEvent(new StorageEvent('storage', { key: 'taiyuan_erp_data_v1', newValue: JSON.stringify(mem) }));
        return new Promise(res => setTimeout(() => res({ chime: window.__chimeCalls, hasTab: !!DB.get('sales_orders', 'so_tab') }), 300));
    });
    ok('T5a storage 事件套用他标签数据（so_tab 到达）', r5.hasTab === true);
    ok('T5b 他标签新增订单也触发提示音', r5.chime === 2);

    /* ========== T6：同单不再重复提醒（storage 再投递相同数据不响） ========== */
    const r6 = await page.evaluate(() => {
        const mem = JSON.parse(JSON.stringify(DB._mem));
        window.dispatchEvent(new StorageEvent('storage', { key: 'taiyuan_erp_data_v1', newValue: JSON.stringify(mem) }));
        return new Promise(res => setTimeout(() => res(window.__chimeCalls), 300));
    });
    ok('T6 已提醒过的订单不重复响铃', r6 === 2);

    await browser.close();
    console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
