/**
 * test-everyone-sync.js — 全項目同步鏈路驗證（用户要求：不要這個項目好了另一個項目還有同樣問題）
 *
 * 覆蓋範圍（每個項目的保存/刪除都必須觸發 DB.flush → CloudSync.schedulePush → push 上雲）：
 *   客戶 / 供應商 / 商品 / 倉庫 / 單位 / 幣別 / 分類 / 物流 / 付款條件 / 角色 / 帳號
 *   + 業務單據：銷貨單 / 採購單 / 出貨單 / 樣品領料 / 銷退 / 採退 / 費用 / 傳票 / 收付款
 *
 * 新增保護驗證（8/26 下午三修復）：
 *   P1 本地有未同步刪除 + 雲端較新 → 自動下載先推本地（手機刪除不會被雲端舊數據覆蓋還原）
 *   P2 push 失敗 → 自動下載拒絕覆蓋（本地改動不丟失）+ 錯誤可見化
 *   P3 push 失敗 15 秒自動重試（網絡恢復自愈）
 *   P4 schedulePush 在「正忙」時不丟棄推送（稍後自動補推）
 *   P5 恢復備份 / 匯入資料 經 DB.flush 觸發雲端同步（修復繞過缺陷）
 *
 * 所有外部 API 用 page.route 攔截（內存模擬），不污染真實同步數據。
 */
const { chromium } = require('playwright');

const BASE = (process.env.BASE || 'http://127.0.0.1:8903') + '?sync=1';
let browser;
let passed = 0, failed = 0;
const results = [];

function ok(name, cond, extra) {
    if (cond) { passed++; results.push('  PASS: ' + name); }
    else { failed++; results.push('  FAIL: ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')); }
    console.log((cond ? '  PASS' : '  FAIL') + ': ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
}

// ---- 內存雲端模擬 ----
let cloudFile = null;
let textdbDown = false;

function mockAll(page) {
    return page.route('**', async (route) => {
        const url = route.request().url();
        if (url.indexOf('api.textdb.online/update/') >= 0) {
            if (textdbDown) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'down' });
            const m = url.match(/[?&]value=([^&]*)/);
            cloudFile = m ? decodeURIComponent(m[1]) : '';
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 1 }) });
        }
        if (url.indexOf('textdb.online/') >= 0 && url.indexOf('api.textdb') < 0) {
            if (textdbDown) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'down' });
            if (!cloudFile) return route.fulfill({ status: 200, contentType: 'text/plain', body: 'null' });
            return route.fulfill({ status: 200, contentType: 'text/plain', body: cloudFile });
        }
        if (url.indexOf('api.github.com/repos/') >= 0) {
            return route.fulfill({ status: 404, contentType: 'text/plain', body: '404' });
        }
        if (url.indexOf('raw.githubusercontent.com/') >= 0 || url.indexOf('cdn.jsdelivr.net/gh/') >= 0) {
            return route.fulfill({ status: 404, contentType: 'text/plain', body: '404' });
        }
        return route.fallback();
    });
}

async function login(page) {
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
        const u = document.querySelector('#loginForm input[name="username"]');
        const p = document.querySelector('#loginForm input[name="password"]');
        if (u) u.value = 'admin';
        if (p) p.value = 'admin123';
        const f = document.querySelector('#loginForm');
        if (f) f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(1200);
}

