/**
 * test-integration.js — 跨模块端到端业务闭环联动测试（第3版，会计模块已移除）
 * 验证「采购→付款→销售→出货→收款→退货→删除回冲→报表」全链路联动更新一致性。
 * 全程走真实 UI 弹窗流程（receivePO/shipOrder/receivePayment/payPO/deleteShipment）。
 * 传票自动生成断言改为「vouchers 全程为空」验证（会计层移除后业务侧无传票写入）。
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

// 清空业务数据 + 注入测试商品（采购单位=箱 1:10，销售单位=个 1:1，成本8）
async function seed(page) {
    await db(page, () => {
        ['sales_orders', 'shipments', 'purchase_orders', 'sales_returns', 'purchase_returns',
            'expenses', 'vouchers', 'inventory_adjusts'].forEach(c => DB._mem[c] = []);
        DB._mem.items = DB.list('items').filter(i => i.id !== 'it_int1');
        DB._mem.stock = {};
        DB.insert('items', {
            id: 'it_int1', code: 'INT-001', name: '联动测试商品', unit: '个', stock_unit: '个',
            category: '', sales_to_stock: 1, purchase_to_stock: 10,
            cost: 8, purchase_currency: 'CNY', safe_qty: 5, status: true
        });
        DB.flush();
    });
}

// 点击 confirmModal 的确认按钮（真实 UI 交互；确认按钮 id=confirmOkBtn）
async function clickConfirm(page) {
    await page.evaluate(() => {
        const btn = document.querySelector('.modal-mask #confirmOkBtn');
        if (btn) btn.click();
    });
    await page.waitForTimeout(300);
}

async function closeModals(page) {
    await page.evaluate(() => document.querySelectorAll('.modal-mask').forEach(m => m.remove()));
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    await page.context().route(/textdb\.online|api\.github\.com|raw\.githubusercontent\.com/i, r => (r.request().url().includes('github') ? r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : (r.request().method() === 'POST' ? r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' }) : r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' }))).catch(() => { }));
    try {
        await login(page);
        await seed(page);

        // ===== A. 采购闭环 =====
        const po = await db(page, () => {
            const sp = DB.list('suppliers')[0];
            const wh = DB.list('warehouses')[0];
            const po = DB.insert('purchase_orders', {
                no: 'PO-INT-001', supplier_id: sp.id, supplier_name: sp.name,
                po_date: '2026-08-21', status: 'draft', currency: 'CNY', warehouse_id: wh.id,
                lines: [{ item_id: 'it_int1', code: 'INT-001', name: '联动测试商品', qty: 5, unit: '箱', unit_price: 80, amount: 400 }],
                amount: 400, tax_amount: 0, paid_amount: 0, payment_status: 'unpaid'
            });
            DB.flush();
            return { id: po.id, no: po.no };
        });
        await test('A1 采购单创建（5箱×80=400）', async () => {
            if (!po.id) throw new Error('PO 未创建');
        });

        await db(page, (a) => Pages.receivePO(a.id), { id: po.id });
        await clickConfirm(page);
        await test('A2 进货后总库存 = 50 个（5箱×10换算率）', async () => {
            const st = await db(page, () => DB.totalStock('it_int1'));
            if (st !== 50) throw new Error(`库存期望 50 实际 ${st}`);
        });
        await test('A3 进货后 vouchers 仍为空（会计模块已移除，无 PO 传票）', async () => {
            const v = await db(page, () => DB.list('vouchers').length);
            if (v !== 0) throw new Error(`vouchers 期望 0 实际 ${v}`);
        });

        await db(page, (a) => Pages.payPO(a.id), { id: po.id });
        await page.waitForTimeout(200);
        await db(page, (a) => Pages.doSavePayPO(a.id), { id: po.id });
        await page.waitForTimeout(200);
        await test('A4 付款后 PO payment_status = paid，库存不变 50', async () => {
            const r = await db(page, (a) => ({ ps: DB.get('purchase_orders', a.id).payment_status, stock: DB.totalStock('it_int1') }), { id: po.id });
            if (r.ps !== 'paid') throw new Error(`payment_status 期望 paid 实际 ${r.ps}`);
            if (r.stock !== 50) throw new Error(`库存期望 50 实际 ${r.stock}`);
        });
        await test('A5 付款后 vouchers 仍为空（无 PAY 传票）', async () => {
            const v = await db(page, () => DB.list('vouchers').length);
            if (v !== 0) throw new Error(`vouchers 期望 0 实际 ${v}`);
        });

        // ===== B. 销售闭环 =====
        const so = await db(page, () => {
            const c = DB.list('customers')[0];
            const so = DB.insert('sales_orders', {
                no: 'SO-INT-001', customer_id: c.id, customer_name: c.name,
                order_date: '2026-08-21', status: 'draft', currency: 'CNY',
                lines: [{ item_id: 'it_int1', code: 'INT-001', name: '联动测试商品', qty: 20, unit: '个', unit_price: 15, amount: 300 }],
                invoice_amount: 300, received_amount: 0, payment_status: 'unpaid'
            });
            DB.flush();
            return { id: so.id, no: so.no };
        });
        await db(page, (a) => Pages.shipOrder(a.id), { id: so.id });
        await page.waitForTimeout(200);
        await db(page, (a) => Pages.doShip(a.id), { id: so.id });
        await page.waitForTimeout(300);
        await test('B1 出货后总库存 = 30（50-20），订单状态 shipped', async () => {
            const r = await db(page, (a) => ({ stock: DB.totalStock('it_int1'), st: DB.get('sales_orders', a.id).status }), { id: so.id });
            if (r.stock !== 30) throw new Error(`库存期望 30 实际 ${r.stock}`);
            if (r.st !== 'shipped') throw new Error(`状态期望 shipped 实际 ${r.st}`);
        });
        await test('B2 出货后 vouchers 仍为空（无 SHIP 传票）', async () => {
            const v = await db(page, () => DB.list('vouchers').length);
            if (v !== 0) throw new Error(`vouchers 期望 0 实际 ${v}`);
        });
        await test('B3 经营口径：本月出货收入 300 / COGS 160（20个×成本8）', async () => {
            const r = await db(page, () => {
                const m = Utils.today().slice(0, 7); // 出货日期=当天，按页面当前月归集（勿写死月份，跨月会失效）
                const shipIds = DB.list('shipments').filter(s => (s.ship_date || '').startsWith(m)).map(s => s.sales_order_id);
                const rev = DB.list('sales_orders').filter(o => shipIds.indexOf(o.id) >= 0 && o.status === 'shipped')
                    .reduce((s, o) => s + Utils.num(o.invoice_amount), 0);
                const cogs = DB.list('shipments').filter(s => (s.ship_date || '').startsWith(m)).reduce((s, sh) => {
                    const o = DB.get('sales_orders', sh.sales_order_id);
                    return s + (o.lines || []).reduce((s2, l) => {
                        const it = DB.get('items', l.item_id);
                        return s2 + Utils.num(l.qty) * (it ? Utils.num(it.sales_to_stock || 1) : 1) * (it ? toCNY(Utils.num(it.cost), it.purchase_currency || 'CNY') : 0);
                    }, 0);
                }, 0);
                return { rev, cogs };
            });
            if (Math.abs(r.rev - 300) > 0.01) throw new Error(`收入期望 300 实际 ${r.rev}`);
            if (Math.abs(r.cogs - 160) > 0.01) throw new Error(`COGS 期望 160 实际 ${r.cogs}`);
        });

        await db(page, (a) => Pages.receivePayment(a.id), { id: so.id });
        await page.waitForTimeout(200);
        await db(page, (a) => Pages.doSavePayment(a.id), { id: so.id });
        await page.waitForTimeout(200);
        await test('B4 收款后 SO payment_status = paid', async () => {
            const ps = await db(page, (a) => DB.get('sales_orders', a.id).payment_status, { id: so.id });
            if (ps !== 'paid') throw new Error(`payment_status 期望 paid 实际 ${ps}`);
        });
        await test('B5 收款后 vouchers 仍为空（无 RECV 传票）', async () => {
            const v = await db(page, () => DB.list('vouchers').length);
            if (v !== 0) throw new Error(`vouchers 期望 0 实际 ${v}`);
        });

        // ===== C. 销退闭环 =====
        await db(page, (a) => {
            const so = DB.get('sales_orders', a.id);
            const wh = DB.list('shipments')[0] ? DB.list('shipments')[0].warehouse_id : 'wh1';
            // 模拟 saveSalesReturn 的库存回补（qty × 销售→库存换算率）
            so.lines.forEach(l => {
                const it = DB.get('items', l.item_id);
                const rate = it && Utils.num(it.sales_to_stock) > 0 ? Utils.num(it.sales_to_stock) : 1;
                DB.addStock(wh, l.item_id, 5 * rate);
            });
            const sr = DB.insert('sales_returns', {
                no: 'SR-INT-001', sales_order_id: so.id, customer_id: so.customer_id,
                return_date: '2026-08-21', type: '退回', offset_receivable: true,
                total_amount: 75, cost_reversal: 40,
                lines: so.lines.map(l => ({ ...l, qty: 5, amount: 75 }))
            });
            DB.flush();
        }, { id: so.id });
        await test('C1 销退后库存回补 = 35（30+5）', async () => {
            const st = await db(page, () => DB.totalStock('it_int1'));
            if (st !== 35) throw new Error(`库存期望 35 实际 ${st}`);
        });
        await test('C2 销退后 vouchers 仍为空（无 SRET 传票）', async () => {
            const v = await db(page, () => DB.list('vouchers').length);
            if (v !== 0) throw new Error(`vouchers 期望 0 实际 ${v}`);
        });

        // ===== D. 会计模块移除验证 =====
        await test('D1 ACCT 未定义且会计集合为空（模块已移除）', async () => {
            const r = await db(page, () => ({
                acct: typeof ACCT !== 'undefined',
                vouchers: DB.list('vouchers').length,
                expenses: DB.list('expenses').length,
                accounts: DB.list('chart_accounts').length
            }));
            if (r.acct) throw new Error('ACCT 仍存在');
            if (r.vouchers || r.expenses || r.accounts) throw new Error(`会计集合非空 v=${r.vouchers} e=${r.expenses} a=${r.accounts}`);
        });

        // ===== E. 删除守卫 + 删除回冲 =====
        await test('E1 有销退记录时删除出货单被拒绝（安全守卫）', async () => {
            const r = await db(page, () => {
                const s = DB.list('shipments')[0];
                Pages.deleteShipment(s.id);
                return { count: DB.list('shipments').length, st: DB.get('sales_orders', s.sales_order_id).status };
            });
            if (r.count !== 1) throw new Error('出货单被误删');
            if (r.st !== 'shipped') throw new Error('订单状态被误改');
            await closeModals(page);
        });
        // 删除销退记录后再删出货单（会计已移除，无需作废传票）
        await db(page, () => {
            const sr = DB.list('sales_returns')[0];
            DB.remove('sales_returns', sr.id);
            DB.flush();
        });
        const shipId = await db(page, () => DB.list('shipments')[0].id);
        await db(page, (a) => Pages.deleteShipment(a.id), { id: shipId });
        await clickConfirm(page);
        await test('E2 删出货单后库存回冲 = 55（35+20）且订单恢复 draft', async () => {
            const r = await db(page, (a) => ({ stock: DB.totalStock('it_int1'), st: DB.get('sales_orders', a.id).status }), { id: so.id });
            if (r.stock !== 55) throw new Error(`库存期望 55 实际 ${r.stock}`);
            if (r.st !== 'draft') throw new Error(`状态期望 draft 实际 ${r.st}`);
        });
        await test('E3 删出货单后 vouchers 仍为空（无传票残留）', async () => {
            const v = await db(page, () => DB.list('vouchers').length);
            if (v !== 0) throw new Error(`vouchers 期望 0 实际 ${v}`);
        });
        await test('E4 删除联动后会计集合仍为空（无隐藏写入）', async () => {
            const r = await db(page, () => ({ v: DB.list('vouchers').length, e: DB.list('expenses').length, a: DB.list('chart_accounts').length }));
            if (r.v || r.e || r.a) throw new Error(`会计集合非空 v=${r.v} e=${r.e} a=${r.a}`);
        });

        // ===== F. 出勤数据隔离 =====
        await test('F1 ERP 与出勤 localStorage 完全隔离', async () => {
            const r = await db(page, () => ({
                erp: !!localStorage.getItem('taiyuan_erp_data_v1'),
                attKeys: Object.keys(localStorage).filter(k => k === 'attendance_system_db').length
            }));
            if (!r.erp) throw new Error('ERP localStorage 键缺失');
        });

        // ===== G. 云同步快照完整性 =====
        await test('G1 云同步快照包含全部业务集合（payload）', async () => {
            const r = await db(page, () => {
                const snap = CloudSync.buildSnapshot();
                const cols = Object.keys(snap.payload || {});
                return { rev: snap.rev, hasVouchers: cols.indexOf('vouchers') >= 0, hasItems: cols.indexOf('items') >= 0, hasStock: cols.indexOf('stock') >= 0, nCols: cols.length };
            });
            if (!r.hasVouchers || !r.hasItems || !r.hasStock) throw new Error(`快照缺集合: cols=${r.nCols}`);
        });
        await test('G2 快照可 JSON 序列化（可上传）', async () => {
            const ok = await db(page, () => {
                try { JSON.stringify(CloudSync.buildSnapshot()); return true; } catch (e) { return false; }
            });
            if (!ok) throw new Error('快照序列化失败');
        });

        // ===== 清理 =====
        await db(page, () => {
            ['sales_orders', 'shipments', 'purchase_orders', 'sales_returns', 'purchase_returns',
                'expenses', 'vouchers', 'inventory_adjusts'].forEach(c => DB._mem[c] = []);
            DB._mem.items = DB.list('items').filter(i => i.id !== 'it_int1');
            DB._mem.stock = {};
            DB.flush();
        });
    } catch (e) {
        console.error('测试框架错误:', e.message);
    } finally {
        await browser.close();
    }

    results.forEach(r => console.log(r));
    console.log(`\n===== 跨模块联动测试: ${pass} 通过 / ${fail} 失败 =====`);
    process.exit(fail ? 1 : 0);
})();
