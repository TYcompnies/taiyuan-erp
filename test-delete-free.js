/**
 * test-delete-free.js — 免环扣删除专项测试（2026-09-03）
 * 需求：删除按钮不受任何引用/状态环扣限制，点删除即删：
 *   采购单（含已进货，删除自动回冲加量库存）、进销存应付账款（操作列新增删除按钮）、
 *   商品主档、供应商主档、仓库主档（后两者顺带清理各自库存记录）。
 *   币别/客户/分类等其余主档仍保留引用检查（不在用户清单内）。
 * 运行：BASE=<云端或本地 URL> node test-delete-free.js
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
async function confirmOk(page) {
    await page.locator('.modal-mask').last().locator('#confirmOkBtn').click();
    await page.waitForTimeout(400);
}
// 点击列表行/卡片上的删除按钮（按文本定位所在行）
async function clickRowDelete(page, rowSel, rowText) {
    await page.locator(`${rowSel}:has-text("${rowText}")`).first().locator('button:has-text("删除")').first().click();
    await page.waitForTimeout(400);
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"] });
    const page = await browser.newPage();
    try {
        await login(page);

        /* ---------- 1. 草稿采购单：点删除即删 ---------- */
        await test('T1 草稿采购单免环扣删除', async () => {
            await page.evaluate(() => {
                DB.insert('items', { id: 'dfi1', code: 'DF-1', name: '免环扣商品1', unit: '个', purchase_to_stock: 2, cost: 10, purchase_currency: 'CNY' });
                DB.insert('purchase_orders', { id: 'po_df1', no: 'PO_DF_001', status: 'draft', warehouse_id: 'wh1', supplier_id: 'sup_df0', currency: 'CNY', amount: 100, po_date: '2026-09-01', lines: [{ item_id: 'dfi1', qty: 10, amount: 100 }] });
            });
            await page.evaluate(() => { location.hash = '#/purchase-orders'; });
            await page.waitForTimeout(600);
            await clickRowDelete(page, 'tr', 'PO_DF_001');
            await confirmOk(page);
            const gone = await page.evaluate(() => !DB.get('purchase_orders', 'po_df1'));
            if (!gone) throw new Error('草稿采购单未被删除');
        });

        /* ---------- 2. 已进货采购单：可删 + 库存回冲 ---------- */
        await test('T2 已进货采购单免环扣删除（库存回冲）', async () => {
            await page.evaluate(() => {
                DB.insert('purchase_orders', { id: 'po_df2', no: 'PO_DF_002', status: 'draft', warehouse_id: 'wh1', supplier_id: 'sup_df0', currency: 'CNY', amount: 100, po_date: '2026-09-01', lines: [{ item_id: 'dfi1', qty: 10, amount: 100 }] });
            });
            // 进货入库（+20：qty10 × purchase_to_stock2）
            await page.evaluate(() => Pages.receivePO('po_df2'));
            await confirmOk(page);
            const st1 = await page.evaluate(() => DB.stockOf('wh1', 'dfi1'));
            if (st1 !== 20) throw new Error('进货后库存=' + st1 + '（期望 20）');
            // 直接删除已进货采购单 → 不再被拒，且回冲库存
            await page.evaluate(() => { location.hash = '#/purchase-orders'; });
            await page.waitForTimeout(600);
            await clickRowDelete(page, 'tr', 'PO_DF_002');
            await confirmOk(page);
            const v = await page.evaluate(() => ({ gone: !DB.get('purchase_orders', 'po_df2'), stock: DB.stockOf('wh1', 'dfi1') }));
            if (!v.gone) throw new Error('已进货采购单未被删除（仍受状态限制）');
            if (v.stock !== 0) throw new Error('删除已进货采购单后库存未回冲=' + v.stock + '（期望 0）');
        });

        /* ---------- 3. 应付账款页：操作列有删除按钮且免环扣 ---------- */
        await test('T3 进销存应付账款页删除按钮免环扣删除', async () => {
            await page.evaluate(() => {
                DB.insert('suppliers', { id: 'sup_df0', code: 'SUP_DF', name: '免环扣供应商', currency: 'CNY' });
                DB.insert('purchase_orders', { id: 'po_df3', no: 'PO_DF_003', status: 'draft', warehouse_id: 'wh1', supplier_id: 'sup_df0', currency: 'CNY', amount: 300, paid_amount: 0, po_date: '2026-09-01', lines: [{ item_id: 'dfi1', qty: 10, amount: 300 }] });
            });
            // 真实进货入库（+20），使该单进入应付账款列表
            await page.evaluate(() => Pages.receivePO('po_df3'));
            await confirmOk(page);
            await page.evaluate(() => { location.hash = '#/accounting/accounts-payable'; });
            await page.waitForTimeout(600);
            const hasBtn = await page.locator('tr:has-text("PO_DF_003")').first().locator('button:has-text("删除")').count();
            if (!hasBtn) throw new Error('应付账款页操作列无删除按钮');
            await clickRowDelete(page, 'tr', 'PO_DF_003');
            await confirmOk(page);
            const v = await page.evaluate(() => ({ gone: !DB.get('purchase_orders', 'po_df3'), stock: DB.stockOf('wh1', 'dfi1') }));
            if (!v.gone) throw new Error('应付账款页删除未生效');
            if (v.stock !== 0) throw new Error('应付删除后库存应回冲至 0，实际 ' + v.stock);
        });

        /* ---------- 4. 商品主档：被订单引用+有库存也可删 ---------- */
        await test('T4 商品主档免环扣删除（被引用+有库存）', async () => {
            await page.evaluate(() => {
                DB.addStock('wh1', 'dfi1', 7);
                DB.insert('sales_orders', { id: 'so_df1', no: 'SO_DF_001', customer_id: 'cus_df0', status: 'draft', currency: 'CNY', amount: 1, order_date: '2026-09-01', lines: [{ item_id: 'dfi1', qty: 1, amount: 1 }] });
            });
            await page.evaluate(() => { location.hash = '#/master/items'; });
            await page.waitForTimeout(600);
            await clickRowDelete(page, 'tr', 'DF-1');
            await confirmOk(page);
            const v = await page.evaluate(() => ({
                gone: !DB.get('items', 'dfi1'),
                stockLeft: Object.keys(DB.stockMap().wh1 || {}).includes('dfi1')
            }));
            if (!v.gone) throw new Error('被引用商品未被删除（仍受引用限制）');
            if (v.stockLeft) throw new Error('商品删除后库存记录未清理');
        });

        /* ---------- 5. 供应商主档：被采购单引用也可删 ---------- */
        await test('T5 供应商主档免环扣删除（被采购单引用）', async () => {
            await page.evaluate(() => {
                DB.insert('purchase_orders', { id: 'po_df4', no: 'PO_DF_004', status: 'draft', warehouse_id: 'wh1', supplier_id: 'sup_df0', currency: 'CNY', amount: 1, po_date: '2026-09-01', lines: [{ item_id: 'dfi1', qty: 1, amount: 1 }] });
            });
            await page.evaluate(() => { location.hash = '#/master/suppliers'; });
            await page.waitForTimeout(600);
            await clickRowDelete(page, '.master-card', '免环扣供应商');
            await confirmOk(page);
            const gone = await page.evaluate(() => !DB.get('suppliers', 'sup_df0'));
            if (!gone) throw new Error('被引用供应商未被删除（仍受引用限制）');
        });

        /* ---------- 6. 仓库主档：有库存也可删 + 库存记录清理 ---------- */
        await test('T6 仓库主档免环扣删除（有库存）', async () => {
            await page.evaluate(() => {
                DB.insert('warehouses', { id: 'wh_df1', code: 'WHDF', name: '免环扣仓库', created_at: Utils.now(), updated_at: Utils.now() });
                DB.insert('items', { id: 'dfi2', code: 'DF-2', name: '免环扣商品2', unit: '个', purchase_to_stock: 1, cost: 1, purchase_currency: 'CNY' });
                DB.addStock('wh_df1', 'dfi2', 9);
            });
            await page.evaluate(() => { location.hash = '#/master/warehouses'; });
            await page.waitForTimeout(600);
            await clickRowDelete(page, 'tr', 'WHDF');
            await confirmOk(page);
            const v = await page.evaluate(() => ({
                gone: !DB.get('warehouses', 'wh_df1'),
                stockGone: !DB.stockMap()['wh_df1']
            }));
            if (!v.gone) throw new Error('有库存仓库未被删除（仍受库存限制）');
            if (!v.stockGone) throw new Error('仓库删除后库存记录未清理');
        });

        /* ---------- 7. 回归：未在清单内的主档仍保留引用检查 ---------- */
        await test('T7 客户主档仍保留引用检查（未在免限清单）', async () => {
            await page.evaluate(() => {
                DB.insert('customers', { id: 'cus_df0', code: 'CUS_DF', name: '免环扣客户', currency: 'CNY' });
            });
            await page.evaluate(() => { location.hash = '#/master/customers'; });
            await page.waitForTimeout(600);
            // 点击删除（无确认弹窗，应直接 toast 拒绝——因被 SO_DF_001 引用）
            await clickRowDelete(page, '.master-card', '免环扣客户');
            const v = await page.evaluate(() => ({
                still: !!DB.get('customers', 'cus_df0'),
                mask: document.querySelectorAll('.modal-mask').length
            }));
            await page.evaluate(() => document.querySelectorAll('.modal-mask').forEach(m => m.remove()));
            if (!v.still) throw new Error('被引用客户被删除了（客户不在免限清单，应保留检查）');
            if (v.mask > 0) throw new Error('被引用客户删除不应弹确认框（应直接拒绝）');
        });

        results.forEach(r => console.log(r));
        console.log(`\n==== test-delete-free 完成：通过 ${pass} / 失败 ${fail} ====`);
    } catch (e) {
        console.error('FATAL:', e);
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
    if (fail > 0) process.exitCode = 1;
})();
