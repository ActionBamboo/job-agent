/* 启动引导页逻辑 */
const $ = (s) => document.querySelector(s);
const logEl = $('#log');

function pushLog(line) {
  const div = document.createElement('div');
  div.textContent = line;
  logEl.appendChild(div);
  while (logEl.children.length > 6) logEl.removeChild(logEl.firstChild);
}

function showError(message) {
  $('#bar').classList.add('hidden');
  $('#bar').style.display = 'none';
  $('#err').classList.add('show');
  $('#err-msg').textContent = message || '未知错误';
  $('#tip').style.display = 'none';
  $('#status').textContent = '启动失败';
}

const desktop = window.desktop;

if (desktop?.onBootStatus) {
  desktop.onBootStatus((s) => {
    if (!s) return;
    if (s.phase === 'error') {
      showError(s.message);
    } else if (s.message) {
      $('#status').textContent = s.message;
    }
  });
}

if (desktop?.onBackendLog) {
  desktop.onBackendLog((line) => {
    if (line) pushLog(line);
  });
}

$('#btn-retry').onclick = async () => {
  $('#err').classList.remove('show');
  $('#bar').style.display = '';
  $('#tip').style.display = '';
  $('#status').textContent = '正在重启本地服务…';
  logEl.innerHTML = '';
  await desktop?.retryBoot?.();
};

$('#btn-logs').onclick = () => desktop?.openLogs?.();
$('#btn-quit').onclick = () => desktop?.quit?.();

// 若主进程已在错误态（页面重载场景），主动拉一次状态
desktop?.getBootState?.().then((s) => {
  if (s?.phase === 'error') showError(s.message);
  else if (s?.message) $('#status').textContent = s.message;
});
