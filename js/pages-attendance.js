/* =========================================================
 * 出勤管理模块（WiFi 打卡出勤系统嵌入页）
 * 出勤系统为完全独立的自包含应用（attendance/index.html，100% 原样复刻）：
 * - 自有登录/账号体系（默认 admin / admin123，管理员可在系统内新增员工）
 * - 自有 localStorage 数据（attendance_system_db 等键，与 ERP 数据完全隔离）
 * - 自有 GitHub 云端同步（TYcompnies/attendance 仓库 sync/ 目录，设置完全不变）
 * 本页仅负责在 ERP 框架内以 iframe 嵌入展示，不改动出勤系统任何逻辑。
 * ========================================================= */

Pages.attendancePage = function () {
    const html = `
    <div class="attendance-embed">
        <div class="attendance-toolbar">
            <div class="attendance-toolbar-info">
                <strong>智能出勤管理系统（WiFi 打卡）</strong>
                <span>使用出勤系统账号登录（默认 admin / admin123）· 数据与云端同步设置保持原样不变</span>
            </div>
            <div class="attendance-toolbar-actions">
                <a class="btn" href="attendance/index.html" target="_blank" title="在新窗口独立打开出勤系统">↗ 新窗口打开</a>
            </div>
        </div>
        <div class="attendance-frame-wrap">
            <iframe id="attendanceFrame" src="attendance/index.html" title="智能出勤管理系统"
                referrerpolicy="no-referrer-when-downgrade" allow="clipboard-write"></iframe>
        </div>
    </div>`;
    renderShell("attendance", html, "首页 / 出勤管理 / 智能出勤管理系统");
};
