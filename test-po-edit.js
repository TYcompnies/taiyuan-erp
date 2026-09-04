/**
 * test-po-edit.js — 已进货采购单可再编辑 + 自动同步专项测试（2026-09-03）
 * 需求：采购单（含已进货）保存后仍可进入编辑再保存，系统自动更新同步资料：
 *   - 库存按新旧明细差异自动增减（跨仓库迁移、新增明细行均正确）
 *   - 应付金额/付款状态自动重算，已付金额（paid_amount）保留不归零
 *   - 守卫：已退回商品数量不得减到累计退回量以下；金额不得低于已冲减应付合计；
 *           已发生库存退回的单不可变更入库仓库
 * 运行：BASE=<云端或本地 URL> node test-po-edit.js
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
// 基础资料：供应商 + 两商品（A: purchase_to_stock=1；B: purchase_to_stock=2）
async function seedMasters(page) {
    await page.evaluate(() => {
        DB.insert('suppliers', { id: 'sup_pe', code: 'SUP-PE', name: 'PO编辑供应商', currency: 'CNY', payment_method: '现款现货' });
        DB.insert('items', { id: 'pei1', code: 'PE-1', name: 'PO编辑商品A', unit: '个', sales_unit: '个', purchase_unit: '箱', purchase_to_stock: 1, cost: 10, price: 20, purchase_currency: 'CNY' });
        DB.insert('items', { id: 'pei2', code: 'PE-2', name: 'PO编辑商品B', unit: '个', sales_unit: '个', purchase_unit: '件', purchase_to_stock: 2, cost: 5, price: 8, purchase_currency: 'CNY' });
    });
}
// 走真实 UI：进入新增采购单表单 → 选供应商/商品 → 填数量单价 → 保存
async function createPO(page, itemId, qty, price) {
    await page.evaluate(() => { location.hash = '#/purchase-orders/create'; });
    await page.waitForSelector('#poForm', { timeout: 10000 });
    await page.waitForTimeout(200);
    await page.selectOption('select[name="supplier_id"]', 'sup_pe');
    await page.selectOption('#poLines tbody tr:first-child select[name="item_id[]"]', itemId);
    await page.fill('#poLines tbody tr:first-child input[name="qty[]"]', String(qty));
    await page.fill('#poLines tbody tr:first-child input[name="unit_price[]"]', String(price));
    await page.evaluate(() => document.querySelector('#poForm').requestSubmit());
    await page.waitForTimeout(800);
    return page.evaluate(() => DB.list('purchase_orders').sort((a, b) => b.no.localeCompare(a.no))[0]);
}
// 进入编辑页并保存（保存后 300ms 跳列表）
async function editSavePO(page, poId, mutator) {
    await page.evaluate((id) => { location.hash = '#/purchase-orders/' + id + '/edit'; }, poId);
    await page.waitForSelector('#poForm', { timeout: 10000 });
    await page.waitForTimeout(200);
    if (mutator) await mutator(page);
    await page.evaluate(() => document.querySelector('#poForm').requestSubmit());
    await page.waitForTimeout(800);
}
const poState = (page, id) => page.evaluate((oid) => {
    const o = DB.get('purchase_orders', oid);
    return {
        amount: o.amount, paid: Utils.num(o.paid_amount), status: o.status,
        payment_status: o.payment_status || '', lineCount: (o.lines || []).length,
        aStock: DB.stockOf('wh1', 'pei1'), aStock2: DB.stockOf('wh2', 'pei1'),
        bStock: DB.stockOf('wh1', 'pei2')
    };
}, id);

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"] });
    const page = await browser.newPage();
    try {
        await login(page);
        await seedMasters(page);

        /* ---------- T1 新增采购单（UI）→ 进货入库 ---------- */
        let poId = '';
        await test('T1 新增采购单并进货入库（库存+100/应付1000）', async () => {
            const po = await createPO(page, 'pei1', 100, 10);
            poId = po.id;
            if (po.amount !== 1000) throw new Error('单额=' + po.amount);
            await page.evaluate((id) => Pages.receivePO(id), poId);
            await confirmOk(page);
            const st = await poState(page, poId);
            if (st.aStock !== 100) throw new Error('进货后库存=' + st.aStock + '（期望100）');
            if (st.status !== 'received') throw new Error('状态未置 received');
        });

        /* ---------- T2 已进货单编辑画面放开 ---------- */
        await test('T2 已进货单编辑画面已放开（新增明细/保存按钮/流程卡）', async () => {
            await page.evaluate((id) => { location.hash = '#/purchase-orders/' + id + '/edit'; }, poId);
            await page.waitForSelector('#poForm', { timeout: 10000 });
            await page.waitForTimeout(200);
            const ui = await page.evaluate(() => ({
                addBtn: !!Array.from(document.querySelectorAll('#poForm button')).find(b => b.textContent.includes('+ 新增明细')),
                saveText: (document.querySelector('#poForm button[type="submit"]') || {}).textContent || '',
                flow: document.body.textContent.includes('已进货，仍可编辑明细，保存后自动同步库存与应付')
            }));
            if (!ui.addBtn) throw new Error('已进货单缺少「+ 新增明细」按钮');
            if (!ui.saveText.includes('保存并同步库存/应付')) throw new Error('保存按钮文案=' + ui.saveText);
            if (!ui.flow) throw new Error('缺少已进货同步说明流程卡');
        });

        /* ---------- T3 已进货单编辑数量 100→120：库存与应付自动同步 ---------- */
        await test('T3 编辑数量100→120保存：库存+20、应付1200、状态unpaid', async () => {
            await editSavePO(page, poId, async p => {
                await p.fill('#poLines tbody tr:first-child input[name="qty[]"]', '120');
            });
            const st = await poState(page, poId);
            if (st.amount !== 1200) throw new Error('金额=' + st.amount + '（期望1200）');
            if (st.aStock !== 120) throw new Error('库存=' + st.aStock + '（期望120）');
            if (st.payment_status !== 'unpaid') throw new Error('付款状态=' + st.payment_status + '（期望unpaid）');
            if (st.status !== 'received') throw new Error('状态被改回=' + st.status);
        });

        /* ---------- T4 已付款500后再编辑金额下调：已付保留不归零 ---------- */
        await test('T4 已付500后编辑金额→1000：paid保留500、库存-20、状态partial', async () => {
            await page.evaluate((id) => {
                DB.update('purchase_orders', id, { paid_amount: 500, payment_status: 'partial' });
            }, poId);
            await editSavePO(page, poId, async p => {
                await p.fill('#poLines tbody tr:first-child input[name="qty[]"]', '100');
            });
            const st = await poState(page, poId);
            if (st.paid !== 500) throw new Error('已付金额被归零=' + st.paid + '（期望保留500）');
            if (st.amount !== 1000) throw new Error('金额=' + st.amount);
            if (st.aStock !== 100) throw new Error('库存=' + st.aStock + '（期望100）');
            if (st.payment_status !== 'partial') throw new Error('付款状态=' + st.payment_status + '（期望partial）');
        });

        /* ---------- T5 数量守卫：发生退回30后编辑减到20被拒 ---------- */
        await test('T5 数量守卫：退回30后编辑 qty20 被拒绝且资料不变', async () => {
            // 注入采购退回（退回30 冲减应付300），并同步真实扣库存 -30
            await page.evaluate((id) => {
                const o = DB.get('purchase_orders', id);
                DB.insert('purchase_returns', {
                    id: 'pr_pe1', no: 'PR_PE_001', purchase_order_id: id, order_no: o.no,
                    supplier_id: 'sup_pe', type: '退回', return_date: '2026-09-03',
                    warehouse_id: 'wh1', offset_payable: true, amount: 300,
                    lines: [{ item_id: 'pei1', code: 'PE-1', name: 'PO编辑商品A', qty: 30, unit_price: 10, amount: 300 }]
                });
                DB.addStock('wh1', 'pei1', -30);
            }, poId);
            await editSavePO(page, poId, async p => {
                await p.fill('#poLines tbody tr:first-child input[name="qty[]"]', '20');
            });
            const st = await poState(page, poId);
            const hash = await page.evaluate(() => location.hash);
            if (!hash.includes('/edit')) throw new Error('被拒后不应跳列表：hash=' + hash);
            if (st.amount !== 1000) throw new Error('守卫失效：金额被改=' + st.amount);
            if (st.aStock !== 70) throw new Error('守卫失效：库存被改=' + st.aStock + '（期望70）');
        });

        /* ---------- T6 守卫通过场景：qty→80 保存（新量≥退回量）自动同步 ---------- */
        await test('T6 编辑 qty→80 保存：库存50(80-退30)、应付800、冲减后状态paid、paid保留500', async () => {
            await editSavePO(page, poId, async p => {
                await p.fill('#poLines tbody tr:first-child input[name="qty[]"]', '80');
            });
            const st = await poState(page, poId);
            if (st.amount !== 800) throw new Error('金额=' + st.amount + '（期望800）');
            if (st.aStock !== 50) throw new Error('库存=' + st.aStock + '（期望50 = 80-退回30）');
            if (st.paid !== 500) throw new Error('已付被归零=' + st.paid);
            // outstanding = 800 - 500 - 300(offset) = 0 → paid
            if (st.payment_status !== 'paid') throw new Error('付款状态=' + st.payment_status + '（期望paid）');
        });

        /* ---------- T7 金额守卫：改单价使金额200 < 已冲减300 被拒 ---------- */
        await test('T7 金额守卫：金额低于已冲减应付合计被拒绝', async () => {
            await editSavePO(page, poId, async p => {
                await p.fill('#poLines tbody tr:first-child input[name="qty[]"]', '40');
                await p.fill('#poLines tbody tr:first-child input[name="unit_price[]"]', '5'); // 40×5=200 < 300
            });
            const st = await poState(page, poId);
            const hash = await page.evaluate(() => location.hash);
            if (!hash.includes('/edit')) throw new Error('被拒后不应跳列表');
            if (st.amount !== 800) throw new Error('金额守卫失效：金额=' + st.amount);
            if (st.aStock !== 50) throw new Error('金额守卫失效：库存被改=' + st.aStock);
        });

        /* ---------- T8 已进货单新增明细行（新商品B）保存同步 ---------- */
        await test('T8 编辑页点「+ 新增明细」加商品B(qty10) 保存：B库存20、A库存10', async () => {
            await page.evaluate((id) => { location.hash = '#/purchase-orders/' + id + '/edit'; }, poId);
            await page.waitForSelector('#poForm', { timeout: 10000 });
            await page.waitForTimeout(200);
            // 行1：qty 80→40（同T7但恢复单价10，金额400≥300守卫通过）
            await page.fill('#poLines tbody tr:first-child input[name="qty[]"]', '40');
            await page.fill('#poLines tbody tr:first-child input[name="unit_price[]"]', '10');
            // 行2：新增 B qty10 × 单价5（purchase_to_stock=2 → 库存+20）
            await page.evaluate(() => Pages.addPOLine());
            await page.selectOption('#poLines tbody tr:nth-child(2) select[name="item_id[]"]', 'pei2');
            await page.fill('#poLines tbody tr:nth-child(2) input[name="qty[]"]', '10');
            await page.fill('#poLines tbody tr:nth-child(2) input[name="unit_price[]"]', '5');
            await page.evaluate(() => document.querySelector('#poForm').requestSubmit());
            await page.waitForTimeout(800);
            const st = await poState(page, poId);
            if (st.amount !== 450) throw new Error('金额=' + st.amount + '（期望450=400+50）');
            if (st.lineCount !== 2) throw new Error('明细行数=' + st.lineCount);
            if (st.aStock !== 10) throw new Error('A库存=' + st.aStock + '（期望10=40-退30）');
            if (st.bStock !== 20) throw new Error('B库存=' + st.bStock + '（期望20=qty10×2）');
        });

        /* ---------- T9 跨仓守卫 + 无退回单跨仓迁移 ---------- */
        await test('T9 已退回单变更仓库被拒；无退回新单跨仓迁移正确', async () => {
            // 9a. 主链单（含退回）改仓库 → 拒绝
            await page.evaluate((id) => { location.hash = '#/purchase-orders/' + id + '/edit'; }, poId);
            await page.waitForSelector('#poForm', { timeout: 10000 });
            await page.waitForTimeout(200);
            await page.selectOption('select[name="warehouse_id"]', 'wh2');
            await page.evaluate(() => document.querySelector('#poForm').requestSubmit());
            await page.waitForTimeout(500);
            const stA = await poState(page, poId);
            if (stA.aStock2 !== 0 || stA.aStock !== 10) throw new Error('跨仓守卫失效 wh1=' + stA.aStock + ' wh2=' + stA.aStock2);

            // 9b. 另一张无退回单：wh1 进货50 → 编辑改仓 wh2 → 库存迁移
            const po2 = await createPO(page, 'pei1', 50, 20);
            await page.evaluate((id) => Pages.receivePO(id), po2.id);
            await confirmOk(page);
            await page.evaluate((id) => { location.hash = '#/purchase-orders/' + id + '/edit'; }, po2.id);
            await page.waitForSelector('#poForm', { timeout: 10000 });
            await page.waitForTimeout(200);
            await page.selectOption('select[name="warehouse_id"]', 'wh2');
            await page.evaluate(() => document.querySelector('#poForm').requestSubmit());
            await page.waitForTimeout(800);
            const v2 = await page.evaluate((id) => ({
                wh1: DB.stockOf('wh1', 'pei1'), wh2: DB.stockOf('wh2', 'pei1'),
                wh: DB.get('purchase_orders', id).warehouse_id
            }), po2.id);
            // wh1 原有 pei1=10（主链单）→ 迁移后 wh1=10（主链的）、wh2=50（po2）
            if (v2.wh !== 'wh2') throw new Error('仓库未更新');
            if (v2.wh1 !== 10) throw new Error('跨仓迁移 wh1=' + v2.wh1 + '（期望10）');
            if (v2.wh2 !== 50) throw new Error('跨仓迁移 wh2=' + v2.wh2 + '（期望50）');
        });

        results.forEach(r => console.log(r));
        console.log(`\n==== test-po-edit 完成：通过 ${pass} / 失败 ${fail} ====`);
    } catch (e) {
        console.error('FATAL:', e);
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
    if (fail > 0) process.exitCode = 1;
})();
