/* =========================================================
 * 出勤管理模块（WiFi 打卡出勤系统嵌入页）
 * 出勤系统为独立部署的自包含应用，官方网址统一由下方 ATTENDANCE_URL 指定：
 * - 一律内嵌官方线上最新版：出勤系统日后任何设定变更 / 版本更新，只要发布到该官方网址，
 *   ERP 内的「出勤管理」就会自动同步、连动为最新版本，不需再改 ERP 程序
 * - 自有登录/账号体系（管理员可在系统内新增员工）
 * - 自有 localStorage 数据（attendance_system_db 等键，与 ERP 数据完全隔离）
 * - 自有 GitHub 云端同步（TYcompnies/attendance 仓库 sync/ 目录，设置完全不变）
 * 本页仅负责在 ERP 框架内以 iframe 嵌入展示，不改动出勤系统任何逻辑。
 * 若网址日后更换，只需修改下方 ATTENDANCE_URL 一行。
 * ========================================================= */

const ATTENDANCE_URL = "https://tycompnies.github.io/attendance/";

Pages.attendancePage = function () {
    const html = `
    <div class="attendance-embed">
        <div class="attendance-toolbar">
            <div class="attendance-toolbar-info">
                <strong>智能出勤管理系统（WiFi 打卡）</strong>
            </div>
            <div class="attendance-toolbar-actions">
                <a class="btn" href="${ATTENDANCE_URL}" target="_blank" rel="noopener" title="在新窗口独立打开出勤系统">↗ 新窗口打开</a>
            </div>
        </div>
        <div class="attendance-frame-wrap">
            <iframe id="attendanceFrame" src="${ATTENDANCE_URL}" title="智能出勤管理系统"
                referrerpolicy="no-referrer-when-downgrade" allow="clipboard-write"></iframe>
        </div>
    </div>`;
    renderShell("attendance", html, "首页 / 出勤管理 / 智能出勤管理系统");
};