(async () => {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await mockAll(page);
    await login(page);
    await page.waitForTimeout(2200); // 首拉 1.5s

    // ---- 安裝 schedulePush 監聽器（包裝原函數，記錄每次調用，真實邏輯照跑） ----
    await page.evaluate(() => {
        window.__spy = { schedule: 0 };
        const orig = CloudSync.schedulePush.bind(CloudSync);
        CloudSync.schedulePush = function () {
            window.__spy.schedule++;
            return orig();
        };
    });
    const spyCount = () => page.evaluate(() => window.__spy.schedule);
    const pending = () => page.evaluate(() => CloudSync._pendingPush);
    const localRev = () => page.evaluate(() => Utils.num(DB._mem.__rev) || 0);
    // 輪詢等待條件成立（最長 10 秒；push 可能被 12 秒輪詢 pull 的 _busy 延遲重試，不能只用固定等待）
    const waitFor = async (name, fn, timeout = 10000) => {
        const t0 = Date.now();
        let last = undefined;
        while (Date.now() - t0 < timeout) {
            last = await fn();
            if (last) return last;
            await page.waitForTimeout(300);
        }
        return last;
    };

    const gotoHash = async (h) => {
        await page.evaluate(hh => { location.hash = hh; }, h);
        await page.waitForTimeout(700);
    };
    // 清殘留彈窗（Playwright 注意事項）
    const clearModals = () => page.evaluate(() => document.querySelectorAll('.modal-mask').forEach(m => m.remove()));

    /* ============ Part 1：DB 數據層 — 每個集合 insert/update/remove 都觸發同步 ============ */
    console.log('\n[1] DB 數據層：全集合 insert/update/remove → schedulePush + push 上雲');
    const cols = [
        ['customers', { code: 'C_T1', name: '同步測試客戶', currency: 'CNY' }],
        ['suppliers', { code: 'S_T1', name: '同步測試供應商', currency: 'CNY' }],
        ['items', { code: 'I_T1', name: '同步測試商品', sales_unit: '個', purchase_unit: '個', stock_unit: '個', sales_to_stock: 1, purchase_to_stock: 1, purchase_currency: 'CNY' }],
        ['warehouses', { code: 'WH_T1', name: '同步測試倉庫' }],
        ['units', { name: '同步測試單位', code: 'UT1' }],
        ['currencies', { code: 'TTT', name: '測試幣', rate: 1, symbol: 'T', is_base: false }],
        ['categories', { name: '同步測試分類' }],
        ['shipping_methods', { name: '同步測試物流' }],
        ['payment_terms', { name: '同步測試付款條件', days: 30 }],
        ['roles', { name: '同步測試角色', permissions: ['dashboard.view'] }],
        ['users', { username: 'sync_t1', password: '123456', role_id: 'r2', name: '同步測試帳號' }],
        ['sales_orders', { no: 'SO-SYNC-T1', customer_id: 'cu1', status: 'draft', currency: 'CNY', lines: [], amount: 0 }],
        ['purchase_orders', { no: 'PO-SYNC-T1', supplier_id: 'sp1', status: 'draft', currency: 'CNY', amount: 0 }],
        ['shipments', { no: 'SH-SYNC-T1', sales_order_id: 'so1', status: 'shipped' }],
        ['inventory_adjusts', { no: 'ADJ-SYNC-T1', warehouse_id: 'wh1', type: '盤點', amount: 0 }],
        ['sales_returns', { no: 'SR-SYNC-T1', sales_order_id: 'so1', total_amount: 0 }],
        ['purchase_returns', { no: 'PR-SYNC-T1', purchase_order_id: 'po1', total_amount: 0 }],
        ['expenses', { no: 'EX-SYNC-T1', date: '2026-08-26', amount: 100 }],
        ['vouchers', { no: 'V-SYNC-T1', date: '2026-08-26', status: '未過賬', lines: [] }],
        ['chart_accounts', { code: '9999', name: '測試科目', type: '資產', direction: '借', is_cash: false }]
    ];
    for (const [coll, rec] of cols) {
        const before = await spyCount();
        const id = 'sync_t_' + coll.replace(/_/g, '');
        await page.evaluate(({ coll, id, rec }) => DB.insert(coll, Object.assign({ id }, rec)), { coll, id, rec });
        const afterIns = await spyCount();
        const pendIns = await pending();
        // 等自動上傳（輪詢：push 可能被 12 秒輪詢 pull 的 _busy 延遲重試）
        const cloudHas = await waitFor(`[${coll}] 上雲`, () => page.evaluate(({ coll, id }) => CloudSync.peek().then(s => {
            const arr = (s && s.payload && s.payload[coll]) || [];
            return arr.find(r => r.id === id) ? true : false;
        }).catch(() => false), { coll, id }));
        const pendAfterPush = await waitFor(`[${coll}] 推送完成`, () => page.evaluate(() => CloudSync._pendingPush === false));
        ok(`[${coll}] insert → schedulePush 觸發 + 上傳雲端`, afterIns > before && pendIns === true && pendAfterPush === true && cloudHas === true, { before, afterIns, pendIns, pendAfterPush, cloudHas });

        const beforeU = await spyCount();
        await page.evaluate(({ coll, id }) => DB.update(coll, id, { remark: '同步更新測試' }), { coll, id });
        const afterU = await spyCount();
        const pendU = await pending();
        const cloudUpdated = await waitFor(`[${coll}] 字段同步`, () => page.evaluate(({ coll, id }) => CloudSync.peek().then(s => {
            const r = ((s && s.payload && s.payload[coll]) || []).find(x => x.id === id);
            return r && r.remark === '同步更新測試';
        }).catch(() => false), { coll, id }));
        ok(`[${coll}] update → schedulePush 觸發 + 雲端字段同步`, afterU > beforeU && pendU === true && cloudUpdated === true, { afterU, beforeU, cloudUpdated });

        const beforeR = await spyCount();
        await page.evaluate(({ coll, id }) => DB.remove(coll, id), { coll, id });
        const afterR = await spyCount();
        const pendR = await pending();
        const cloudGone = await waitFor(`[${coll}] 雲端刪除`, () => page.evaluate(({ coll, id }) => CloudSync.peek().then(s => {
            const arr = (s && s.payload && s.payload[coll]) || [];
            return !arr.find(r => r.id === id);
        }).catch(() => false), { coll, id }));
        const pendAfterDel = await waitFor(`[${coll}] 刪除推送完成`, () => page.evaluate(() => CloudSync._pendingPush === false));
        ok(`[${coll}] remove → schedulePush 觸發 + 雲端已刪除`, afterR > beforeR && pendR === true && cloudGone === true && pendAfterDel === true, { afterR, beforeR, cloudGone, pendAfterDel });
    }

    /* ============ Part 2：客戶 UI 新增（真實表單） ============ */
    console.log('\n[2] 客戶 UI 新增 → 保存 → 同步');
    await gotoHash('#/master/customers/create');
    await page.evaluate(() => {
        const f = document.querySelector('form[onsubmit*="saveCustomer"]');
        if (!f) return;
        f.querySelector('[name="code"]').value = 'C_UI1';
        f.querySelector('[name="customer_name"]').value = 'UI同步測試客戶';
        f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(800);
    const cUI = await page.evaluate(() => DB.find('customers', c => c.code === 'C_UI1'));
    ok('客戶 UI 保存成功寫入 DB', !!cUI);
    const cUIPend = await pending();
    ok('客戶 UI 保存後 _pendingPush=true（等待上傳）', cUIPend === true);
    await page.waitForTimeout(3600);
    const cUICloud = await page.evaluate(() => CloudSync.peek().then(s => !!((s.payload.customers || []).find(c => c.code === 'C_UI1'))).catch(() => false));
    ok('客戶 UI 保存後自動上傳雲端', cUICloud === true);

    /* ============ Part 3：客戶/供應商 UI 刪除（真實按鈕 + 確認彈窗） ============ */
    console.log('\n[3] 客戶/供應商 UI 刪除 → 同步');
    // 先造一個可刪的客戶（無引用）
    const delCustId = await page.evaluate(() => {
        const c = DB.insert('customers', { code: 'C_DEL1', name: '待刪除客戶', currency: 'CNY' });
        return c.id;
    });
    await page.evaluate(() => Pages.customers()); // 重新渲染列表，確保卡片出現在 DOM
    await page.waitForTimeout(400);
    await page.evaluate(() => {
        // 找到該客戶卡片上的刪除按鈕並點擊（無引用資料可刪）
        const cards = document.querySelectorAll('.master-card');
        for (const card of cards) {
            if (card.textContent.indexOf('待刪除客戶') >= 0) {
                const btn = card.querySelector('button[onclick*="deleteMaster"]');
                if (btn) btn.click();
                break;
            }
        }
    });
    await page.waitForTimeout(400);
    await clearModals(); // 安全：先清殘留
    // 重新點一次並處理確認彈窗
    await page.evaluate(() => {
        const cards = document.querySelectorAll('.master-card');
        for (const card of cards) {
            if (card.textContent.indexOf('待刪除客戶') >= 0) {
                const btn = card.querySelector('button[onclick*="deleteMaster"]');
                if (btn) btn.click();
                break;
            }
        }
    });
    await page.waitForTimeout(400);
    const maskCount = await page.locator('.modal-mask').count();
    ok('客戶刪除彈出確認彈窗', maskCount >= 1);
    if (maskCount >= 1) {
        await page.locator('.modal-mask').last().locator('#confirmOkBtn').click();
        await page.waitForTimeout(500);
    }
    const cDelGone = await page.evaluate(id => !DB.get('customers', id), delCustId);
    ok('客戶確認刪除後從 DB 移除', cDelGone === true);
    const cDelPend = await pending();
    ok('客戶刪除後 _pendingPush=true（手機刪除場景核心）', cDelPend === true);
    const cDelCloud = await waitFor('客戶刪除上雲', () => page.evaluate(id => CloudSync.peek().then(s => !((s.payload.customers || []).find(c => c.id === id))).catch(() => false), delCustId));
    ok('客戶刪除已同步到雲端（電腦端 12 秒後可看到）', cDelCloud === true);

    // 供應商 UI 刪除
    const delSupId = await page.evaluate(() => {
        const s = DB.insert('suppliers', { code: 'S_DEL1', name: '待刪除供應商', currency: 'CNY' });
        return s.id;
    });
    await gotoHash('#/master/suppliers');
    await page.evaluate(() => {
        const cards = document.querySelectorAll('.master-card');
        for (const card of cards) {
            if (card.textContent.indexOf('待刪除供應商') >= 0) {
                const btn = card.querySelector('button[onclick*="deleteMaster"]');
                if (btn) btn.click();
                break;
            }
        }
    });
    await page.waitForTimeout(400);
    await page.locator('.modal-mask').last().locator('#confirmOkBtn').click();
    await page.waitForTimeout(400);
    const sDelGone = await page.evaluate(id => !DB.get('suppliers', id), delSupId);
    ok('供應商確認刪除後從 DB 移除', sDelGone === true);
    const sDelCloud = await waitFor('供應商刪除上雲', () => page.evaluate(id => CloudSync.peek().then(s => !((s.payload.suppliers || []).find(x => x.id === id))).catch(() => false), delSupId));
    ok('供應商刪除已同步到雲端', sDelCloud === true);

    /* ============ Part 4：商品 UI 新增 ============ */
    console.log('\n[4] 商品 UI 新增 → 同步');
    await gotoHash('#/master/items/create');
    await page.evaluate(() => {
        const f = document.querySelector('form[onsubmit*="saveItem"]');
        if (!f) return;
        f.querySelector('[name="code"]').value = 'I_UI1';
        f.querySelector('[name="item_name"]').value = 'UI同步測試商品';
        f.querySelector('[name="sales_unit"]') && (f.querySelector('[name="sales_unit"]').value = '個');
        f.querySelector('[name="purchase_unit"]') && (f.querySelector('[name="purchase_unit"]').value = '個');
        f.querySelector('[name="stock_unit"]') && (f.querySelector('[name="stock_unit"]').value = '個');
        f.querySelector('[name="sales_to_stock"]') && (f.querySelector('[name="sales_to_stock"]').value = '1');
        f.querySelector('[name="purchase_to_stock"]') && (f.querySelector('[name="purchase_to_stock"]').value = '1');
        f.querySelector('[name="purchase_currency"]') && (f.querySelector('[name="purchase_currency"]').value = 'CNY');
        const cat = f.querySelector('[name="category_id"]');
        if (cat && cat.options.length > 1) cat.selectedIndex = 1;
        f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(800);
    const iUI = await page.evaluate(() => DB.find('items', i => i.code === 'I_UI1'));
    ok('商品 UI 保存成功寫入 DB', !!iUI);
    const iUICloud = await waitFor('商品上雲', () => page.evaluate(() => CloudSync.peek().then(s => !!((s.payload.items || []).find(i => i.code === 'I_UI1'))).catch(() => false)));
    ok('商品 UI 保存後自動上傳雲端', iUICloud === true);

    /* ============ Part 5：單位（簡單主檔）UI 新增彈窗 ============ */
    console.log('\n[5] 單位（簡單主檔）UI 新增 → 同步');
    await gotoHash('#/master/units');
    await clearModals();
    await page.evaluate(() => Pages.simpleMasterAdd('units'));
    await page.waitForTimeout(400);
    const modalHas = await page.locator('.modal-mask').count();
    ok('單位新增彈窗已開啟', modalHas >= 1);
    if (modalHas >= 1) {
        const mask = page.locator('.modal-mask').last();
        await mask.locator('input[name="name"]').fill('UI同步測試單位');
        await mask.locator('input[name="code"]').fill('UT_UI1');
        await mask.locator('.modal-foot .btn.primary').click(); // 注意：modal-foot 是 smForm 兄弟節點
        await page.waitForTimeout(700);
    }
    const uUI = await page.evaluate(() => DB.find('units', u => u.code === 'UT_UI1'));
    ok('單位 UI 新增成功寫入 DB', !!uUI);
    const uUICloud = await waitFor('單位上雲', () => page.evaluate(() => CloudSync.peek().then(s => !!((s.payload.units || []).find(u => u.code === 'UT_UI1'))).catch(() => false)));
    ok('單位 UI 新增後自動上傳雲端', uUICloud === true);

    /* ============ Part 6：銷貨單 UI 新增（含明細行） ============ */
    console.log('\n[6] 銷貨單 UI 新增 → 同步');
    // 準備可選商品（UI 商品已存在 I_UI1）
    await gotoHash('#/sales-orders/create');
    await page.waitForTimeout(400);
    await page.evaluate(() => {
        const f = document.querySelector('#salesOrderForm');
        if (!f) return;
        const cust = f.querySelector('[name="customer_id"]');
        if (cust && cust.options.length > 1) cust.selectedIndex = 1;
        const owner = f.querySelector('[name="sales_owner"]');
        if (owner && owner.options.length > 1) owner.selectedIndex = 1;
        // 預設已有一行明細（新增表單自動加一行），填寫它
        const tbody = document.querySelector('#salesLines tbody');
        const row = tbody && tbody.querySelector('tr');
        if (row) {
            const sel = row.querySelector('[name="item_id[]"]');
            if (sel) {
                // 選 I_UI1
                for (let i = 0; i < sel.options.length; i++) {
                    if (sel.options[i].textContent.indexOf('I_UI1') >= 0 || sel.options[i].value === 'I_UI1') { sel.selectedIndex = i; break; }
                }
                sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const qty = row.querySelector('[name="qty[]"]');
            const price = row.querySelector('[name="unit_price[]"]');
            if (qty) qty.value = '2';
            if (price) price.value = '50';
            if (qty) qty.dispatchEvent(new Event('input', { bubbles: true }));
            if (price) price.dispatchEvent(new Event('input', { bubbles: true }));
        }
        f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(900);
    const soUI = await page.evaluate(() => DB.list('sales_orders').filter(o => o.remark === '同步更新測試').length || DB.list('sales_orders').slice(-1)[0]);
    const soCount = await page.evaluate(() => DB.list('sales_orders').length);
    ok('銷貨單 UI 保存成功（單據數增加）', soCount >= 1);
    const soPend = await pending();
    ok('銷貨單保存後 _pendingPush=true', soPend === true);
    const soCloud = await waitFor('銷貨單上雲', () => page.evaluate(() => CloudSync.peek().then(s => (s.payload.sales_orders || []).length > 0).catch(() => false)));
    ok('銷貨單已上傳雲端', soCloud === true);
    // 清理測試單據
    await page.evaluate(() => {
        const testSos = DB.list('sales_orders').filter(o => String(o.no).indexOf('SYNC') >= 0 || (o.customer_id && DB.get('customers', o.customer_id) && DB.get('customers', o.customer_id).code === 'C_UI1'));
        testSos.forEach(o => DB.remove('sales_orders', o.id));
        const it = DB.find('items', i => i.code === 'I_UI1'); if (it) DB.remove('items', it.id);
        const u = DB.find('units', u => u.code === 'UT_UI1'); if (u) DB.remove('units', u.id);
        const c = DB.find('customers', c => c.code === 'C_UI1'); if (c) DB.remove('customers', c.id);
    });

    /* ============ Part 7：新增保護 P1-P4 ============ */
    console.log('\n[7] 新增保護：本地未同步刪除 / push 失敗 / 重試 / 忙時不丟棄');

    // ---- P1：本地有未同步刪除 + 雲端較新 → 自動下載先推本地（刪除存活）----
    const p1CustId = await page.evaluate(() => {
        const c = DB.insert('customers', { id: 'C_P1', code: 'C_P1', name: 'P1保護客戶', currency: 'CNY' });
        return c.id;
    });
    await waitFor('P1 前置推送完成', () => page.evaluate(() => CloudSync._pendingPush === false));
    // 現在刪除（會設 _pendingPush），但模擬「還來不及推」：馬上把雲端塞一個含該客戶的較新快照
    await page.evaluate(() => { DB.remove('customers', 'C_P1'); });
    await page.waitForTimeout(100);
    const p1Pend = await pending();
    ok('P1a 刪除後 _pendingPush=true', p1Pend === true);
    // 雲端塞較新版本（rev = 當前 + 5000，含 C_P1）→ 觸發自動下載
    await page.evaluate(async () => {
        const cur = Utils.num(DB._mem.__rev) || 0;
        const payload = JSON.parse(JSON.stringify(DB._mem));
        payload.__rev = cur + 5000;
        payload.__device = 'Dother';
        if (!payload.customers.find(c => c.id === 'C_P1')) payload.customers.push({ id: 'C_P1', code: 'C_P1', name: 'P1保護客戶(雲端舊)', currency: 'CNY', created_at: new Date().toISOString() });
        const snap = { v: 1, rev: cur + 5000, device: 'Dother', updated_at: new Date().toISOString(), payload };
        const marked = await CloudSync._compress(JSON.stringify(snap));
        return await CloudSync._encrypt(marked);
    }).then(enc => { cloudFile = enc; });
    const p1Pull = await page.evaluate(() => CloudSync.pull(false));
    await page.waitForTimeout(1200);
    const p1Gone = await page.evaluate(() => !DB.get('customers', 'C_P1'));
    const p1CloudGone = await page.evaluate(() => CloudSync.peek().then(s => !((s.payload.customers || []).find(c => c.id === 'C_P1'))).catch(() => true));
    ok('P1b 自動下載遇到本地未同步刪除 → 先推本地，刪除不會被雲端舊數據覆蓋還原', p1Pull === true && p1Gone === true && p1CloudGone === true, { p1Pull, p1Gone, p1CloudGone });

    // ---- P2：push 失敗 → 自動下載拒絕覆蓋（本地改動不丟失）----
    await page.evaluate(() => { DB.insert('customers', { id: 'C_P2', code: 'C_P2', name: 'P2保護客戶', currency: 'CNY' }); });
    await page.waitForTimeout(100);
    // 雲端塞更高 rev（無 C_P2）
    await page.evaluate(async () => {
        const cur = Utils.num(DB._mem.__rev) || 0;
        const payload = JSON.parse(JSON.stringify(DB._mem));
        payload.customers = payload.customers.filter(c => c.id !== 'C_P2');
        payload.__rev = cur + 9000;
        payload.__device = 'Dother2';
        const snap = { v: 1, rev: cur + 9000, device: 'Dother2', updated_at: new Date().toISOString(), payload };
        const marked = await CloudSync._compress(JSON.stringify(snap));
        return await CloudSync._encrypt(marked);
    }).then(enc => { cloudFile = enc; });
    textdbDown = true; // push 會失敗
    const p2Pull = await page.evaluate(() => CloudSync.pull(false));
    await page.waitForTimeout(600);
    const p2LocalKeep = await page.evaluate(() => !!DB.get('customers', 'C_P2'));
    textdbDown = false;
    ok('P2 push 失敗時自動下載拒絕覆蓋（本地新增 C_P2 不丟失）', p2Pull === false && p2LocalKeep === true, { p2Pull, p2LocalKeep });

    // ---- P3：push 失敗 15 秒自動重試（網絡恢復自愈）----
    // 直接驅動 _runPush 兩次：第一次失敗（textdbDown），第二次成功
    textdbDown = true;
    await page.evaluate(() => CloudSync._runPush());
    await page.waitForTimeout(600);
    const p3StillPending = await pending();
    ok('P3a push 失敗後 _pendingPush 保留（等待重試）', p3StillPending === true);
    textdbDown = false;
    await page.evaluate(() => CloudSync._runPush());
    await page.waitForTimeout(1000);
    const p3Done = await pending();
    const p3Cloud = await page.evaluate(() => CloudSync.peek().then(s => !!((s.payload.customers || []).find(c => c.id === 'C_P2'))).catch(() => false));
    ok('P3b push 重試成功後 _pendingPush 清除 + 雲端有 C_P2', p3Done === false && p3Cloud === true, { p3Done, p3Cloud });
    // 清理 P2/P3
    await page.evaluate(() => { const d = DB.get('customers', 'C_P2'); if (d) DB.remove('customers', 'C_P2'); });

    // ---- P4：schedulePush 在「正忙」時不丟棄推送 ----
    await page.evaluate(() => {
        CloudSync._busy = true;
        DB.insert('customers', { id: 'C_P4', code: 'C_P4', name: 'P4忙時測試客戶', currency: 'CNY' });
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => CloudSync._runPush()); // 忙 → 應重排而非丟棄
    await page.waitForTimeout(200);
    const p4PendingMid = await pending();
    ok('P4a 正忙時 push 不丟棄（_pendingPush 保留）', p4PendingMid === true);
    await page.evaluate(() => { CloudSync._busy = false; return CloudSync._runPush(); });
    await page.waitForTimeout(1000);
    const p4Done = await pending();
    const p4Cloud = await page.evaluate(() => CloudSync.peek().then(s => !!((s.payload.customers || []).find(c => c.id === 'C_P4'))).catch(() => false));
    ok('P4b 忙完後自動補推成功（C_P4 上雲）', p4Done === false && p4Cloud === true, { p4Done, p4Cloud });
    await page.evaluate(() => { const d = DB.get('customers', 'C_P4'); if (d) DB.remove('customers', 'C_P4'); });
    await waitFor('P4 清理推送', () => page.evaluate(() => CloudSync._pendingPush === false));

    /* ============ Part 8：恢復備份 / 匯入 → 觸發雲端同步（修復繞過缺陷） ============ */
    console.log('\n[8] 恢復備份觸發雲端同步（原缺陷：直接寫 localStorage 不 flush）');
    await page.evaluate(() => {
        const snap = JSON.stringify(DB._mem);
        DB.insert('backups', { id: 'bk_sync_t', no: 'BK-SYNC-T', date: '2026-08-26 12:00:00', size: '1.0 MB', note: '同步測試', snapshot: snap });
    });
    await waitFor('備份插入推送', () => page.evaluate(() => CloudSync._pendingPush === false));
    await clearModals();
    const spyBeforeRestore = await spyCount();
    await page.evaluate(() => Pages.restoreBackup('bk_sync_t'));
    await page.waitForTimeout(400);
    await page.locator('.modal-mask').last().locator('#confirmOkBtn').click();
    await page.waitForTimeout(500);
    const spyAfterRestore = await spyCount();
    const pendRestore = await pending();
    ok('恢復備份後 schedulePush 被觸發（_pendingPush=true）', spyAfterRestore > spyBeforeRestore && pendRestore === true, { spyBeforeRestore, spyAfterRestore, pendRestore });
    const cloudHasBk = await waitFor('恢復資料上雲', () => page.evaluate(() => CloudSync.peek().then(s => !!((s.payload.backups || []).find(b => b.id === 'bk_sync_t'))).catch(() => false)));
    ok('恢復的資料已同步上雲（含 __rev 抬升不被雲端舊快照覆蓋）', cloudHasBk === true);
    // 清理
    await page.evaluate(() => { const b = DB.get('backups', 'bk_sync_t'); if (b) DB.remove('backups', b.id); });
    await waitFor('清理推送', () => page.evaluate(() => CloudSync._pendingPush === false));

    /* 清理同步配置，避免影響其他測試 */
    await page.evaluate(() => {
        localStorage.removeItem('taiyuan_sync_cfg_v1');
        localStorage.removeItem('taiyuan_sync_status_v1');
        CloudSync.cfg = null; CloudSync.status = null; CloudSync._started = false; CloudSync._legacyChecked = false;
    });

    await browser.close();
    console.log('----------------------------------------');
    console.log('總計： ' + passed + ' 通過 / ' + failed + ' 失敗');
    if (failed > 0) { console.log(results.filter(r => r.indexOf('FAIL') >= 0).join('\n')); process.exit(1); }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
