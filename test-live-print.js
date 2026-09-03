// 线上验证：销货订单查看页 + 大陆格式打印（销货订单/出货单）
const { chromium } = require('playwright');

(async () => {
  const URL = 'https://tycompnies.github.io/taiyuan-erp/';
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', err => errors.push(err.message));

  let pass = 0, fail = 0;
  const check = (cond, msg) => { if (cond) { pass++; console.log('  PASS:', msg); } else { fail++; console.error('  FAIL:', msg); } };

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(800);
  // 禁用自动同步（不读写生产云数据；测试数据本地自注入，云端业务数据清空后仍可稳定验证）
  await page.evaluate(() => {
    if (typeof CloudSync !== 'undefined') CloudSync.DEFAULT_SYNC_CFG = null;
    localStorage.removeItem('taiyuan_sync_cfg_v1');
  });
  const inputs = page.locator('input');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const ph = await inputs.nth(i).getAttribute('placeholder') || '';
    if (/用户|账号|帐号|username/i.test(ph)) await inputs.nth(i).fill('admin');
    if (/密码|password/i.test(ph)) await inputs.nth(i).fill('admin123');
  }
  await page.locator('button:has-text("登录")').first().click();
  await page.waitForTimeout(1500);

  // 自注入打印验证数据（客户/商品/已出货销货订单/出货单）
  await page.evaluate(() => {
    const today = Utils.today();
    DB.insert('customers', { id: 'cu_lp', code: 'CULP', name: '打印测试客户', phone: '13800000000', address: '广东省深圳市测试路1号', currency: 'CNY' });
    DB.insert('items', { id: 'it_lp', code: 'LP001', name: '打印测试商品', spec: '规格A', stock_unit: '个', sales_unit: '个', purchase_unit: '个', sales_to_stock: 1, purchase_to_stock: 1, cost: 30, purchase_currency: 'CNY', active: true });
    DB.insert('sales_orders', {
      id: 'so_lp', no: 'SO_LP_001', status: 'shipped', customer_id: 'cu_lp', channel: '线下', platform_no: '',
      order_date: today, delivery_date: today, sales_owner: 'admin', logistics_method: '圆通速递',
      shipping_fee: 0, platform_fee: 0, payment_fee: 0, other_fee: 0, taxable_amount: 100, tax_amount: 0,
      net_receipt: 100, invoice_amount: 100, payment_status: 'unpaid',
      lines: [{ item_id: 'it_lp', code: 'LP001', name: '打印测试商品', qty: 2, unit: '个', unit_price: 50, amount: 100 }]
    });
    DB.insert('shipments', {
      id: 'sh_lp', no: 'SH_LP_001', sales_order_id: 'so_lp', order_no: 'SO_LP_001', ship_date: today,
      warehouse_id: 'wh1', recipient_name: '打印测试客户', recipient_phone: '13800000000',
      shipping_address: '广东省深圳市测试路1号', logistics_method: '圆通速递', shipment_no: 'SF123456',
      created_by: 'admin',
      lines: [{ item_id: 'it_lp', code: 'LP001', name: '打印测试商品', qty: 2, unit: '个', unit_price: 50, amount: 100 }]
    });
  });

  // 展开日常作业菜单
  const g = page.locator('.menu-main').filter({ hasText: '日常作业' });
  if (await g.count()) {
    const open = await g.first().evaluate(el => el.parentElement.classList.contains('open'));
    if (!open) { await g.first().click(); await page.waitForTimeout(300); }
  }

  // 1) 销货订单列表：操作列有 查看/打印
  await page.locator('.menu-link').filter({ hasText: '销货订单' }).first().click();
  await page.waitForTimeout(1000);
  let body = await page.textContent('body');
  check(body.includes('查看') && body.includes('打印'), '线上销货订单列表有 查看/打印 按钮');

  // 2) 点击「查看」进入只读详情页（无表单、有金额大写）
  const viewBtn = page.locator('button:has-text("查看"), a:has-text("查看"), .btn:has-text("查看")').first();
  if (await viewBtn.count()) {
    await viewBtn.first().click();
    await page.waitForTimeout(1000);
    body = await page.textContent('body');
    check(!body.includes('保存订单') && body.includes('销货订单'), '线上查看页为只读详情页（无保存表单）');
    check(body.includes('金额大写') || /[壹贰叁肆伍陆柒捌玖拾佰仟万亿圆元整角分]/.test(body), '线上查看页显示金额大写');
  } else {
    check(false, '线上销货订单列表无查看按钮');
  }

  // 3) 打印销货订单（捕获新窗口内容）
  let printPage = null;
  page.once('popup', async p => { printPage = p; });
  const pBtn = page.locator('button:has-text("打印"), .btn:has-text("打印")').first();
  if (await pBtn.count()) {
    await pBtn.first().click();
    await page.waitForTimeout(2500);
    if (printPage) {
      let pbody = '';
      try { pbody = await printPage.textContent('body'); } catch (e) {}
      const compact = pbody.replace(/\s+/g, '');
      check(compact.includes('销货订单'), '线上打印窗口标题为销货订单');
      check(pbody.includes('钛沅商贸'), '线上打印窗口含公司抬头');
      check(/[壹贰叁肆伍陆柒捌玖拾佰仟万亿圆元整角分]/.test(pbody), '线上打印窗口含人民币金额大写');
    } else {
      check(false, '线上未弹出打印窗口');
    }
    try { await printPage.close(); } catch (e) {}
  } else {
    check(false, '线上查看页无打印按钮');
  }

  // 4) 出货单打印
  await page.goto(URL + '#/shipments', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  body = await page.textContent('body');
  check(body.includes('出货单') && body.includes('打印'), '线上出货单列表有 打印 按钮');
  const shBtn = page.locator('button:has-text("打印"), .btn:has-text("打印")').first();
  if (await shBtn.count()) {
    printPage = null;
    page.once('popup', async p => { printPage = p; });
    await shBtn.first().click();
    await page.waitForTimeout(2500);
    if (printPage) {
      let pbody = '';
      try { pbody = await printPage.textContent('body'); } catch (e) {}
      check(pbody.includes('送货单') || pbody.includes('出货单'), '线上出货单打印窗口标题正确');
      check(pbody.includes('收货单位') && pbody.includes('收货地址'), '线上出货单打印含收货单位/收货地址（大陆送货单格式）');
      check(pbody.includes('签收') || pbody.includes('签收日期'), '线上出货单打印含签收栏');
      check(/[壹贰叁肆伍陆柒捌玖拾佰仟万亿圆元整角分]/.test(pbody), '线上出货单打印含金额大写');
    } else {
      check(false, '线上未弹出出货单打印窗口');
    }
    try { await printPage.close(); } catch (e) {}
  } else {
    check(false, '线上出货单列表无打印按钮');
  }

  check(errors.length === 0, '线上全程无 JS 错误');

  console.log(`\n== 线上查看+打印验证: ${pass} 通过, ${fail} 失败 ==`);
  if (errors.length) console.log('JS 错误:', errors.join('\n'));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e.message); process.exit(1); });
