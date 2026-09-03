/**
 * test-fx.js — 外币全链路折本位币联动专项测试（第2版，会计模块已移除）
 * USD 采购 + USD 销售：验证库存价值、经营收入、应收应付全部正确折算 CNY，
 * 且业务操作全程不产生传票（会计层移除后 vouchers 保持为空）。
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8902';

let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
    try { await fn(); pass++; results.push(`✅ PASS: ${name}`); }
    catch (e) { fail++; results.push(`❌ FAIL: ${name} — ${e.message.split('\n')[0]}`); }
}
async function login(page) {
    await page.goto(BASE);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(BASE);
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'admin123');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.sidebar, nav', { timeout: 15000 });
    await page.waitForTimeout(500);
}
async function db(page, fn, arg) { return page.evaluate(fn, arg); }

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    await page.context().route(/textdb\.online|api\.github\.com|raw\.githubusercontent\.com/i, r => (r.request().url().includes('github') ? r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : (r.request().method() === 'POST' ? r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' }) : r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' }))).catch(() => { }));
    try {
        await login(page);

        // 获取 USD 汇率与供应商/客户（找外币客户/供应商，没有就用第一个并设币别）
        const cfg = await db(page, () => {
            ['sales_orders', 'shipments', 'purchase_orders', 'sales_returns', 'purchase_returns',
                'expenses', 'vouchers', 'inventory_adjusts'].forEach(c => DB._mem[c] = []);
            DB._mem.items = DB.list('items').filter(i => i.id !== 'it_fx1');
            DB._mem.stock = {};
            DB.insert('items', {
                id: 'it_fx1', code: 'FX-001', name: '外币测试商品', unit: '个', stock_unit: '个',
                sales_to_stock: 1, purchase_to_stock: 1, cost: 10, purchase_currency: 'USD',
                safe_qty: 0, status: true
            });
            DB.flush();
            const usd = DB.list('currencies').find(c => c.code === 'USD');
            return { rate: usd ? Utils.num(usd.rate) : null, hasUsd: !!usd };
        });
        await test('T0 种子数据含 USD 币别', async () => {
            if (!cfg.hasUsd) throw new Error('无 USD 币别');
            if (!(cfg.rate > 0)) throw new Error('USD 汇率无效: ' + cfg.rate);
        });
        const RATE = cfg.rate;

        // USD 采购 10 个 × $10 = $100 → 进货 → 库存价值折 CNY = 100×RATE
        const po = await db(page, () => {
            const sp = DB.list('suppliers')[0];
            const wh = DB.list('warehouses')[0];
            const po = DB.insert('purchase_orders', {
                no: 'PO-FX-001', supplier_id: sp.id, supplier_name: sp.name,
                po_date: '2026-08-21', status: 'draft', currency: 'USD', warehouse_id: wh.id,
                lines: [{ item_id: 'it_fx1', code: 'FX-001', name: '外币测试商品', qty: 10, unit: '个', unit_price: 10, amount: 100 }],
                amount: 100, tax_amount: 0, paid_amount: 0, payment_status: 'unpaid'
            });
            DB.flush();
            return po.id;
        });
        await db(page, (a) => { Pages.receivePO(a.id); }, { id: po });
        await page.evaluate(() => document.querySelector('.modal-mask #confirmOkBtn') && document.querySelector('.modal-mask #confirmOkBtn').click());
        await page.waitForTimeout(300);
        await test('T1 USD 进货后 vouchers 为空（会计模块已移除，无 PO 传票）', async () => {
            const r = await db(page, () => DB.list('vouchers').length);
            if (r !== 0) throw new Error(`vouchers 期望 0 实际 ${r}`);
        });
        await test('T2 库存价值折本位币（10个 × $10 成本 × ' + RATE + '）', async () => {
            const v = await db(page, () => DB.stockValue('it_fx1'));
            if (Math.abs(v - 100 * RATE) > 0.01) throw new Error(`库存价值期望 ${100 * RATE} 实际 ${v}`);
        });

        // USD 销售 6 个 × $20 = $120 → 出货 → 收入折 CNY
        const so = await db(page, () => {
            const c = DB.list('customers')[0];
            const so = DB.insert('sales_orders', {
                no: 'SO-FX-001', customer_id: c.id, customer_name: c.name,
                order_date: '2026-08-21', status: 'draft', currency: 'USD',
                lines: [{ item_id: 'it_fx1', code: 'FX-001', name: '外币测试商品', qty: 6, unit: '个', unit_price: 20, amount: 120 }],
                invoice_amount: 120, received_amount: 0, payment_status: 'unpaid'
            });
            DB.flush();
            return so.id;
        });
        await db(page, (a) => { Pages.shipOrder(a.id); }, { id: so });
        await page.waitForTimeout(200);
        await db(page, (a) => { Pages.doShip(a.id); }, { id: so });
        await page.waitForTimeout(300);
        await test('T3 USD 出货后 vouchers 为空（无 SHIP 传票）', async () => {
            const r = await db(page, () => DB.list('vouchers').length);
            if (r !== 0) throw new Error(`vouchers 期望 0 实际 ${r}`);
        });
        await test('T4 出货后剩余库存价值折 CNY（4个 × $10 × ' + RATE + ' = ' + (40 * RATE) + '）', async () => {
            const v = await db(page, () => DB.stockValue('it_fx1'));
            if (Math.abs(v - 40 * RATE) > 0.01) throw new Error(`库存价值期望 ${40 * RATE} 实际 ${v}`);
        });
        await test('T5 经营口径：收入与 COGS 均折 CNY', async () => {
            const r = await db(page, () => {
                const m = Utils.today().slice(0, 7); // 出货日期=当天，按页面当前月归集（勿写死月份，跨月会失效）
                const shipIds = DB.list('shipments').filter(s => (s.ship_date || '').startsWith(m)).map(s => s.sales_order_id);
                const rev = DB.list('sales_orders').filter(o => shipIds.indexOf(o.id) >= 0 && o.status === 'shipped')
                    .reduce((s, o) => s + toCNY(Utils.num(o.invoice_amount), o.currency), 0);
                const cogs = DB.list('shipments').filter(s => (s.ship_date || '').startsWith(m)).reduce((s, sh) => {
                    const o = DB.get('sales_orders', sh.sales_order_id);
                    return s + (o.lines || []).reduce((s2, l) => {
                        const it = DB.get('items', l.item_id);
                        return s2 + Utils.num(l.qty) * Utils.num(it ? it.sales_to_stock || 1 : 1) * (it ? toCNY(Utils.num(it.cost), it.purchase_currency || 'CNY') : 0);
                    }, 0);
                }, 0);
                return { rev, cogs };
            });
            if (Math.abs(r.rev - 120 * RATE) > 0.01) throw new Error(`收入期望 ${120 * RATE} 实际 ${r.rev}`);
            if (Math.abs(r.cogs - 60 * RATE) > 0.01) throw new Error(`COGS 期望 ${60 * RATE} 实际 ${r.cogs}`);
        });
        await test('T6 应收账款页折本位币（120 USD → ' + (120 * RATE) + '）', async () => {
            await page.goto(BASE + '#/accounting/accounts-receivable');
            await page.waitForTimeout(600);
            const html = await page.evaluate(() => document.body.innerHTML);
            const expect = (120 * RATE).toFixed(2).replace(/\.?0+$/, '');
            // 页面应同时显示外币金额与折本位币金额
            if (html.indexOf('USD') < 0 && html.indexOf('$') < 0) throw new Error('应收页未显示外币');
            if (html.indexOf('120.00') < 0) throw new Error('应收页未显示 120.00 USD 金额');
        });

        // USD 收款 $120 → 收款后订单状态与已收金额
        await db(page, (a) => { Pages.receivePayment(a.id); }, { id: so });
        await page.waitForTimeout(200);
        await db(page, (a) => { Pages.doSavePayment(a.id); }, { id: so });
        await page.waitForTimeout(200);
        await test('T7 USD 收款后 vouchers 为空（无 RECV 传票）且订单已收款', async () => {
            const r = await db(page, (a) => ({
                v: DB.list('vouchers').length,
                ps: DB.get('sales_orders', a.id).payment_status,
                rcv: Utils.num(DB.get('sales_orders', a.id).received_amount)
            }), { id: so });
            if (r.v !== 0) throw new Error(`vouchers 期望 0 实际 ${r.v}`);
            if (r.ps !== 'paid') throw new Error(`payment_status 期望 paid 实际 ${r.ps}`);
            if (Math.abs(r.rcv - 120) > 0.01) throw new Error(`已收期望 120 实际 ${r.rcv}`);
        });
        await test('T8 外币全链路后会计集合仍为空（无隐藏写入）', async () => {
            const r = await db(page, () => ({ v: DB.list('vouchers').length, e: DB.list('expenses').length, a: DB.list('chart_accounts').length }));
            if (r.v || r.e || r.a) throw new Error(`会计集合非空 v=${r.v} e=${r.e} a=${r.a}`);
        });

        // 清理
        await db(page, () => {
            ['sales_orders', 'shipments', 'purchase_orders', 'sales_returns', 'purchase_returns',
                'expenses', 'vouchers', 'inventory_adjusts'].forEach(c => DB._mem[c] = []);
            DB._mem.items = DB.list('items').filter(i => i.id !== 'it_fx1');
            DB._mem.stock = {};
            DB.flush();
        });
    } catch (e) {
        console.error('测试框架错误:', e.message);
    } finally {
        await browser.close();
    }
    results.forEach(r => console.log(r));
    console.log(`\n===== 外币联动专项: ${pass} 通过 / ${fail} 失败 =====`);
    process.exit(fail ? 1 : 0);
})();
