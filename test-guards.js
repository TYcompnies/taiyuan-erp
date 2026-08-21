/**
 * test-guards.js — 业务守卫与幂等专项测试
 * 验证：重复操作守卫 / 超收超付拒绝 / 传票幂等 / 已过账禁删 / 状态锁定。
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

        const setup = await db(page, () => {
            ['sales_orders', 'shipments', 'purchase_orders', 'sales_returns', 'purchase_returns',
                'expenses', 'vouchers', 'inventory_adjusts'].forEach(c => DB._mem[c] = []);
            DB._mem.items = DB.list('items').filter(i => i.id !== 'it_g1');
            DB._mem.stock = {};
            DB.insert('items', { id: 'it_g1', code: 'G-001', name: '守卫测试商品', unit: '个', stock_unit: '个', sales_to_stock: 1, purchase_to_stock: 1, cost: 5, purchase_currency: 'CNY', safe_qty: 0, status: true });
            DB.flush();
            const sp = DB.list('suppliers')[0];
            const c = DB.list('customers')[0];
            const wh = DB.list('warehouses')[0];
            const po = DB.insert('purchase_orders', {
                no: 'PO-G-001', supplier_id: sp.id, supplier_name: sp.name, po_date: '2026-08-21',
                status: 'draft', currency: 'CNY', warehouse_id: wh.id,
                lines: [{ item_id: 'it_g1', code: 'G-001', name: '守卫测试商品', qty: 10, unit: '个', unit_price: 5, amount: 50 }],
                amount: 50, tax_amount: 0, paid_amount: 0, payment_status: 'unpaid'
            });
            const so = DB.insert('sales_orders', {
                no: 'SO-G-001', customer_id: c.id, customer_name: c.name, order_date: '2026-08-21',
                status: 'draft', currency: 'CNY',
                lines: [{ item_id: 'it_g1', code: 'G-001', name: '守卫测试商品', qty: 4, unit: '个', unit_price: 10, amount: 40 }],
                invoice_amount: 40, received_amount: 0, payment_status: 'unpaid'
            });
            DB.flush();
            return { poId: po.id, soId: so.id };
        });

        // ---- G1 重复进货守卫 ----
        await db(page, (a) => {
            Pages.receivePO(a.poId);
            document.querySelector('.modal-mask #confirmOkBtn').click();
        }, setup);
        const g1 = await db(page, (a) => {
            // 再次进货应被拒绝（toast 且状态不变）
            Pages.receivePO(a.poId);
            const blocked = !document.querySelector('.modal-mask #confirmOkBtn'); // 直接 toast 返回，无确认框
            document.querySelectorAll('.modal-mask').forEach(m => m.remove());
            return { blocked, st: DB.get('purchase_orders', a.poId).status, stock: DB.totalStock('it_g1') };
        }, setup);
        await test('G1 已进货 PO 重复进货被拒绝（状态不变、库存不变）', async () => {
            if (!g1.blocked) throw new Error('重复进货未被拦截');
            if (g1.st !== 'received') throw new Error('状态被误改: ' + g1.st);
            if (g1.stock !== 10) throw new Error('库存被误改: ' + g1.stock);
        });

        // ---- G2 重复出货守卫 ----
        await db(page, (a) => {
            Pages.shipOrder(a.soId);
            Pages.doShip(a.soId);
        }, setup);
        const g2 = await db(page, (a) => {
            // 直接调 doShip：已出货订单应 toast 拒绝
            let err = null;
            try { Pages.doShip(a.soId); } catch (e) { err = e.message; }
            const ships = DB.list('shipments').filter(s => s.sales_order_id === a.soId).length;
            return { ships, st: DB.get('sales_orders', a.soId).status, stock: DB.totalStock('it_g1') };
        }, setup);
        await test('G2 已出货 SO 重复出货被拒绝（出货单不重复）', async () => {
            if (g2.ships !== 1) throw new Error('出货单数: ' + g2.ships);
            if (g2.st !== 'shipped') throw new Error('状态: ' + g2.st);
            if (g2.stock !== 6) throw new Error('库存: ' + g2.stock);
        });

        // ---- G3 超收拒绝 ----
        await db(page, (a) => {
            Pages.receivePayment(a.soId);
            // 篡改输入为超额
            document.getElementById('payAmount').value = '999';
            Pages.doSavePayment(a.soId);
        }, setup);
        const g3 = await db(page, (a) => DB.get('sales_orders', a.soId), setup);
        await test('G3 超收被拒绝（received_amount 保持 0）', async () => {
            if (parseFloat(g3.received_amount || 0) !== 0) throw new Error('received_amount = ' + g3.received_amount);
            if (g3.payment_status !== 'unpaid') throw new Error('payment_status = ' + g3.payment_status);
        });
        await db(page, () => document.querySelectorAll('.modal-mask').forEach(m => m.remove()));

        // ---- G4 分次收款 + RECV 传票序号递增 ----
        await db(page, (a) => {
            Pages.receivePayment(a.soId);
            document.getElementById('payAmount').value = '20';
            Pages.doSavePayment(a.soId);
        }, setup);
        await db(page, (a) => {
            Pages.receivePayment(a.soId);
            document.getElementById('payAmount').value = '20';
            Pages.doSavePayment(a.soId);
        }, setup);
        const g4 = await db(page, (a) => ({
            recv: Utils.num(DB.get('sales_orders', a.soId).received_amount),
            ps: DB.get('sales_orders', a.soId).payment_status,
            v1: DB.list('vouchers').some(v => v.biz_key === 'RECV:' + a.soId + ':1'),
            v2: DB.list('vouchers').some(v => v.biz_key === 'RECV:' + a.soId + ':2')
        }), setup);
        await test('G4 分两次收款各 20：状态 paid 且两张 RECV 传票', async () => {
            if (g4.recv !== 40) throw new Error('received = ' + g4.recv);
            if (g4.ps !== 'paid') throw new Error('payment_status = ' + g4.ps);
            if (!g4.v1 || !g4.v2) throw new Error(`传票 v1=${g4.v1} v2=${g4.v2}`);
        });

        // ---- G5 超付拒绝 ----
        await db(page, (a) => {
            Pages.payPO(a.poId);
            document.getElementById('payAmountPO').value = '999';
            Pages.doSavePayPO(a.poId);
        }, setup);
        const g5 = await db(page, (a) => DB.get('purchase_orders', a.poId), setup);
        await test('G5 超付被拒绝（paid_amount 保持 0）', async () => {
            if (parseFloat(g5.paid_amount || 0) !== 0) throw new Error('paid_amount = ' + g5.paid_amount);
        });
        await db(page, () => document.querySelectorAll('.modal-mask').forEach(m => m.remove()));

        // ---- G6 传票幂等（同 bizKey 不重复） ----
        const g6 = await db(page, (a) => {
            const so = DB.get('sales_orders', a.soId);
            const before = DB.list('vouchers').length;
            // 重复调用 onShipment（理论上不该发生，但验证幂等防线）
            const ship = DB.list('shipments')[0];
            const v1 = ACCT.onShipment(ship, so);
            const v2 = ACCT.onShipment(ship, so);
            const after = DB.list('vouchers').length;
            return { before, after, v1: !!v1, v2: !!v2 };
        }, setup);
        await test('G6 onShipment 重复调用幂等（不产生重复传票）', async () => {
            if (g6.after !== g6.before) throw new Error(`传票数 ${g6.before} → ${g6.after}`);
        });

        // ---- G7 已过账传票禁删 ----
        const g7 = await db(page, () => {
            const v = DB.list('vouchers').find(x => x.status === '已过账');
            Pages.deleteVoucher(v.id);
            const still = !!DB.get('vouchers', v.id);
            document.querySelectorAll('.modal-mask').forEach(m => m.remove());
            return still;
        });
        await test('G7 已过账传票禁止删除', async () => {
            if (!g7) throw new Error('已过账传票被删除');
        });

        // ---- G8 试算平衡（守卫操作后） ----
        const g8 = await db(page, () => {
            const m = ACCT.allAccountBalances(null);
            return Object.values(m).reduce((s, x) => s + x.debit, 0) - Object.values(m).reduce((s, x) => s + x.credit, 0);
        });
        await test('G8 全部守卫操作后试算表仍平衡', async () => {
            if (Math.abs(g8) > 0.01) throw new Error('差 ' + g8);
        });

        // 清理
        await db(page, () => {
            ['sales_orders', 'shipments', 'purchase_orders', 'sales_returns', 'purchase_returns',
                'expenses', 'vouchers', 'inventory_adjusts'].forEach(c => DB._mem[c] = []);
            DB._mem.items = DB.list('items').filter(i => i.id !== 'it_g1');
            DB._mem.stock = {};
            DB.flush();
        });
    } catch (e) {
        console.error('测试框架错误:', e.message);
    } finally {
        await browser.close();
    }
    results.forEach(r => console.log(r));
    console.log(`\n===== 守卫与幂等专项: ${pass} 通过 / ${fail} 失败 =====`);
    process.exit(fail ? 1 : 0);
})();
