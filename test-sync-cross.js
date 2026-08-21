/**
 * test-sync-cross.js — 跨设备云同步模拟测试
 * 两个独立浏览器上下文（模拟不同网络 IP/设备）：
 * A 构建快照 → 传输编码（压缩/加密）→ B 解码应用 → 验证数据一致、页面渲染正常、备份已生成。
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

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    // 两个完全独立的上下文 = 两台不同设备
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    try {
        await login(pageA);
        await login(pageB);

        // 设备 A：注入业务数据
        await pageA.evaluate(() => {
            ['sales_orders', 'shipments', 'purchase_orders', 'sales_returns', 'purchase_returns',
                'expenses', 'vouchers', 'inventory_adjusts'].forEach(c => DB._mem[c] = []);
            DB._mem.items = DB.list('items').filter(i => i.id !== 'it_x1');
            DB._mem.stock = {};
            DB.insert('items', { id: 'it_x1', code: 'X-001', name: '跨设备同步商品', unit: '个', stock_unit: '个', sales_to_stock: 1, purchase_to_stock: 1, cost: 12, purchase_currency: 'CNY', safe_qty: 0, status: true });
            const c = DB.list('customers')[0];
            DB.insert('sales_orders', {
                no: 'SO-X-001', customer_id: c.id, customer_name: c.name, order_date: '2026-08-21',
                status: 'draft', currency: 'CNY',
                lines: [{ item_id: 'it_x1', code: 'X-001', name: '跨设备同步商品', qty: 3, unit: '个', unit_price: 20, amount: 60 }],
                invoice_amount: 60, received_amount: 0, payment_status: 'unpaid'
            });
            DB.flush();
            DB.addStock(DB.list('warehouses')[0].id, 'it_x1', 100);
        });

        // 两台设备均配置相同加密口令（模拟同步设置一致）
        await pageA.evaluate(() => CloudSync.saveCfg({ pass: 'test-pass-123' }));
        await pageB.evaluate(() => CloudSync.saveCfg({ pass: 'test-pass-123' }));

        // A：构建快照 + 压缩编码 + 加密（模拟真实传输格式，口令取自配置）
        const enc = await pageA.evaluate(async () => {
            const snap = CloudSync.buildSnapshot();
            const json = JSON.stringify(snap);
            const compressed = await CloudSync._compress(json);
            const encrypted = await CloudSync._encrypt(compressed);
            return { enc: encrypted, rev: snap.rev, marker: encrypted.slice(0, 4) };
        });
        await test('X1 快照加密编码成功（TYE1: 标记）', async () => {
            if (enc.marker !== 'TYE1') throw new Error('标记: ' + enc.marker);
            if (!enc.enc || enc.enc.length < 50) throw new Error('编码长度异常');
        });

        // B：解码 → 应用（含 LWW + 自动备份）
        await test('X2 设备 B 解码快照（解密+解压）', async () => {
            const ok = await pageB.evaluate(async (arg) => {
                const snap = await CloudSync.parseSnapshot(arg.enc);
                return snap && snap.payload && snap.payload.items && snap.payload.items.some(i => i.id === 'it_x1');
            }, { enc: enc.enc });
            if (!ok) throw new Error('解码失败或数据缺失');
        });
        await test('X3 设备 B 应用远端数据（applyRemote + 自动备份）', async () => {
            const r = await pageB.evaluate(async (arg) => {
                const snap = await CloudSync.parseSnapshot(arg.enc);
                await CloudSync.applyRemote(snap);
                return {
                    itemOk: DB.list('items').some(i => i.id === 'it_x1'),
                    soOk: DB.list('sales_orders').some(o => o.no === 'SO-X-001'),
                    stockOk: DB.totalStock('it_x1') === 100,
                    backups: CloudSync.backups().length
                };
            }, { enc: enc.enc });
            if (!r.itemOk) throw new Error('商品未同步');
            if (!r.soOk) throw new Error('订单未同步');
            if (!r.stockOk) throw new Error('库存未同步: ' + DB.totalStock);
            if (r.backups < 1) throw new Error('未自动备份');
        });
        await test('X4 设备 B 应用后页面渲染正常（数据出现在列表）', async () => {
            await pageB.goto(BASE + '#/sales-orders');
            await pageB.waitForTimeout(800);
            const html = await pageB.evaluate(() => document.body.innerHTML);
            if (html.indexOf('SO-X-001') < 0) throw new Error('订单列表未显示同步数据');
            // 订单详情页应显示商品明细
            const detailOk = await pageB.evaluate(() => {
                const so = DB.list('sales_orders').find(o => o.no === 'SO-X-001');
                return !!(so && so.lines && so.lines.some(l => l.name === '跨设备同步商品'));
            });
            if (!detailOk) throw new Error('订单明细商品未同步');
        });
        await test('X5 设备 B 可继续编辑（出货联动正常）', async () => {
            const r = await pageB.evaluate(() => {
                const so = DB.list('sales_orders').find(o => o.no === 'SO-X-001');
                Pages.shipOrder(so.id);
                Pages.doShip(so.id);
                return { st: DB.get('sales_orders', so.id).status, stock: DB.totalStock('it_x1'), shipVoucher: DB.list('vouchers').filter(v => (v.biz_key || '').indexOf('SHIP:') === 0 && v.status === '已过账').length };
            });
            if (r.st !== 'shipped') throw new Error('出货失败: ' + r.st);
            if (r.stock !== 97) throw new Error('库存: ' + r.stock);
            if (r.shipVoucher !== 1) throw new Error('出货传票: ' + r.shipVoucher);
        });
        await test('X6 B 编辑后再反向同步回 A（双向闭环）', async () => {
            const encB = await pageB.evaluate(async () => {
                const snap = CloudSync.buildSnapshot();
                const compressed = await CloudSync._compress(JSON.stringify(snap));
                return { enc: await CloudSync._encrypt(compressed, 'test-pass-123') };
            });
            const r = await pageA.evaluate(async (arg) => {
                const snap = await CloudSync.parseSnapshot(arg.enc, 'test-pass-123');
                await CloudSync.applyRemote(snap);
                return {
                    st: DB.list('sales_orders').find(o => o.no === 'SO-X-001').status,
                    stock: DB.totalStock('it_x1'),
                    vouchers: DB.list('vouchers').filter(v => (v.biz_key || '').indexOf('SHIP:') === 0 && v.status === '已过账').length
                };
            }, encB);
            if (r.st !== 'shipped') throw new Error('A 未收到出货状态: ' + r.st);
            if (r.stock !== 97) throw new Error('A 库存: ' + r.stock);
            if (r.vouchers !== 1) throw new Error('A 出货传票: ' + r.vouchers);
        });
        await test('X7 同步后设备 A 试算表平衡', async () => {
            const diff = await pageA.evaluate(() => {
                const m = ACCT.allAccountBalances(null);
                return Object.values(m).reduce((s, x) => s + x.debit, 0) - Object.values(m).reduce((s, x) => s + x.credit, 0);
            });
            if (Math.abs(diff) > 0.01) throw new Error('差 ' + diff);
        });

        // 清理两台设备
        await pageA.evaluate(() => {
            ['sales_orders', 'shipments', 'purchase_orders', 'sales_returns', 'purchase_returns',
                'expenses', 'vouchers', 'inventory_adjusts'].forEach(c => DB._mem[c] = []);
            DB._mem.items = DB.list('items').filter(i => i.id !== 'it_x1');
            DB._mem.stock = {};
            CloudSync.clearBackups();
            DB.flush();
        });
        await pageB.evaluate(() => {
            ['sales_orders', 'shipments', 'purchase_orders', 'sales_returns', 'purchase_returns',
                'expenses', 'vouchers', 'inventory_adjusts'].forEach(c => DB._mem[c] = []);
            DB._mem.items = DB.list('items').filter(i => i.id !== 'it_x1');
            DB._mem.stock = {};
            CloudSync.clearBackups();
            DB.flush();
        });
    } catch (e) {
        console.error('测试框架错误:', e.message);
    } finally {
        await ctxA.close();
        await ctxB.close();
        await browser.close();
    }
    results.forEach(r => console.log(r));
    console.log(`\n===== 跨设备同步模拟: ${pass} 通过 / ${fail} 失败 =====`);
    process.exit(fail ? 1 : 0);
})();
