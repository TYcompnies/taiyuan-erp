// 用户反馈问题复现脚本：采购单合计/库存总揽TY0001/安全库存/进销存账款/仪表板营收口径/出货单按钮
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8902';
let pass = 0, fail = 0, failures = [];
const errors = [];
function check(cond, msg) {
  if (cond) { pass++; console.log('  PASS:', msg); }
  else { fail++; failures.push(msg); console.error('  FAIL:', msg); }
}
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.context().route(/textdb\.online|api\.github\.com|raw\.githubusercontent\.com/i, r => (r.request().url().includes('github') ? r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : (r.request().method() === 'POST' ? r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' }) : r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' }))).catch(() => { }));
  page.on('pageerror', err => errors.push('[pageerror] ' + err.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  async function login(user, pwd) {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const inputs = page.locator('#loginForm input');
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
      const ph = await inputs.nth(i).getAttribute('placeholder') || '';
      if (/账号|用户/i.test(ph)) await inputs.nth(i).fill(user);
      if (/密码/i.test(ph)) await inputs.nth(i).fill(pwd);
    }
    await page.locator('#loginForm button[type=submit]').click();
    await page.waitForTimeout(1000);
  }
  async function gotoHash(hash) {
    await page.evaluate(() => document.querySelectorAll('.modal-mask').forEach(m => m.remove()));
    await page.evaluate(h => { location.hash = h; }, hash);
    await page.waitForTimeout(1100);
  }
  const db = (fn, arg) => page.evaluate(({ src, a }) => { const f = eval('(' + src + ')'); return f(a); }, { src: fn.toString(), a: arg });

  await login('admin', 'admin123');

  // ===== 注入测试数据：TY0001（箱/个 换算12）、客户、供应商、USD供应商 =====
  await db(() => {
    DB.insert('items', {
      id: 'it_ty', code: 'TY0001', name: '越南咖啡1箱12袋', english_name: '', spec: '12袋/箱', brand: 'VINACAFE',
      model: '', category_id: DB.list('categories')[0].id, product_type: '成品',
      sales_unit: '箱', purchase_unit: '箱', stock_unit: '袋', sales_to_stock: 12, purchase_to_stock: 12,
      cost: 100, price: 150, min_price: 140, purchase_currency: 'USD',
      safety_stock: 50, max_stock: 1000, weight: 0, volume: 0, remark: '复现测试'
    });
    return true;
  });

  // ===== 1. 采购单合计（千分位 bug 复现）=====
  console.log('\n[1] 采购单合计：新增金额1200');
  await gotoHash('#/purchase-orders/create');
  await page.locator('[name=supplier_id]').selectOption({ index: 1 });
  await page.locator('#poLines tbody tr').first().locator('[name="item_id[]"]').selectOption('it_ty');
  await page.locator('#poLines tbody tr').first().locator('[name="qty[]"]').fill('10');
  await page.locator('#poLines tbody tr').first().locator('[name="unit_price[]"]').fill('120');
  await page.waitForTimeout(300);
  let poTotal = await page.locator('#poTotalFoot').textContent();
  check(poTotal.trim() === '1,200.00', `新增时采购合计 ${poTotal}（期望 1,200.00）`);
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(900);
  const po = await db(() => {
    const o = DB.list('purchase_orders').sort((a, b) => b.no.localeCompare(a.no))[0];
    return o ? { no: o.no, id: o.id, amount: o.amount, status: o.status } : null;
  });
  check(po && Math.abs(po.amount - 1200) < 0.01, `保存金额 ${po ? po.amount : 'null'}（期望 1200）`);

  // 编辑已有采购单 → 复现千分位合计 bug
  await gotoHash('#/purchase-orders/' + po.id + '/edit');
  await page.waitForTimeout(300);
  poTotal = await page.locator('#poTotalFoot').textContent();
  check(poTotal.trim() === '1,200.00', `编辑时采购合计 ${poTotal}（期望 1,200.00）—— 千分位 bug 复现`);

  // ===== 2. 进货入库 =====
  await gotoHash('#/purchase-orders');
  await page.locator('tr:has-text("' + po.no + '") button:has-text("进货入库")').click();
  await page.waitForTimeout(400);
  await page.locator('.modal-mask .modal-foot .btn.danger, .modal-mask .modal-foot #confirmOkBtn').first().click();
  await page.waitForTimeout(800);
  const stock1 = await db(() => ({ wh1: DB.stockOf('wh1', 'it_ty'), total: DB.totalStock('it_ty') }));
  console.log('  进货10箱(12袋/箱) → 库存:', JSON.stringify(stock1));
  check(stock1.total === 120, `进货后库存 120 袋（期望 120）`);

  // ===== 3. 库存总览 TY0001 =====
  console.log('\n[2] 库存总览 TY0001');
  await gotoHash('#/inventory/inventory_overview');
  const ovText = await page.textContent('body');
  check(/TY0001/.test(ovText), '库存总览包含 TY0001');
  // 找到 TY0001 所在行文本
  const rowText = await page.evaluate(() => {
    const rows = document.querySelectorAll('#app .table tbody tr');
    for (const r of rows) if (r.textContent.includes('TY0001')) return r.textContent;
    return '';
  });
  console.log('  库存总览 TY0001 行:', rowText.replace(/\s+/g, ' ').slice(0, 300));
  check(rowText.includes('120'), `库存总览 TY0001 显示 120`);

  // ===== 4. 安全库存报表 =====
  console.log('\n[3] 安全库存报表');
  await gotoHash('#/inventory/inventory_safety');
  const sfText = await page.evaluate(() => {
    const rows = document.querySelectorAll('#app .table tbody tr');
    for (const r of rows) if (r.textContent.includes('TY0001')) return r.textContent;
    return '';
  });
  console.log('  安全库存 TY0001 行:', sfText.replace(/\s+/g, ' ').slice(0, 300));
  check(sfText.includes('120'), `安全库存报表总仓库存 120`);
  check(sfText.includes('50'), `安全库存报表安全库存 50`);

  // ===== 5. 销货订单（跨月场景：上个月下单，本月出货）=====
  console.log('\n[4] 跨月销货订单：上月下单本月出货');
  await db(() => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); // 上月1号
    const lastMonth = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-15';
    DB.insert('sales_orders', {
      id: 'so_cross', no: 'SO20260715001', channel: '一般销货', platform_no: '',
      customer_id: 'cu2', payment_status: 'unpaid', payment_method: '月结30天',
      currency: 'CNY', order_date: lastMonth, delivery_date: '', status: 'shipped',
      logistics_method: '圆通速递', sales_owner: '系统管理员', shipment_no: '',
      recipient_name: '', recipient_phone: '', shipping_address: '',
      invoice_type: '不开发票', price_tax_mode: '含税', tax_type: '不计税', tax_rate: 0,
      shipping_fee: 0, commission_rate: 0, platform_fee: 0, payment_fee: 0, other_fee: 0,
      settlement_tax_included: false, taxable_amount: 1200, tax_amount: 0, invoice_amount: 1200, net_receipt: 1200,
      invoice_title: '', invoice_tax_id: '', invoice_no: '', invoice_date: '', invoice_status: '未开',
      lines: [{ item_id: 'it_ty', code: 'TY0001', name: '越南咖啡1箱12袋', qty: 5, unit: '箱', unit_price: 240, amount: 1200, remark: '' }],
      remark: '', created_by: '系统管理员', created_at: lastMonth + ' 09:00:00'
    });
    DB.addStock('wh1', 'it_ty', -60); // 5箱*12 = 60袋
    DB.insert('shipments', {
      id: 'sh_cross', no: 'SH20260815001', sales_order_id: 'so_cross', order_no: 'SO20260715001',
      warehouse_id: 'wh1', ship_date: '2026-08-15', logistics_method: '圆通速递', shipment_no: '',
      recipient_name: '义乌联华超市', recipient_phone: '', shipping_address: '',
      lines: [{ item_id: 'it_ty', code: 'TY0001', name: '越南咖啡1箱12袋', qty: 5, unit: '箱', unit_price: 240, amount: 1200, remark: '' }],
      remark: '', created_by: '系统管理员', created_at: '2026-08-15 10:00:00'
    });
    return true;
  });
  // 损益口径已移至「损益报表」页（报表查询 → 损益报表）验证；仪表板「本月经营摘要」已移除
  await gotoHash('#/dashboard');
  const dashTxt = await page.evaluate(() => document.body.textContent);
  check(!dashTxt.includes('本月经营摘要') && !dashTxt.includes('本月毛利'), '仪表板已无经营摘要/本月毛利（口径移至损益报表页）');
  await gotoHash('#/report/profit');
  const profitTxt = await page.evaluate(() => document.body.textContent);
  check(profitTxt.includes('损益报表') && profitTxt.includes('近 30 天'), '损益报表页正常渲染（按出货日期归属的数值口径由 test-profit-report 覆盖）');

  // ===== 6. 应收账款 =====
  console.log('\n[5] 应收账款');
  await gotoHash('#/accounting/accounts-receivable');
  const arHtml = await page.evaluate(() => document.body.innerHTML);
  const m3 = arHtml.match(/未收应收（本位币）<\/span><strong[^>]*>([\d,.-]+)<\/strong>/);
  console.log('  未收应收:', m3 ? m3[1] : '?');
  check(m3 && parseFloat(m3[1].replace(/,/g, '')) === 1200, `应收账款未收 ${m3 ? m3[1] : '?'}（期望 1,200.00）`);

  // 登记收款 800 → 未收应变为 400
  await page.locator('button:has-text("登记收款")').first().click();
  await page.waitForTimeout(300);
  await page.locator('#payAmount').fill('800');
  await page.waitForTimeout(200);
  const payRemain = await page.locator('#payRemain').inputValue();
  check(payRemain === '400.00', `收款弹窗余额联动 ${payRemain}（期望 400.00）`);
  await page.locator('.modal-mask .modal-foot .btn.primary').click();
  await page.waitForTimeout(900);
  const arHtml2 = await page.evaluate(() => document.body.innerHTML);
  const m4 = arHtml2.match(/未收应收（本位币）<\/span><strong[^>]*>([\d,.-]+)<\/strong>/);
  console.log('  收款800后未收应收:', m4 ? m4[1] : '?');
  check(m4 && parseFloat(m4[1].replace(/,/g, '')) === 400, `收款后未收应收 ${m4 ? m4[1] : '?'}（期望 400.00）`);
  // 订单收款状态联动：部分收款
  const soCross = await db(() => { const o = DB.get('sales_orders', 'so_cross'); return { status: o.payment_status, received: o.received_amount }; });
  check(soCross.status === 'partial', `订单收款状态联动 partial（实际 ${soCross.status}）`);

  // ===== 7. 出货单操作列按钮 =====
  console.log('\n[6] 出货单操作列');
  await gotoHash('#/shipments');
  const shRow = await page.evaluate(() => {
    const rows = document.querySelectorAll('#app .table tbody tr');
    for (const r of rows) if (r.textContent.includes('SH2026')) return r.textContent;
    return '';
  });
  console.log('  出货单行:', shRow.replace(/\s+/g, ' ').slice(0, 240));
  check(/删除/.test(shRow), '出货单操作列有删除按钮');
  check(/库存异动/.test(await page.textContent('#app .table thead')), '出货单列表有库存异动列');
  const headText = await page.textContent('#app .page-head');
  check(/新增出货单/.test(headText), '出货单页有新增按钮');

  // 出货单详情：库存异动应乘换算率 = 5箱×12 = 60
  await gotoHash('#/shipments/sh_cross');
  const shDetText = await page.textContent('body');
  const mv = shDetText.match(/库存异动\s*(-?\d+)/);
  check(mv && mv[1] === '-60', `出货单详情库存异动 ${mv ? mv[1] : '?'}（期望 -60，乘换算率）`);

  // ===== 8. 删除出货单：回冲库存 + 订单恢复未出货 =====
  console.log('\n[7] 删除出货单流程');
  await gotoHash('#/shipments');
  await page.locator('tr:has-text("SH20260815001") button:has-text("删除")').click();
  await page.waitForTimeout(300);
  await page.locator('.modal-mask .modal-foot #confirmOkBtn, .modal-mask .modal-foot .btn.danger').first().click();
  await page.waitForTimeout(800);
  const afterDel = await db(() => ({
    shCount: DB.list('shipments').length,
    soStatus: DB.get('sales_orders', 'so_cross').status,
    stock: DB.totalStock('it_ty')
  }));
  console.log('  删除后:', JSON.stringify(afterDel));
  check(afterDel.shCount === 0, '出货单已删除');
  check(afterDel.soStatus === 'draft', '订单恢复未出货状态');
  check(afterDel.stock === 60 + 60, `库存回冲 +60 = ${afterDel.stock}（期望 120）`);

  // ===== 9. 新增出货单流程 =====
  console.log('\n[8] 新增出货单流程');
  await gotoHash('#/shipments');
  await page.locator('button:has-text("新增出货单")').click();
  await page.waitForTimeout(300);
  await page.locator('#shipOrderSel').selectOption('so_cross');
  await page.locator('.modal-mask .modal-foot .btn.primary').click();
  await page.waitForTimeout(300);
  await page.locator('#shipWh').selectOption('wh1');
  await page.locator('button:has-text("确认出货")').click();
  await page.waitForTimeout(800);
  const afterShip2 = await db(() => ({
    shCount: DB.list('shipments').length,
    soStatus: DB.get('sales_orders', 'so_cross').status,
    stock: DB.totalStock('it_ty')
  }));
  console.log('  新增出货后:', JSON.stringify(afterShip2));
  check(afterShip2.shCount === 1, '新出货单已建立');
  check(afterShip2.soStatus === 'shipped', '订单恢复已出货');
  check(afterShip2.stock === 120 - 60, `库存再扣 60 = ${afterShip2.stock}（期望 60）`);

  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  if (errors.length) { console.log('页面错误:', errors.slice(0, 8)); }
  if (fail) console.log('失败项:', failures);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
