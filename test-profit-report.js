// 损益报表（每日/每月图表）自动化测试
// 覆盖：报表查询→损益报表 菜单/路由/权限迁移、每日与每月视图、
//       SVG 图表渲染、营收/销货成本/毛利口径（与仪表板一致：
//       收入按出货日期归属、COGS×销售→库存换算率×商品成本折本位币、销退冲减）、
//       外币折本位币、负毛利显示、无权限拒绝
// 运行前提：本地服务器 http://127.0.0.1:8904（cd erp-clone && node serve.js 8904 .）
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8904';
let pass = 0, fail = 0, failures = [];
const errors = [];

function check(cond, msg) {
  if (cond) { pass++; console.log('  PASS:', msg); }
  else { fail++; failures.push(msg); console.error('  FAIL:', msg); }
}
const near = (a, b, eps) => Math.abs(UtilsNum(a) - b) < (eps === undefined ? 0.01 : eps);
function UtilsNum(v) { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; }

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
    await page.evaluate(h => { location.hash = h; }, hash);
    await page.waitForTimeout(700);
  }
  const db = (fn, arg) => page.evaluate(({ src, a }) => { const f = eval('(' + src + ')'); return f(a); }, { src: fn.toString(), a: arg });
  async function bodyText() { return await page.textContent('body'); }
  async function toastText() {
    const t = await page.locator('.toast').allTextContents().catch(() => []);
    return t.join(' | ');
  }

  // ========== 1. 登录 ==========
  console.log('\n[1] 登录管理员');
  await login('admin', 'admin123');
  check((await bodyText()).includes('仪表板'), '管理员登录成功');

  // ========== 2. 菜单含损益报表 ==========
  console.log('\n[2] 报表查询菜单');
  const menu = await page.evaluate(() => Array.from(document.querySelectorAll('.sidebar a')).map(a => ({ t: a.textContent.trim(), href: a.getAttribute('href') })));
  const profitMenuItem = menu.find(m => m.href === '#/report/profit');
  check(!!profitMenuItem && profitMenuItem.t.includes('损益报表'), '侧边栏菜单含「损益报表」(#/report/profit)');
  const groups = await page.evaluate(() => Array.from(document.querySelectorAll('.menu-main span')).map(s => s.textContent.trim()));
  check(groups.includes('报表查询'), '菜单组「报表查询」存在');

  // ========== 3. 注入跨月测试数据（动态日期，相对今天） ==========
  console.log('\n[3] 注入测试数据（本月出货+销退 / 上月出货外币单）');
  const ids = await db(() => {
    // 清理旧测试数据（幂等）
    ['items', 'sales_orders', 'shipments', 'sales_returns', 'customers'].forEach(c => {
      DB.list(c).filter(r => (r.code || r.no || '').indexOf('PFT') >= 0 || (r.username || '').indexOf('noprof') >= 0).forEach(r => DB.remove(c, r.id));
    });
    // 币别：CNY 本位币、USD 汇率 7.2
    const cny = DB.list('currencies').find(c => c.code === 'CNY');
    if (cny) DB.update('currencies', cny.id, { is_base: true, rate: 1 });
    const usd = DB.list('currencies').find(c => c.code === 'USD');
    if (usd) DB.update('currencies', usd.id, { rate: 7.2 });

    const today = Utils.today();
    const lm = new Date(); lm.setDate(15); lm.setMonth(lm.getMonth() - 1);
    const lastMonth15 = lm.getFullYear() + '-' + String(lm.getMonth() + 1).padStart(2, '0') + '-15';

    // 商品：it1 成本 100 CNY、换算 1；it2 成本 20 USD、换算 2
    const it1 = DB.insert('items', { code: 'IT-PFT1', name: '损益测试商品一', spec: '', cost: 100, purchase_currency: 'CNY', sales_to_stock: 1, stock_unit: '个', safety_stock: 0, category_id: '', disabled: false });
    const it2 = DB.insert('items', { code: 'IT-PFT2', name: '损益测试商品二', spec: '', cost: 20, purchase_currency: 'USD', sales_to_stock: 2, stock_unit: '盒', safety_stock: 0, category_id: '', disabled: false });
    const cu = DB.insert('customers', { code: 'CU-PFT1', name: '损益测试客户', currency: 'CNY', payment_method: '', payment_days: 0, disabled: false });

    // 本月：SOA 10 个 ×120 CNY 已出货（今天）
    const soA = DB.insert('sales_orders', {
      no: 'SO-PFT-A', order_date: today, customer_id: cu.id, channel: '', currency: 'CNY',
      untaxed_amount: 1200, tax_amount: 0, invoice_amount: 1200, status: 'shipped',
      lines: [{ item_id: it1.id, code: it1.code, name: it1.name, qty: 10, price: 120, amount: 1200 }],
      received_amount: 0, remark: ''
    });
    DB.insert('shipments', { no: 'SH-PFT-A', sales_order_id: soA.id, order_no: soA.no, warehouse_id: 'wh1', ship_date: today, logistics_method: '', shipment_no: '', lines: soA.lines, created_by: 'admin' });
    // 销退：今天退 2 个（金额 240、成本冲回 200，冲减应收）
    DB.insert('sales_returns', {
      no: 'SR-PFT-A', sales_order_id: soA.id, order_no: soA.no, customer_id: cu.id, type: '退回',
      return_date: today, warehouse_id: 'wh1', total_amount: 240, offset_receivable: true,
      cost_reversal: 200, lines: [{ item_id: it1.id, code: it1.code, qty: 2, price: 120, amount: 240 }], remark: ''
    });

    // 上月：SOB 5 盒 ×30 USD 已出货（上月15日）→ 营收 150×7.2=1080，成本 5×2×144=1440 → 毛利 -360
    const soB = DB.insert('sales_orders', {
      no: 'SO-PFT-B', order_date: lastMonth15, customer_id: cu.id, channel: '', currency: 'USD',
      untaxed_amount: 150, tax_amount: 0, invoice_amount: 150, status: 'shipped',
      lines: [{ item_id: it2.id, code: it2.code, name: it2.name, qty: 5, price: 30, amount: 150 }],
      received_amount: 0, remark: ''
    });
    DB.insert('shipments', { no: 'SH-PFT-B', sales_order_id: soB.id, order_no: soB.no, warehouse_id: 'wh1', ship_date: lastMonth15, logistics_method: '', shipment_no: '', lines: soB.lines, created_by: 'admin' });
    return { it1: it1.id, it2: it2.id, soA: soA.id, soB: soB.id, today, lastMonth15 };
  });
  check(!!ids.soA && !!ids.soB, '跨月测试数据注入完成');

  // ========== 4. DB 层口径（每日视图，近 7 天） ==========
  console.log('\n[4] 每日视图口径（近 7 天，只有今天有数据）');
  const day7 = await db(() => {
    const b = profitSeries('day', '7');
    const t = b.find(x => x.key === Utils.today());
    return { today: t, sumProfit: Utils.round(b.reduce((s, x) => s + x.profit, 0)), sumRev: Utils.round(b.reduce((s, x) => s + x.netRevenue, 0)), n: b.length };
  });
  check(day7.n === 7, '近 7 天生成 7 个桶');
  check(near(day7.today.netRevenue, 960), `今日净营收 960（1200-240 销退冲减，实际 ${day7.today.netRevenue}）`);
  check(near(day7.today.cogs, 1000), `今日销货成本 1000（10×1×100，实际 ${day7.today.cogs}）`);
  check(near(day7.today.retCost, 200), `今日销退成本冲回 200（实际 ${day7.today.retCost}）`);
  check(near(day7.today.profit, 160), `今日毛利 160（960-800，实际 ${day7.today.profit}）`);
  check(near(day7.sumProfit, 160), `近 7 天合计毛利 160（上月单不在范围，实际 ${day7.sumProfit}）`);

  // ========== 5. DB 层口径（每月视图，近 3 个月） ==========
  console.log('\n[5] 每月视图口径（近 3 个月）');
  const m3 = await db((ids) => {
    const b = profitSeries('month', '3');
    const cur = b.find(x => x.key === Utils.today().slice(0, 7));
    const prev = b.find(x => x.key === ids.lastMonth15.slice(0, 7));
    return { cur, prev, sumProfit: Utils.round(b.reduce((s, x) => s + x.profit, 0)), sumRev: Utils.round(b.reduce((s, x) => s + x.netRevenue, 0)), n: b.length };
  }, ids);
  check(m3.n === 3, '近 3 个月生成 3 个桶');
  check(near(m3.cur.profit, 160), `本月毛利 160（实际 ${m3.cur.profit}）`);
  check(near(m3.prev.netRevenue, 1080), `上月净营收 1080（USD 150×7.2 折本位币，实际 ${m3.prev.netRevenue}）`);
  check(near(m3.prev.cogs, 1440), `上月销货成本 1440（5×2 换算×144 本位币成本，实际 ${m3.prev.cogs}）`);
  check(near(m3.prev.profit, -360), `上月毛利 -360（负毛利，实际 ${m3.prev.profit}）`);
  check(near(m3.sumProfit, -200), `近 3 个月合计毛利 -200（160-360，实际 ${m3.sumProfit}）`);
  check(near(m3.sumRev, 2040), `近 3 个月合计净营收 2040（960+1080，实际 ${m3.sumRev}）`);

  // ========== 6. 页面渲染（路由 / 图表 / 图例） ==========
  console.log('\n[6] 损益报表页面渲染');
  await gotoHash('#/report/profit');
  const title = await page.locator('h1').textContent().catch(() => '');
  check(title.includes('损益报表'), '路由 #/report/profit 打开损益报表页');
  check((await bodyText()).includes('报表查询 / 损益报表'), '面包屑显示 报表查询 / 损益报表');
  const svg = await page.locator('svg.profit-chart').count();
  check(svg === 1, 'SVG 损益图表渲染');
  const legend = await page.locator('.chart-legend span').count();
  check(legend === 4, '图例 4 项（净营收/成本/毛利/亏损）');
  const rectDef = await page.locator('svg.profit-chart rect').count();
  check(rectDef === 30 * 3, `默认近 30 天 → 柱体 ${rectDef} 根（30×3）`);
  const kpiHtml = await page.evaluate(() => document.querySelector('#app').innerHTML);

  // ========== 7. 每日视图 UI（切近 7 天） ==========
  console.log('\n[7] 每日视图交互');
  await page.evaluate(() => Pages.setProfitRange('7'));
  await page.waitForTimeout(500);
  const rect7 = await page.locator('svg.profit-chart rect').count();
  check(rect7 === 21, `近 7 天柱体 21 根（实际 ${rect7}）`);
  const kpi = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.kpi-card'));
    const g = c => { const s = c.querySelector('strong'); return s ? s.textContent.trim() : ''; };
    return { rev: g(cards[0]), cogs: g(cards[1]), profit: g(cards[2]), margin: g(cards[3]) };
  });
  check(kpi.rev === '960.00', `KPI 区间净营收 960.00（实际 ${kpi.rev}）`);
  check(kpi.cogs === '800.00', `KPI 销货成本 800.00（实际 ${kpi.cogs}）`);
  check(kpi.profit === '160.00', `KPI 区间毛利 160.00（实际 ${kpi.profit}）`);
  check(kpi.margin === '16.7%', `KPI 毛利率 16.7%（实际 ${kpi.margin}）`);
  const dayRow = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const last = rows[rows.length - 1];   // 合计行
    const today = Utils.today().slice(5);
    const hit = rows.find(r => (r.querySelector('td b') || {}).textContent === today);
    return {
      total: Array.from(last.querySelectorAll('td.line-amount')).map(td => td.getAttribute('data-v')),
      todayRow: hit ? Array.from(hit.querySelectorAll('td.line-amount')).map(td => td.getAttribute('data-v')) : null
    };
  });
  check(!!dayRow.todayRow, '明细表含今天行（MM-DD 标签）');
  check(near(dayRow.todayRow[0], 960) && near(dayRow.todayRow[2], 160), `今天行净营收 960 / 毛利 160（实际 ${dayRow.todayRow.join(',')}）`);
  check(near(dayRow.total[0], 960) && near(dayRow.total[2], 160), `合计行 960 / 160（实际 ${dayRow.total.join(',')}）`);

  // ========== 8. 每月视图 UI ==========
  console.log('\n[8] 每月视图交互');
  await page.evaluate(() => Pages.setProfitMode('month'));
  await page.waitForTimeout(500);
  const monthHead = await page.evaluate(() => {
    const th = Array.from(document.querySelectorAll('table thead th')).map(t => t.textContent.trim());
    const sel = document.querySelector('.toolbar select');
    const opts = Array.from(sel.options).map(o => o.textContent.trim());
    return { th, opts, selVal: sel.value };
  });
  check(monthHead.th[0] === '月份', `每月视图表头首列为「月份」（实际 ${monthHead.th[0]}）`);
  check(monthHead.selVal === '12' && monthHead.opts.includes('近 3 个月'), `每月视图范围选项为月（当前 ${monthHead.selVal}）`);
  await page.evaluate(() => Pages.setProfitRange('3'));
  await page.waitForTimeout(500);
  const rectM3 = await page.locator('svg.profit-chart rect').count();
  check(rectM3 === 9, `近 3 个月柱体 9 根（实际 ${rectM3}）`);
  const kpiM = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.kpi-card'));
    const g = c => { const s = c.querySelector('strong'); return s ? s.textContent.trim() : ''; };
    return { rev: g(cards[0]), profit: g(cards[2]), profitColor: cards[2].querySelector('strong').style.color };
  });
  check(kpiM.rev === '2,040.00', `月视图 KPI 净营收 2,040.00（实际 ${kpiM.rev}）`);
  check(kpiM.profit === '-200.00', `月视图 KPI 毛利 -200.00（实际 ${kpiM.profit}）`);
  check(kpiM.profitColor.includes('--danger') || kpiM.profitColor === 'var(--danger)', '负毛利以红色（--danger）显示');
  const mRow = await page.evaluate((ids) => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const last = rows[rows.length - 1];
    const curKey = Utils.today().slice(0, 7), prevKey = ids.lastMonth15.slice(0, 7);
    const cur = rows.find(r => (r.querySelector('td b') || {}).textContent === curKey);
    const prev = rows.find(r => (r.querySelector('td b') || {}).textContent === prevKey);
    const vals = r => r ? Array.from(r.querySelectorAll('td.line-amount')).map(td => td.getAttribute('data-v')) : null;
    return { cur: vals(cur), prev: vals(prev), total: vals(last) };
  }, ids);
  check(!!mRow.cur && !!mRow.prev, '明细表含本月行与上月行');
  check(near(mRow.cur[0], 960) && near(mRow.cur[1], 800) && near(mRow.cur[2], 160), `本月行 960/800/160（实际 ${mRow.cur.join(',')}）`);
  check(near(mRow.prev[0], 1080) && near(mRow.prev[1], 1440) && near(mRow.prev[2], -360), `上月行 1080/1440/-360（实际 ${mRow.prev.join(',')}）`);
  check(near(mRow.total[2], -200), `月视图合计毛利 -200（实际 ${mRow.total[2]}）`);

  // ========== 9. 仪表板入口链接 ==========
  console.log('\n[9] 仪表板入口');
  await gotoHash('#/dashboard');
  const dash = await page.evaluate(() => document.querySelector('#app').innerHTML);
  check(dash.includes('href="#/report/profit"'), '仪表板「本月经营摘要」含查看损益报表入口');

  // ========== 10. 权限迁移（旧数据平滑升级） ==========
  console.log('\n[10] 权限迁移');
  const removed = await db(() => {
    DB.list('roles').forEach(r => {
      r.permissions = (r.permissions || []).filter(p => p !== 'report.profit');
      DB.update('roles', r.id, { permissions: r.permissions });
    });
    return DB.list('roles').every(r => !r.permissions.includes('report.profit'));
  });
  check(removed, '已从所有角色移除 report.profit（模拟旧数据）');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const restored = await db(() => DB.list('roles').every(r => (r.permissions || []).includes('report.profit')));
  check(restored, 'reload 后 migrateProfitReport 幂等补回所有角色权限');
  const menuAfter = await page.evaluate(() => Array.from(document.querySelectorAll('.sidebar a')).map(a => a.getAttribute('href')));
  check(menuAfter.includes('#/report/profit'), '迁移后菜单重新出现损益报表');

  // ========== 11. 无权限拒绝 ==========
  console.log('\n[11] 无权限角色拒绝');
  const noPermUid = await db(() => {
    const r = DB.insert('roles', { id: 'r_noprof', name: '无损益权限', description: '', permissions: ['dashboard.view'], created_at: new Date().toISOString() });
    return DB.insert('users', { id: 'u_noprof', username: 'noprof', password: '123456', name: '无损益', role_id: r.id, status: '启用' }).id;
  });
  check(!!noPermUid, '创建无 report.profit 权限的用户');
  await page.evaluate(() => DB.clearSession());   // 登出 admin（切用户）
  await login('noprof', '123456');
  const menuNo = await page.evaluate(() => Array.from(document.querySelectorAll('.sidebar a')).map(a => a.getAttribute('href')));
  check(!menuNo.includes('#/report/profit'), '无权限用户菜单不含损益报表');
  await gotoHash('#/report/profit');
  const deniedToast = await toastText();
  check(deniedToast.includes('没有访问该页面的权限'), `无权限访问被拒（toast：${deniedToast.slice(0, 40)}）`);
  check((await bodyText()).includes('仪表板'), '被拒后回到仪表板');

  // ========== 12. 清理测试角色/用户 ==========
  await db(() => {
    DB.remove('roles', 'r_noprof');
    DB.remove('users', 'u_noprof');
  });

  // ========== 汇总 ==========
  console.log('\n==================================');
  console.log(`== 损益报表测试: ${pass} 通过, ${fail} 失败 ==`);
  if (failures.length) { console.error('失败项:', failures.join(' | ')); }
  if (errors.length) { console.error('页面错误:', errors.slice(0, 5).join(' | ')); }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
