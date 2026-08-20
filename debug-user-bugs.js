// 验证用户报告的两个 bug 场景
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8902';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let pass = 0, fail = 0;
  const check = (c, m) => { if (c) { pass++; console.log('  PASS:', m); } else { fail++; console.log('  FAIL:', m); } };

  // 登录
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const inputs = page.locator('#loginForm input');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const ph = await inputs.nth(i).getAttribute('placeholder') || '';
    if (/账号|用户/i.test(ph)) await inputs.nth(i).fill('admin');
    if (/密码/i.test(ph)) await inputs.nth(i).fill('admin123');
  }
  await page.locator('#loginForm button[type=submit]').click();
  await page.waitForTimeout(1000);

  // 业务数据初始为空，注入最小测试数据集（商品+未出货订单+已出货订单+出货单）
  const db = (fn, arg) => page.evaluate(({ src, a }) => { const f = eval('(' + src + ')'); return f(a); }, { src: fn.toString(), a: arg });
  await db(() => {
    const it = DB.insert('items', { id: 'it_test', code: 'TEST0001', name: '测试商品', english_name: 'Test Item', spec: '', brand: '测试', model: '', category_id: DB.list('categories')[0].id, product_type: '成品', sales_unit: '个', purchase_unit: '个', stock_unit: '个', sales_to_stock: 1, purchase_to_stock: 1, cost: 10, price: 25, min_price: 20, purchase_currency: 'CNY', safety_stock: 5, max_stock: 100, weight: 0, volume: 0, remark: '测试' });
    DB.addStock('wh1', it.id, 100);
    // 未出货订单（可编辑保存，用于场景1）
    DB.insert('sales_orders', {
      id: 'so_seed1', no: 'SO20260101001', channel: '一般销货', platform_no: '', customer_id: DB.list('customers')[0].id,
      payment_status: 'unpaid', payment_method: '现款现货', currency: 'CNY', order_date: '2026-01-01', delivery_date: '2026-01-04',
      status: 'draft', logistics_method: '圆通速递', sales_owner: '业务人员', shipment_no: '',
      recipient_name: '测试客户', recipient_phone: '13800000000', shipping_address: '测试地址',
      invoice_type: '不开发票', price_tax_mode: '含税', tax_type: '不计税', tax_rate: 0,
      shipping_fee: 0, commission_rate: 0, platform_fee: 0, payment_fee: 0, other_fee: 0, settlement_tax_included: false,
      taxable_amount: 50, tax_amount: 0, invoice_amount: 50, net_receipt: 50,
      invoice_title: '', invoice_tax_id: '', invoice_no: '', invoice_date: '', invoice_status: '未开',
      lines: [{ item_id: it.id, code: it.code, name: it.name, qty: 2, unit: '个', unit_price: 25, amount: 50, remark: '' }],
      remark: '', created_by: '系统管理员'
    });
    // 已出货订单 + 出货单（用于场景2/4）
    const so2 = DB.insert('sales_orders', {
      id: 'so_seed2', no: 'SO20260102001', channel: '一般销货', platform_no: '', customer_id: DB.list('customers')[0].id,
      payment_status: 'unpaid', payment_method: '现款现货', currency: 'CNY', order_date: '2026-01-02', delivery_date: '2026-01-05',
      status: 'shipped', logistics_method: '圆通速递', sales_owner: '业务人员', shipment_no: 'TEST001',
      recipient_name: '测试客户', recipient_phone: '13800000000', shipping_address: '测试地址',
      invoice_type: '不开发票', price_tax_mode: '含税', tax_type: '不计税', tax_rate: 0,
      shipping_fee: 0, commission_rate: 0, platform_fee: 0, payment_fee: 0, other_fee: 0, settlement_tax_included: false,
      taxable_amount: 50, tax_amount: 0, invoice_amount: 50, net_receipt: 50,
      invoice_title: '', invoice_tax_id: '', invoice_no: '', invoice_date: '', invoice_status: '未开',
      lines: [{ item_id: it.id, code: it.code, name: it.name, qty: 2, unit: '个', unit_price: 25, amount: 50, remark: '' }],
      remark: '', created_by: '系统管理员'
    });
    DB.insert('shipments', {
      id: 'sh_seed1', no: 'SH20260102001', sales_order_id: so2.id, order_no: so2.no, warehouse_id: 'wh1',
      ship_date: '2026-01-02', logistics_method: '圆通速递', shipment_no: 'TEST001',
      recipient_name: '测试客户', recipient_phone: '13800000000', shipping_address: '测试地址',
      lines: so2.lines.map(l => Object.assign({}, l)), remark: '', created_by: '李仓管'
    });
    return true;
  });
  console.log('  已注入最小测试数据（商品+未出货订单+已出货订单+出货单）');

  // ===== 场景1：编辑销货订单不跳回主页 =====
  console.log('\n[场景1] 编辑销货订单');
  await page.evaluate(h => { location.hash = h; }, '#/sales-orders');
  await page.waitForTimeout(700);
  // 点击未出货订单（so_seed1）的编辑链接
  await page.locator('a[href="#/sales-orders/so_seed1/edit"]').first().click();
  await page.waitForTimeout(700);
  check((await page.textContent('body')).includes('销货订单｜编辑'), '点编辑进入编辑表单页（未跳回主页）');
  check((await page.textContent('body')).includes('保存销货订单'), '编辑页有保存按钮');

  // ===== 场景2：点击出货单号显示详情 =====
  console.log('\n[场景2] 出货单详情');
  await page.evaluate(h => { location.hash = h; }, '#/shipments');
  await page.waitForTimeout(700);
  const shLink = await page.locator('a[href^="#/shipments/"]').count();
  check(shLink > 0, `出货单号是可点击链接 (${shLink} 个)`);
  await page.locator('a[href^="#/shipments/"]').first().click();
  await page.waitForTimeout(700);
  const body = await page.textContent('body');
  check(body.includes('出货单｜SH'), '出货单详情页渲染');
  check(body.includes('收件人'), '详情含收件人资料');
  check(body.includes('出货金额'), '详情含金额统计');

  // ===== 场景3：直接访问编辑路由不跳回主页 =====
  console.log('\n[场景3] 编辑路由直达');
  const soId = await page.evaluate(() => DB.list('sales_orders')[0].id);
  await page.evaluate(id => { location.hash = '#/sales-orders/' + id + '/edit'; }, soId);
  await page.waitForTimeout(700);
  check((await page.textContent('body')).includes('销货订单｜编辑'), '直达 /sales-orders/<id>/edit 显示编辑页');

  // ===== 场景4：出货单详情路由直达 =====
  console.log('\n[场景4] 出货单详情直达');
  const shId = await page.evaluate(() => DB.list('shipments')[0].id);
  await page.evaluate(id => { location.hash = '#/shipments/' + id; }, shId);
  await page.waitForTimeout(700);
  check((await page.textContent('body')).includes('出货单｜SH'), '直达 /shipments/<id> 显示详情页');

  console.log(`\n== 用户场景验证: ${pass} 通过, ${fail} 失败 ==`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})();
