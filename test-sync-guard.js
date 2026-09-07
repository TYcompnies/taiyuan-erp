/**
 * test-sync-guard.js — 云端覆盖防护回归测试（20260907c，4 项）
 * 事故背景：9/7 用户云端资料被旧设备覆盖——旧浏览器打开新版页面时，载入迁移链改写数据
 * 使内容指纹失配，被误判为「本地有未上传的改动」而抢先推上云端（后推赢覆盖云端最新）。
 * 修复：①载入迁移期间 flush 不调度云推；②迁移改写过数据则清空 __hash，首拉改为采纳云端较新资料。
 * 全程拦截云同步通道（textdb / GitHub），用内存快照模拟云端，不产生真实网络副作用。
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

(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'msedge', args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"] });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    /* ---- 断云：textdb / GitHub 全拦截。记录 push 次数，GET 可注入内存快照 ---- */
    let pushCount = 0;
    let cloudSnapshot = null; // null = 云端无数据（key not found）
    await ctx.route(/textdb\.online|api\.github\.com|raw\.githubusercontent\.com/i, async r => {
        const url = r.request().url();
        if (url.includes('github')) return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        if (r.request().method() === 'POST') { pushCount++; return r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' }); }
        if (url.includes('api.textdb.online/update/')) return r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' });
        if (cloudSnapshot) return r.fulfill({ status: 200, contentType: 'text/plain', body: cloudSnapshot });
        return r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' });
    });

    /* ---- 准备：首次打开让系统种子化，然后取回种子库 ---- */
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const seeded = await page.evaluate(() => JSON.stringify(DB._mem));
    const seededObj = JSON.parse(seeded);

    /* ========== G1：旧数据（含已移除的会计资料）打开不抢推云端 ========== */
    // 模拟旧设备：dbVersion 已是 3 但带 chart_accounts 残留（purgeAccounting 会清掉 → 迁移改写数据）
    // 且 __hash 有效、__rev 较旧——即「上次同步过、但数据是旧版结构」的设备
    const stale = JSON.parse(seeded);
    stale.chart_accounts = [{ id: 'ca1', name: '旧科目' }];
    stale.vouchers = [{ id: 'v1' }];
    stale.__hash = 'aaaa1111bbbb2222';
    stale.__rev = 1000;
    await page.evaluate(d => localStorage.setItem('taiyuan_erp_data_v1', d), JSON.stringify(stale));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000); // 迁移 flush 的旧逻辑会在载入后 ~3 秒触发推送

    const g1 = await page.evaluate(() => ({
        hash: String(DB._mem.__hash || ''),
        pendingPush: !!CloudSync._pendingPush,
        chart: (DB._mem.chart_accounts || []).length
    }));
    ok('G1a 载入迁移不调度云端推送（无 push 请求）', pushCount === 0);
    ok('G1b 迁移改写数据后清空 __hash（不再误判为本地有改动）', g1.hash === '');
    ok('G1c _pendingPush 保持 false（迁移不触发待推标记）', g1.pendingPush === false);
    ok('G1d 会计残留已被迁移清理', g1.chart === 0);

    /* ========== G2：登录首拉改为「采纳云端较新资料」而不是推本地旧数据 ========== */
    // 云端放入较新快照（rev 更大，带标记商品），旧设备登录后应拉下来套用而非把本地推上去
    const remote = JSON.parse(seeded);
    remote.items = (remote.items || []).concat([{ id: 'it_remote', code: 'REMOTE999', name: '云端标记商品', sales_unit: '个', purchase_unit: '个', stock_unit: '个', sales_to_stock: 1, purchase_to_stock: 1, cost: 1, price: 2, currency: 'CNY', created_at: '2026-09-07 00:00:00' }]);
    remote.__rev = Date.now();
    cloudSnapshot = await buildEncSnapshot(remote, remote.__rev);
    pushCount = 0;

    await page.evaluate(() => { const f = document.querySelector('#loginForm'); if (f) { document.querySelector('input[name="username"]').value = 'admin'; document.querySelector('input[name="password"]').value = 'admin123'; f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } });
    await page.waitForTimeout(5000); // 首拉在登录后 1.5 秒，留足时间完成对比与套用

    const g2 = await page.evaluate(() => ({
        hasRemoteItem: !!(DB.list('items') || []).find(i => i.code === 'REMOTE999'),
        chart: (DB._mem.chart_accounts || []).length
    }));
    ok('G2a 首拉采纳云端较新资料（拉到云端标记商品）', g2.hasRemoteItem === true);
    ok('G2b 全程未把本地旧数据推上云端', pushCount === 0);

    /* ========== G3：用户正常编辑后自动上传不受影响（防护不误伤） ========== */
    pushCount = 0;
    await page.evaluate(() => {
        DB.insert('items', { id: 'it_local', code: 'LOCAL888', name: '本地编辑标记商品', sales_unit: '个', purchase_unit: '个', stock_unit: '个', sales_to_stock: 1, purchase_to_stock: 1, cost: 1, price: 2, currency: 'CNY' });
        DB.flush();
    });
    await page.waitForTimeout(5000); // 防抖 3 秒后应推送（被拦截记数）
    ok('G3 用户编辑仍会自动上传（推送请求已发出）', pushCount >= 1);

    await browser.close();
    console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
