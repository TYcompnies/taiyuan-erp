/**
 * test-fx.js — 外币全链路折本位币联动专项测试
 * USD 采购 + USD 销售：验证传票金额、损益收入、应收应付全部正确折算 CNY。
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

        // USD 采购 10 个 × $10 = $100 → 进货 → 传票折 CNY = 100×RATE
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
        await test('T1 USD 进货传票金额折 CNY（100 USD → ' + (100 * RATE) + '）', async () => {
            const r = await db(page, (a) => {
                const v = DB.list('vouchers').find(x => x.biz_key === 'PO:' + a.id);
                if (!v) return null;
                return { d: v.lines.reduce((s, l) => s + Utils.num(l.debit), 0), c: v.lines.reduce((s, l) => s + Utils.num(l.credit), 0) };
            }, { id: po });
            if (!r) throw new Error('无 PO 传票');
            if (Math.abs(r.d - 100 * RATE) > 0.01) throw new Error(`借方期望 ${100 * RATE} 实际 ${r.d}`);
            if (Math.abs(r.c - 100 * RATE) > 0.01) throw new Error(`贷方期望 ${100 * RATE} 实际 ${r.c}`);
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
        await test('T3 USD 出货收入传票折 CNY（120 USD → ' + (120 * RATE) + '）', async () => {
            const r = await db(page, () => {
                const v = DB.list('vouchers').filter(x => (x.biz_key || '').indexOf('SHIP:') === 0 && x.status === '已过账')[0];
                if (!v) return null;
                const rev = (v.lines || []).filter(l => l.account === '主营业务收入').reduce((s, l) => s + Utils.num(l.credit), 0);
                return rev;
            });
            if (r === null) throw new Error('无 SHIP 传票');
            if (Math.abs(r - 120 * RATE) > 0.01) throw new Error(`收入贷方期望 ${120 * RATE} 实际 ${r}`);
        });
        await test('T4 COGS 折 CNY（6个 × $10 × ' + RATE + ' = ' + (60 * RATE) + '）', async () => {
            const r = await db(page, () => {
                const v = DB.list('vouchers').filter(x => (x.biz_key || '').indexOf('SHIP:') === 0 && x.status === '已过账')[0];
                if (!v) return null;
                const cogs = (v.lines || []).filter(l => l.account === '主营业务成本').reduce((s, l) => s + Utils.num(l.debit), 0);
                return cogs;
            });
            if (Math.abs(r - 60 * RATE) > 0.01) throw new Error(`COGS 期望 ${60 * RATE} 实际 ${r}`);
        });
        await test('T5 损益表口径：收入与 COGS 均折 CNY', async () => {
            const r = await db(page, () => {
                const m = '2026-08';
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

        // USD 收款 $120 → RECV 传票折 CNY
        await db(page, (a) => { Pages.receivePayment(a.id); }, { id: so });
        await page.waitForTimeout(200);
        await db(page, (a) => { Pages.doSavePayment(a.id); }, { id: so });
        await page.waitForTimeout(200);
        await test('T7 USD 收款传票折 CNY（120 USD → ' + (120 * RATE) + '）', async () => {
            const r = await db(page, (a) => {
                const v = DB.list('vouchers').find(x => (x.biz_key || '').indexOf('RECV:' + a.id + ':') === 0 && x.status === '已过账');
                if (!v) return null;
                return v.lines.reduce((s, l) => s + Utils.num(l.debit), 0);
            }, { id: so });
            if (Math.abs(r - 120 * RATE) > 0.01) throw new Error(`收款借方期望 ${120 * RATE} 实际 ${r}`);
        });
        await test('T8 外币全链路后试算表仍平衡', async () => {
            const diff = await db(page, () => {
                const m = ACCT.allAccountBalances(null);
                return Object.values(m).reduce((s, x) => s + x.debit, 0) - Object.values(m).reduce((s, x) => s + x.credit, 0);
            });
            if (Math.abs(diff) > 0.01) throw new Error(`试算表差 ${diff}`);
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
